import crypto from "node:crypto";
import { URL } from "node:url";
import { OrderSummary } from "../../models/order";
import { AmazonShippingConfig } from "../../config/env";
import {
  AmazonShippingService,
  GeneratedLabel,
  PackageSettingsProvider,
  PackageSpec,
  ShippingRateOption,
  ShippingRatesQuote
} from "./amazonShippingService";

interface LwaTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface AmazonApiError {
  code?: string;
  message?: string;
  details?: string;
}

interface AmazonRatesResponse {
  payload?: {
    requestToken: string;
    rates: Array<{
      rateId: string;
      carrierId: string;
      carrierName: string;
      serviceId: string;
      serviceName: string;
      requiresAdditionalInputs?: boolean;
      promise?: {
        deliveryWindow?: {
          start?: string;
          end?: string;
        };
      };
      totalCharge?: {
        unit?: string;
        value?: number;
      };
      availableValueAddedServiceGroups?: Array<{
        isRequired?: boolean;
        valueAddedServices?: Array<{
          id?: string;
        }>;
      }>;
      supportedDocumentSpecifications: Array<{
        format: string;
        size: {
          width: number;
          length: number;
          unit: string;
        };
        printOptions: Array<{
          supportedDPIs?: number[];
          supportedPageLayouts: string[];
          supportedFileJoiningOptions: boolean[];
        }>;
      }>;
    }>;
  };
  errors?: AmazonApiError[];
}

interface AmazonPurchaseResponse {
  payload?: {
    shipmentId: string;
    packageDocumentDetails: Array<{
      trackingId?: string;
      packageDocuments: Array<{
        type: string;
        format: string;
        contents?: string;
      }>;
    }>;
  };
  errors?: AmazonApiError[];
}

interface AmazonAdditionalInputsSchemaResponse {
  payload?: Record<string, unknown>;
  errors?: AmazonApiError[];
}

type AmazonRate = NonNullable<AmazonRatesResponse["payload"]>["rates"][number];

interface AccessTokenCache {
  token: string;
  expiresAtMs: number;
}

export class AmazonIntegrationError extends Error {
  constructor(
    message: string,
    public readonly details?: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "AmazonIntegrationError";
  }
}

export class AmazonLiveShippingService implements AmazonShippingService {
  private static readonly MAX_RETRIES = 3;
  private static readonly MAX_LOG_TEXT = 4000;
  private accessTokenCache: AccessTokenCache | null = null;

  constructor(
    private readonly config: AmazonShippingConfig,
    private readonly packageSettingsProvider?: PackageSettingsProvider
  ) {}

  async getRatesQuote(order: OrderSummary): Promise<ShippingRatesQuote> {
    const ratesResponse = await this.requestRates(order);
    const requestToken = ratesResponse.payload?.requestToken;
    if (!requestToken) {
      throw new AmazonIntegrationError("Amazon rates response missing requestToken.");
    }

    return {
      requestToken,
      rates: this.mapRates(order, ratesResponse)
    };
  }

  async getRates(order: OrderSummary): Promise<ShippingRateOption[]> {
    const ratesResponse = await this.requestRates(order);
    return this.mapRates(order, ratesResponse);
  }

  async purchaseShipment(
    order: OrderSummary,
    requestToken: string,
    selectedRateId: string,
    rates?: ShippingRateOption[]
  ): Promise<GeneratedLabel> {
    const ratesForSelection = rates ?? (await this.getRates(order));
    const selectedRateOption = ratesForSelection.find(
      (entry) => entry.rateId === selectedRateId
    );

    if (!selectedRateOption) {
      throw new AmazonIntegrationError(
        `Selected rate ${selectedRateId} is not available for this order.`
      );
    }

    let purchase = await this.purchaseShipmentRequest(
      requestToken,
      selectedRateOption,
      this.buildRequestedDocumentSpecification()
    );

    if (this.hasTokenExpiredError(purchase.errors)) {
      purchase = await this.purchaseShipmentRequest(
        requestToken,
        selectedRateOption,
        this.buildRequestedDocumentSpecification()
      );
    }

    if (purchase.errors && purchase.errors.length > 0) {
      const details = purchase.errors
        .map((entry) => `${entry.code ?? "UNKNOWN"}: ${entry.message ?? "No message"}`)
        .join(" | ");
      throw new AmazonIntegrationError("Amazon shipment purchase failed.", details);
    }

    const payload = purchase.payload;
    if (!payload) {
      throw new AmazonIntegrationError("Amazon purchase response payload is missing.");
    }

    const packageDetail = payload.packageDocumentDetails?.[0];
    const trackingNumber = packageDetail?.trackingId;
    if (!trackingNumber) {
      throw new AmazonIntegrationError(
        "Amazon purchase response missing trackingId.",
        JSON.stringify(purchase)
      );
    }

    const labelDoc = packageDetail.packageDocuments.find((doc) => doc.type === "LABEL");
    if (!labelDoc?.contents) {
      throw new AmazonIntegrationError(
        "Amazon purchase response missing LABEL contents.",
        JSON.stringify(purchase)
      );
    }

    return {
      shipmentId: payload.shipmentId,
      carrier:
        this.config.mode === "sandbox"
          ? `${selectedRateOption.carrierName} (Sandbox)`
          : selectedRateOption.carrierName,
      service: selectedRateOption.serviceName,
      rateId: selectedRateOption.rateId,
      requestToken,
      trackingNumber,
      labelDataUrl: this.toDataUrl(labelDoc.format, labelDoc.contents),
      labelFormat: labelDoc.format,
      labelContentType: this.toContentType(labelDoc.format),
      collectAmount: this.getCodAmount(order).toFixed(2)
    };
  }

  async generateLabel(
    order: OrderSummary,
    dryRun: boolean,
    selectedRateId?: string
  ): Promise<GeneratedLabel> {
    if (dryRun) {
      const legacyOrderId = order.id.split("/").pop() ?? order.id;
      const suffix = crypto.randomUUID().split("-")[0].toUpperCase();
      return {
        shipmentId: `dry-run-${suffix}`,
        carrier: "Amazon Shipping (Dry Run)",
        service: "Dry Run",
        rateId: selectedRateId ?? "dry-run",
        requestToken: `dry-run-${suffix}`,
        trackingNumber: `AMZDRY${legacyOrderId}${suffix}`,
        labelDataUrl: `data:application/pdf;base64,${Buffer.from("Dry run PDF label").toString("base64")}`,
        labelFormat: "PDF",
        labelContentType: "application/pdf",
        collectAmount: this.getCodAmount(order).toFixed(2)
      };
    }

    const quote = await this.getRatesQuote(order);
    const selectedRate = this.pickRate(quote.rates, selectedRateId);
    if (selectedRate.requiresAdditionalInputs) {
      const schema = await this.getAdditionalInputsSchema(
        quote.requestToken,
        selectedRate.rateId
      );
      throw new AmazonIntegrationError(
        "Selected Amazon rate requires additional inputs before shipment purchase.",
        JSON.stringify(schema)
      );
    }

    return this.purchaseShipment(order, quote.requestToken, selectedRate.rateId, quote.rates);
  }

  private async requestRates(order: OrderSummary): Promise<AmazonRatesResponse> {
    const endpointUrl = new URL(this.config.ratesPath, this.config.apiBaseUrl).toString();
    const payload = await this.buildRatesRequest(order);
    this.logApiRequest("rates", "POST", endpointUrl, payload);
    return this.signedRequest<AmazonRatesResponse>("POST", endpointUrl, payload);
  }

  private async purchaseShipmentRequest(
    requestToken: string,
    selectedRate: ShippingRateOption,
    requestedDocumentSpecification: Record<string, unknown>
  ): Promise<AmazonPurchaseResponse> {
    const endpointUrl = new URL(
      this.config.purchaseShipmentPath,
      this.config.apiBaseUrl
    ).toString();

    const payload: Record<string, unknown> = {
      requestToken,
      rateId: selectedRate.rateId,
      requestedDocumentSpecification,
      requestedValueAddedServices: selectedRate.valueAddedServices
    };

    this.logApiRequest("purchase", "POST", endpointUrl, payload);

    return this.signedRequest<AmazonPurchaseResponse>("POST", endpointUrl, payload, {
      allowHttpRetries: false
    });
  }

  private async getAdditionalInputsSchema(
    requestToken: string,
    rateId: string
  ): Promise<AmazonAdditionalInputsSchemaResponse> {
    const endpoint = new URL(
      "/shipping/v2/shipments/additionalInputs/schema",
      this.config.apiBaseUrl
    );
    endpoint.searchParams.set("requestToken", requestToken);
    endpoint.searchParams.set("rateId", rateId);

    this.logApiRequest("additional-inputs", "GET", endpoint.toString());

    return this.signedRequest<AmazonAdditionalInputsSchemaResponse>(
      "GET",
      endpoint.toString()
    );
  }

  private async buildRatesRequest(order: OrderSummary): Promise<Record<string, unknown>> {
    const packageSpec = await this.getPackageSpec(order.id);
    const shipTo = this.buildShipTo(order);
    const shipFromAddress = this.normalizeAddressLines(
      this.config.shipFromAddress1,
      this.config.shipFromAddress2
    );
    const shipFrom = {
      name: this.config.shipFromName,
      phoneNumber: this.config.shipFromPhone,
      addressLine1: shipFromAddress.addressLine1,
      addressLine2: shipFromAddress.addressLine2,
      addressLine3: shipFromAddress.addressLine3,
      city: this.config.shipFromCity,
      stateOrRegion: this.config.shipFromState,
      postalCode: this.config.shipFromPostalCode,
      countryCode: this.config.shipFromCountryCode,
      email: this.getOrderContactEmail(order)
    };
    const returnTo = {
      ...shipFrom
    };

    const orderReferenceId = order.id.split("/").pop() ?? order.id;
    const searchableOrderReference = order.name.replace(/^#/, "").trim() || orderReferenceId;
    const packageClientReferenceId = searchableOrderReference;
    const packageWeightGrams = this.getPackageWeightGrams(packageSpec.weightKg);
    const invoiceDate = this.toAmazonUtcDateTime(order.createdAt || new Date().toISOString());
    const itemWeights = this.allocateItemWeights(order, packageWeightGrams);

    const items = order.lineItems.map((lineItem, index) => ({
      itemIdentifier: `${packageClientReferenceId}-${index + 1}`,
      description: `${lineItem.quantity} x ${lineItem.title}`.slice(0, 120),
      quantity: lineItem.quantity,
      weight: {
        unit: "GRAM",
        value: itemWeights[index]
      },
      itemValue: {
        unit: lineItem.currencyCode,
        value: Number(lineItem.unitPrice)
      },
      isHazmat: false,
      productType: "Other",
      invoiceDetails: {
        invoiceNumber: `${order.name.replace(/[^a-zA-Z0-9]/g, "")}-${index + 1}`,
        invoiceDate
      }
    }));

    const codAmount = this.getCodAmount(order);
    const valueAddedServices = codAmount > 0
      ? {
          collectOnDelivery: {
            amount: {
              unit: order.currencyCode,
              value: codAmount
            }
          }
        }
      : undefined;

    const taxDetails = this.buildTaxDetails();

    return {
      shipFrom,
      shipTo,
      returnTo,
      shipDate: this.toAmazonUtcDateTime(new Date().toISOString()),
      channelDetails: {
        channelType: "EXTERNAL"
      },
      packages: [
        {
          packageClientReferenceId,
          dimensions: {
            length: packageSpec.lengthCm,
            width: packageSpec.widthCm,
            height: packageSpec.heightCm,
            unit: "CENTIMETER"
          },
          weight: {
            unit: "GRAM",
            value: packageWeightGrams
          },
          insuredValue: {
            unit: order.currencyCode,
            value: Number(order.totalPrice)
          },
          isHazmat: false,
          sellerDisplayName: this.config.shipFromName,
          items
        }
      ],
      valueAddedServices,
      taxDetails
    };
  }

  private allocateItemWeights(order: OrderSummary, packageWeightGrams: number): number[] {
    const totalQuantity = Math.max(
      1,
      order.lineItems.reduce((sum, lineItem) => sum + Math.max(1, lineItem.quantity), 0)
    );

    const basePerUnit = Math.max(1, Math.floor(packageWeightGrams / totalQuantity));
    const weights = order.lineItems.map(() => basePerUnit);

    const sumWeights = weights.reduce(
      (sum, value, index) => sum + value * Math.max(1, order.lineItems[index].quantity),
      0
    );
    if (sumWeights > packageWeightGrams && weights.length > 0) {
      const overflow = sumWeights - packageWeightGrams;
      const lastIndex = weights.length - 1;
      weights[lastIndex] = Math.max(1, weights[lastIndex] - overflow);
    }

    return weights;
  }

  private buildTaxDetails(): Array<Record<string, string>> | undefined {
    const gstId = this.config.shipperGstId?.trim();
    if (!gstId) {
      return undefined;
    }

    return [
      {
        taxType: "GST",
        taxRegistrationNumber: gstId
      }
    ];
  }

  private getCodAmount(order: OrderSummary): number {
    const outstanding = Number(order.amountToCollect);
    if (!order.paymentPending || !Number.isFinite(outstanding) || outstanding <= 0) {
      return 0;
    }

    const total = Number(order.totalPrice);
    if (!Number.isFinite(total) || outstanding > total) {
      throw new AmazonIntegrationError(
        "Collect-on-delivery amount cannot exceed the order total."
      );
    }

    return Number(outstanding.toFixed(2));
  }

  private async getPackageSpec(orderId: string): Promise<PackageSpec> {
    let packageSpec: PackageSpec | null = null;
    if (this.packageSettingsProvider) {
      try {
        const custom = await this.packageSettingsProvider.getDefaultPackageSpec(orderId);
        packageSpec = custom;
      } catch {
        // Fall back to env defaults if settings are unavailable.
      }
    }

    const resolved = packageSpec ?? {
      lengthCm: this.config.packageLengthCm,
      widthCm: this.config.packageWidthCm,
      heightCm: this.config.packageHeightCm,
      weightKg: Number(this.config.packageWeightKg)
    };
    const dimensions = [resolved.lengthCm, resolved.widthCm, resolved.heightCm];
    if (
      dimensions.some((value) => !Number.isFinite(value) || value < 1 || value > 300) ||
      !Number.isFinite(resolved.weightKg) ||
      resolved.weightKg < 0.1 ||
      resolved.weightKg > 70
    ) {
      throw new AmazonIntegrationError(
        "Package dimensions must be 1-300 cm and weight must be 0.1-70 kg."
      );
    }

    return resolved;
  }

  private pickRate(rates: Array<ShippingRateOption>, selectedRateId?: string) {
    if (rates.length === 0) {
      throw new AmazonIntegrationError("No eligible Amazon shipping rates returned.");
    }

    if (selectedRateId) {
      const selected = rates.find((rate) => rate.rateId === selectedRateId);
      if (!selected) {
        throw new AmazonIntegrationError(
          `Selected rate ${selectedRateId} is not available for this order.`
        );
      }

      return selected;
    }

    const sortedByBest = [...rates].sort((a, b) => {
      const aStart = this.toEpochMs(a.deliveryWindowStart);
      const bStart = this.toEpochMs(b.deliveryWindowStart);

      if (aStart !== bStart) {
        return aStart - bStart;
      }

      const aEnd = this.toEpochMs(a.deliveryWindowEnd);
      const bEnd = this.toEpochMs(b.deliveryWindowEnd);
      if (aEnd !== bEnd) {
        return aEnd - bEnd;
      }

      const aValue = a.amount;
      const bValue = b.amount;
      return aValue - bValue;
    });

    const selected = sortedByBest[0];
    const selectedStart = selected.deliveryWindowStart ?? "unknown";
    const selectedEnd = selected.deliveryWindowEnd ?? "unknown";
    console.log(
      `Selected Amazon rate ${selected.carrierName}/${selected.serviceName} | charge=${selected.amount} ${selected.currencyCode} | window=${selectedStart} to ${selectedEnd}`
    );

    return selected;
  }

  private buildRequestedDocumentSpecification(): Record<string, unknown> {
    // Use the known-good sandbox payload shape for purchaseShipment.
    return {
      format: "PDF",
      size: {
        width: 4,
        length: 6,
        unit: "INCH"
      },
      dpi: 300,
      pageLayout: "DEFAULT",
      needFileJoining: false,
      requestedDocumentTypes: ["LABEL"]
    };
  }

  private hasTokenExpiredError(errors?: AmazonApiError[]): boolean {
    if (!errors || errors.length === 0) {
      return false;
    }

    return errors.some((entry) => (entry.code ?? "").toUpperCase() === "TOKEN_EXPIRED");
  }

  private buildShipTo(order: OrderSummary) {
    if (!order.shippingAddress?.address1 || !order.shippingAddress.city || !order.shippingAddress.zip || !order.shippingAddress.country) {
      throw new AmazonIntegrationError(
        `Order ${order.name} is missing shipping address fields required by Amazon.`
      );
    }

    const address = this.normalizeAddressLines(
      order.shippingAddress.address1,
      order.shippingAddress.address2
    );

    return {
      name: order.shippingAddress.name ?? "Customer",
      phoneNumber: order.shippingAddress.phone ?? this.config.fallbackRecipientPhone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      addressLine3: address.addressLine3,
      city: order.shippingAddress.city,
      stateOrRegion: order.shippingAddress.province ?? "NA",
      postalCode: order.shippingAddress.zip,
      countryCode: this.mapCountryToIsoCode(order.shippingAddress.country),
      email: this.getOrderContactEmail(order)
    };
  }

  private normalizeAddressLines(
    line1: string | undefined,
    line2: string | undefined,
    maxLength = 60
  ): { addressLine1: string; addressLine2?: string; addressLine3?: string } {
    const compact = [line1 ?? "", line2 ?? ""]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const base = compact.length > 0 ? compact : "NA";
    const words = base.split(" ");
    const segments: string[] = [];
    let current = "";

    for (const word of words) {
      if (word.length > maxLength) {
        if (current.length > 0) {
          segments.push(current);
          current = "";
        }

        let cursor = 0;
        while (cursor < word.length) {
          segments.push(word.slice(cursor, cursor + maxLength));
          cursor += maxLength;
        }
        continue;
      }

      const next = current.length === 0 ? word : `${current} ${word}`;
      if (next.length <= maxLength) {
        current = next;
      } else {
        segments.push(current);
        current = word;
      }
    }

    if (current.length > 0) {
      segments.push(current);
    }

    const [addressLine1, addressLine2, addressLine3] = segments;
    return {
      addressLine1: addressLine1 ?? "NA",
      addressLine2,
      addressLine3
    };
  }

  private mapCountryToIsoCode(country: string): string {
    const normalized = country.trim().toLowerCase();
    if (normalized === "india") {
      return "IN";
    }

    if (normalized.length === 2) {
      return normalized.toUpperCase();
    }

    return this.config.defaultRecipientCountryCode;
  }

  private async signedRequest<TResponse>(
    method: string,
    url: string,
    payload?: Record<string, unknown>,
    options?: { allowHttpRetries?: boolean }
  ): Promise<TResponse> {
    let attempt = 0;
    let retryDelayMs = 400;
    let refreshedTokenOnce = false;

    for (;;) {
      try {
        const response = await this.executeSignedRequest<TResponse>(
          method,
          url,
          payload
        );
        return response;
      } catch (error) {
        attempt += 1;

        if (
          !refreshedTokenOnce &&
          error instanceof AmazonIntegrationError &&
          this.isInvalidAccessTokenError(error)
        ) {
          refreshedTokenOnce = true;
          this.accessTokenCache = null;
          continue;
        }

        const isRetriable =
          error instanceof AmazonIntegrationError &&
          this.isRetriableStatusError(error.message);

        if (options?.allowHttpRetries === false) {
          throw error;
        }

        if (!isRetriable || attempt >= AmazonLiveShippingService.MAX_RETRIES) {
          throw error;
        }

        await this.sleep(retryDelayMs);
        retryDelayMs *= 2;
      }
    }
  }

  private async executeSignedRequest<TResponse>(
    method: string,
    url: string,
    payload?: Record<string, unknown>
  ): Promise<TResponse> {
    if (this.config.mode === "sandbox") {
      return this.executeSandboxRequest<TResponse>(method, url, payload);
    }

    if (!this.hasSigV4Credentials()) {
      return this.executeTokenOnlyRequest<TResponse>(method, url, payload);
    }

    const hasBody = method.toUpperCase() !== "GET";
    const body = hasBody ? JSON.stringify(payload ?? {}) : "";
    const parsed = new URL(url);
    const amzDate = this.formatAmzDate(new Date());
    const dateStamp = amzDate.slice(0, 8);
    const accessToken = await this.getLwaAccessToken();

    const canonicalUri = parsed.pathname || "/";
    const canonicalQueryString = parsed.searchParams
      .toString()
      .split("&")
      .filter(Boolean)
      .sort()
      .join("&");

    const canonicalHeadersArray = [
      ["content-type", "application/json"],
      ["host", parsed.host],
      ["x-amz-access-token", accessToken],
      ["x-amz-date", amzDate],
      ["user-agent", this.config.userAgent]
    ] as Array<[string, string]>;

    if (this.config.awsSessionToken) {
      canonicalHeadersArray.push(["x-amz-security-token", this.config.awsSessionToken]);
    }

    if (this.config.shippingBusinessId) {
      canonicalHeadersArray.push([
        "x-amzn-shipping-business-id",
        this.config.shippingBusinessId
      ]);
    }

    canonicalHeadersArray.sort((a, b) => a[0].localeCompare(b[0]));

    const canonicalHeaders = canonicalHeadersArray
      .map(([key, value]) => `${key}:${value.trim()}\n`)
      .join("");

    const signedHeaders = canonicalHeadersArray.map(([key]) => key).join(";");

    const payloadHash = this.sha256Hex(body);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.config.awsRegion}/execute-api/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest)
    ].join("\n");

    const signingKey = this.getSignatureKey(
      this.config.awsSecretAccessKey,
      dateStamp,
      this.config.awsRegion,
      "execute-api"
    );

    const signature = crypto
      .createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");

    const authorizationHeader =
      `AWS4-HMAC-SHA256 Credential=${this.config.awsAccessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-amz-access-token": accessToken,
      "x-amz-date": amzDate,
      "user-agent": this.config.userAgent,
      authorization: authorizationHeader
    };

    if (this.config.awsSessionToken) {
      headers["x-amz-security-token"] = this.config.awsSessionToken;
    }

    if (this.config.shippingBusinessId) {
      headers["x-amzn-shipping-business-id"] = this.config.shippingBusinessId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: hasBody ? body : undefined
    });

    const text = await response.text();
    this.logApiResponse("sigv4", method, url, response.status, text);

    if (!response.ok) {
      throw new AmazonIntegrationError(
        `Amazon API request failed with ${response.status} ${response.statusText}.`,
        text,
        response.status
      );
    }

    return text ? (JSON.parse(text) as TResponse) : ({} as TResponse);
  }

  private hasSigV4Credentials(): boolean {
    return Boolean(this.config.awsAccessKeyId && this.config.awsSecretAccessKey);
  }

  private async executeTokenOnlyRequest<TResponse>(
    method: string,
    url: string,
    payload?: Record<string, unknown>
  ): Promise<TResponse> {
    const hasBody = method.toUpperCase() !== "GET";
    const body = hasBody ? JSON.stringify(payload ?? {}) : undefined;
    const accessToken = await this.getLwaAccessToken();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-amz-access-token": accessToken,
      "user-agent": this.config.userAgent
    };

    if (this.config.shippingBusinessId) {
      headers["x-amzn-shipping-business-id"] = this.config.shippingBusinessId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body
    });

    const text = await response.text();
    this.logApiResponse("token", method, url, response.status, text);
    if (!response.ok) {
      throw new AmazonIntegrationError(
        `Amazon API request failed with ${response.status} ${response.statusText}.`,
        text,
        response.status
      );
    }

    return text ? (JSON.parse(text) as TResponse) : ({} as TResponse);
  }

  private async executeSandboxRequest<TResponse>(
    method: string,
    url: string,
    payload?: Record<string, unknown>
  ): Promise<TResponse> {
    const hasBody = method.toUpperCase() !== "GET";
    const body = hasBody ? JSON.stringify(payload ?? {}) : undefined;
    const accessToken = await this.getLwaAccessToken();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-amz-access-token": accessToken,
      "user-agent": this.config.userAgent,
      "x-amzn-api-sandbox": "true"
    };

    if (this.config.shippingBusinessId) {
      headers["x-amzn-shipping-business-id"] = this.config.shippingBusinessId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body
    });

    const text = await response.text();
    this.logApiResponse("sandbox", method, url, response.status, text);

    if (!response.ok) {
      throw new AmazonIntegrationError(
        `Amazon API request failed with ${response.status} ${response.statusText}.`,
        text,
        response.status
      );
    }

    return text ? (JSON.parse(text) as TResponse) : ({} as TResponse);
  }

  private async getLwaAccessToken(): Promise<string> {
    if (this.accessTokenCache && Date.now() < this.accessTokenCache.expiresAtMs) {
      console.log("[amazon:lwa] using cached access token");
      return this.accessTokenCache.token;
    }

    console.log("[amazon:lwa] request POST https://api.amazon.com/auth/o2/token");
    const response = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.config.lwaRefreshToken,
        client_id: this.config.lwaClientId,
        client_secret: this.config.lwaClientSecret
      })
    });

    const text = await response.text();
    this.logLwaResponse(response.status, text);

    if (!response.ok) {
      throw new AmazonIntegrationError(
        `LWA token request failed with ${response.status} ${response.statusText}.`,
        text
      );
    }

    const payload = JSON.parse(text) as LwaTokenResponse;

    if (!payload.access_token) {
      throw new AmazonIntegrationError(
        "LWA token response missing access_token.",
        text
      );
    }

    const expiresIn = payload.expires_in || 300;
    this.accessTokenCache = {
      token: payload.access_token,
      expiresAtMs: Date.now() + Math.max(60, expiresIn - 60) * 1000
    };

    return payload.access_token;
  }

  private sha256Hex(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
  }

  private hmac(key: Buffer | string, value: string): Buffer {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest();
  }

  private getSignatureKey(
    secretAccessKey: string,
    dateStamp: string,
    regionName: string,
    serviceName: string
  ): Buffer {
    const kDate = this.hmac(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = this.hmac(kDate, regionName);
    const kService = this.hmac(kRegion, serviceName);
    return this.hmac(kService, "aws4_request");
  }

  private formatAmzDate(date: Date): string {
    const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return iso.slice(0, 15) + "Z";
  }

  private isRetriableStatusError(message: string): boolean {
    return (
      message.includes(" 429 ") ||
      message.includes(" 500 ") ||
      message.includes(" 503 ")
    );
  }

  private isInvalidAccessTokenError(error: AmazonIntegrationError): boolean {
    if (error.statusCode === 401) {
      return true;
    }

    const details = (error.details ?? "").toUpperCase();
    return (
      details.includes("INVALID_ACCESS_TOKEN") ||
      details.includes("ACCESS TOKEN") ||
      details.includes("TOKEN_EXPIRED")
    );
  }

  private logApiRequest(
    flow: "rates" | "purchase" | "additional-inputs",
    method: string,
    url: string,
    payload?: Record<string, unknown>
  ): void {
    const serializedPayload = payload ? this.safeJson(payload) : "{}";
    console.log(
      `[amazon:${this.config.mode}:${flow}] request ${method} ${url}\n` +
        `payload=${serializedPayload}`
    );
  }

  private logApiResponse(
    strategy: "sigv4" | "token" | "sandbox",
    method: string,
    url: string,
    status: number,
    rawText: string
  ): void {
    console.log(
      `[amazon:${this.config.mode}:${strategy}] response ${status} for ${method} ${url}\n` +
        `body=${this.clipLogText(rawText)}`
    );
  }

  private logLwaResponse(status: number, rawText: string): void {
    if (status >= 200 && status < 300) {
      try {
        const payload = JSON.parse(rawText) as Partial<LwaTokenResponse>;
        console.log(
          `[amazon:lwa] response ${status} accessTokenReceived=${Boolean(payload.access_token)} ` +
            `expiresInSeconds=${payload.expires_in ?? "unknown"}`
        );
        return;
      } catch {
        console.log(`[amazon:lwa] response ${status} body=<invalid-json>`);
        return;
      }
    }

    console.log(
      `[amazon:lwa] response ${status}\nbody=${this.clipLogText(rawText)}`
    );
  }

  private safeJson(value: unknown): string {
    try {
      return this.clipLogText(JSON.stringify(value));
    } catch {
      return "<unserializable>";
    }
  }

  private clipLogText(value: string): string {
    if (value.length <= AmazonLiveShippingService.MAX_LOG_TEXT) {
      return value;
    }

    return `${value.slice(0, AmazonLiveShippingService.MAX_LOG_TEXT)}...<trimmed>`;
  }

  private getPackageWeightGrams(weightKg: number): number {
    const kilograms = Number(weightKg);
    if (!Number.isFinite(kilograms) || kilograms <= 0) {
      return 500;
    }

    return Math.max(1, Math.round(kilograms * 1000));
  }

  private getRateChargeValue(rate: AmazonRate): number {
    const value = rate.totalCharge?.value;
    if (typeof value !== "number" || Number.isNaN(value)) {
      return Number.POSITIVE_INFINITY;
    }

    return value;
  }

  private toEpochMs(value: string | undefined): number {
    if (!value) {
      return Number.POSITIVE_INFINITY;
    }

    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return Number.POSITIVE_INFINITY;
    }

    return parsed;
  }

  private getOrderContactEmail(order: OrderSummary): string {
    const email = order.customer?.email?.trim();
    if (email) {
      return email;
    }

    return "no-reply@example.com";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private toDataUrl(format: string, base64Contents: string): string {
    const normalized = format.toUpperCase();
    if (normalized === "PDF") {
      return `data:application/pdf;base64,${base64Contents}`;
    }

    if (normalized === "PNG") {
      return `data:image/png;base64,${base64Contents}`;
    }

    return `data:application/octet-stream;base64,${base64Contents}`;
  }

  private toContentType(format: string): string {
    const normalized = format.toUpperCase();
    if (normalized === "PDF") {
      return "application/pdf";
    }

    if (normalized === "PNG") {
      return "image/png";
    }

    return "application/octet-stream";
  }

  private mapRates(
    order: OrderSummary,
    ratesResponse: AmazonRatesResponse
  ): ShippingRateOption[] {
    const rates = ratesResponse.payload?.rates ?? [];
    const mapped = rates.map((rate) => ({
      rateId: rate.rateId,
      carrierName: rate.carrierName,
      serviceName: rate.serviceName,
      serviceId: rate.serviceId,
      amount: this.getRateChargeValue(rate),
      currencyCode: rate.totalCharge?.unit ?? order.currencyCode,
      requiresAdditionalInputs: Boolean(rate.requiresAdditionalInputs),
      deliveryWindowStart: rate.promise?.deliveryWindow?.start,
      deliveryWindowEnd: rate.promise?.deliveryWindow?.end,
      valueAddedServices: this.mapRequiredValueAddedServices(rate)
    }));

    return mapped.sort((a, b) => a.amount - b.amount);
  }

  private mapRequiredValueAddedServices(rate: AmazonRate): Array<{ id: string }> | undefined {
    const ids = (rate.availableValueAddedServiceGroups ?? [])
      .filter((group) => group.isRequired)
      .flatMap((group) => group.valueAddedServices ?? [])
      .map((service) => service.id?.trim())
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) {
      return undefined;
    }

    return Array.from(new Set(ids)).map((id) => ({ id }));
  }

  private toAmazonUtcDateTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new AmazonIntegrationError(`Invalid datetime value provided: ${value}`);
    }

    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}
