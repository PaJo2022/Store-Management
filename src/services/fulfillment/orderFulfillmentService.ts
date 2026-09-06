import { AmazonIntegrationError } from "../amazon/amazonLiveShippingService";
import {
  AmazonShippingService,
  GeneratedLabel,
  ShippingRateOption,
  ShippingRatesQuote
} from "../amazon/amazonShippingService";
import { OrderSummary } from "../../models/order";
import { OrderFulfillmentRepository } from "../../repositories/orderFulfillmentRepository";
import { OrderFulfillment, OrderFulfillmentStatus } from "../../types/orderFulfillment";
import { LabelStorageService } from "./labelStorageService";
import { calculateCollectOnDeliveryAmount } from "./collectOnDelivery";
import { selectBestRate } from "./rateSelector";

const DEFAULT_RATE_TTL_MS = 8 * 60 * 1000;
const PROCESSING_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const RATE_LOCK_TIMEOUT_MS = 2 * 60 * 1000;

export class FulfillmentWorkflowError extends Error {
  constructor(
    public readonly code:
      | "VALIDATION_ERROR"
      | "FULFILLMENT_IN_PROGRESS"
      | "SHIPMENT_ALREADY_EXISTS"
      | "AMAZON_AUTH_ERROR"
      | "AMAZON_RATE_ERROR"
      | "AMAZON_PURCHASE_ERROR"
      | "UNKNOWN_PURCHASE_RESULT",
    message: string
  ) {
    super(message);
    this.name = "FulfillmentWorkflowError";
  }
}

export interface FulfillmentResult {
  id: string;
  operationId: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  status: OrderFulfillmentStatus;
  trackingNumber: string | null;
  carrier: string | null;
  service: string | null;
  shippingCharge: number | null;
  currency: string | null;
  labelUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  alreadyFulfilled: boolean;
}

export class OrderFulfillmentService {
  constructor(
    private readonly repository: OrderFulfillmentRepository,
    private readonly amazonShippingService: AmazonShippingService,
    private readonly labelStorageService: LabelStorageService,
    private readonly rateTtlMs = DEFAULT_RATE_TTL_MS
  ) {}

  async fulfillOrder(order: OrderSummary): Promise<FulfillmentResult> {
    this.validateOrder(order);
    let existing = await this.repository.ensurePendingForOrder(order.id, order.name);

    if (
      (existing.status === "GETTING_RATES" || existing.status === "PURCHASING") &&
      this.isProcessingLockStale(existing.updatedAt)
    ) {
      const recovered = await this.repository.recoverStaleProcessing(
        existing.id,
        new Date(Date.now() - PROCESSING_LOCK_TIMEOUT_MS).toISOString()
      );
      if (recovered) {
        const refreshed = await this.repository.getByOrderId(order.id);
        if (refreshed) {
          existing = refreshed;
        }
      }
    }

    if (existing.status === "FULFILLED") {
      return this.toResult(existing, true);
    }

    if (order.fulfillmentStatus?.toUpperCase() === "FULFILLED") {
      throw new FulfillmentWorkflowError(
        "VALIDATION_ERROR",
        "Order is already fulfilled in Shopify. Label generation is not allowed."
      );
    }

    if (existing.status === "GETTING_RATES" || existing.status === "PURCHASING") {
      throw new FulfillmentWorkflowError(
        "FULFILLMENT_IN_PROGRESS",
        "Fulfillment already in progress for this order."
      );
    }

    if (existing.status === "CANCELLED") {
      throw new FulfillmentWorkflowError(
        "VALIDATION_ERROR",
        "Cancelled order cannot be fulfilled."
      );
    }

    await this.repository.updateOperationId(existing.id);

    const quote = await this.getOrFetchRates(existing, order);
    const selectedRate = selectBestRate(quote.rates);

    const movedToPurchasing = await this.repository.tryTransitionStatus(
      existing.id,
      ["RATES_READY"],
      "PURCHASING"
    );

    if (!movedToPurchasing) {
      const latest = await this.repository.getByOrderId(order.id);
      if (latest?.status === "FULFILLED") {
        return this.toResult(latest, true);
      }

      throw new FulfillmentWorkflowError(
        "FULFILLMENT_IN_PROGRESS",
        "Fulfillment could not acquire purchasing lock."
      );
    }

    let purchased: GeneratedLabel;
    try {
      purchased = await this.amazonShippingService.purchaseShipment(
        order,
        quote.requestToken,
        selectedRate.rateId,
        quote.rates
      );
    } catch (error) {
      if (this.isAmbiguousPurchaseError(error)) {
        await this.repository.markFailed(
          existing.id,
          "RECONCILIATION_REQUIRED",
          "UNKNOWN_PURCHASE_RESULT",
          "Purchase status unknown. Reconciliation required before retry."
        );
        throw new FulfillmentWorkflowError(
          "UNKNOWN_PURCHASE_RESULT",
          "Amazon purchase result is unknown. Please reconcile before retrying."
        );
      }

      const mapped = this.mapAmazonError(error, "AMAZON_PURCHASE_ERROR");
      await this.repository.markFailed(existing.id, "FAILED", mapped.code, mapped.message);
      throw new FulfillmentWorkflowError(mapped.code, mapped.message);
    }

    const savedLabel = this.saveLabel(order, purchased);

    await this.repository.markFulfilled(existing.id, {
      amazonShipmentId: purchased.shipmentId,
      amazonTrackingId: purchased.trackingNumber,
      amazonCarrier: purchased.carrier,
      amazonService: purchased.service,
      labelDocumentType: purchased.labelFormat,
      labelStoragePath: savedLabel.publicUrl,
      labelContentType: purchased.labelContentType,
      packageCount: Math.max(1, order.lineItems.length)
    });

    const fulfilled = await this.repository.getByOrderId(order.id);
    if (!fulfilled) {
      throw new Error("Fulfillment record missing after success state update.");
    }

    return this.toResult(fulfilled, false);
  }

  async getByOrderId(orderId: string): Promise<OrderFulfillment | null> {
    return this.repository.getByOrderId(orderId);
  }

  async getById(id: string): Promise<OrderFulfillment | null> {
    return this.repository.getById(id);
  }

  async resetForRegeneration(orderId: string): Promise<void> {
    const record = await this.repository.getByOrderId(orderId);
    if (!record) {
      return;
    }

    if (record.status === "GETTING_RATES" || record.status === "PURCHASING") {
      throw new FulfillmentWorkflowError(
        "FULFILLMENT_IN_PROGRESS",
        "Fulfillment is currently processing. Try again after it finishes."
      );
    }

    await this.repository.resetForRegeneration(record.id);
  }

  async cancelOrder(order: OrderSummary): Promise<void> {
    const record = await this.repository.ensurePendingForOrder(order.id, order.name);
    if (record.status === "FULFILLED") {
      throw new FulfillmentWorkflowError("VALIDATION_ERROR", "A purchased shipment cannot be cancelled from this screen.");
    }
    if (record.status === "GETTING_RATES" || record.status === "PURCHASING") {
      throw new FulfillmentWorkflowError("FULFILLMENT_IN_PROGRESS", "Wait for the active fulfillment operation before cancelling.");
    }
    if (record.status !== "CANCELLED") {
      const cancelled = await this.repository.tryTransitionStatus(
        record.id,
        ["PENDING", "FAILED", "RATES_READY", "RECONCILIATION_REQUIRED"],
        "CANCELLED"
      );
      if (!cancelled) {
        throw new Error("Unable to cancel this fulfillment.");
      }
    }
  }

  async primeBestRates(orders: OrderSummary[]): Promise<void> {
    for (const order of orders) {
      await this.primeBestRateForOrder(order);
    }
  }

  async refreshBestRatesForOrder(order: OrderSummary): Promise<ShippingRateOption[]> {
    this.validateOrder(order);
    let record = await this.repository.ensurePendingForOrder(order.id, order.name);
    const lockTimeoutMs =
      record.status === "GETTING_RATES" ? RATE_LOCK_TIMEOUT_MS : PROCESSING_LOCK_TIMEOUT_MS;
    if (
      (record.status === "GETTING_RATES" || record.status === "PURCHASING") &&
      this.isProcessingLockStale(record.updatedAt, lockTimeoutMs)
    ) {
      await this.repository.recoverStaleProcessing(
        record.id,
        new Date(Date.now() - lockTimeoutMs).toISOString()
      );
      const recovered = await this.repository.getByOrderId(order.id);
      if (recovered) {
        record = recovered;
      }
    }
    if (record.status === "FULFILLED" || record.status === "PURCHASING") {
      return record.rateResponseJson ? JSON.parse(record.rateResponseJson) as ShippingRateOption[] : [];
    }

    await this.repository.invalidateRates(record.id);
    const refreshed = await this.repository.getByOrderId(order.id);
    if (!refreshed) {
      throw new Error("Fulfillment record missing while refreshing rates.");
    }

    return (await this.getOrFetchRates(refreshed, order)).rates;
  }

  async selectStoredRate(orderId: string, rateId: string): Promise<ShippingRateOption> {
    const fulfillment = await this.repository.getByOrderId(orderId);
    if (!fulfillment?.amazonRequestToken || !fulfillment.rateResponseJson) {
      throw new FulfillmentWorkflowError("VALIDATION_ERROR", "Fetch rates before selecting a shipping rate.");
    }

    const rates = JSON.parse(fulfillment.rateResponseJson) as ShippingRateOption[];
    const selected = rates.find((rate) => rate.rateId === rateId);
    if (!selected) {
      throw new FulfillmentWorkflowError("VALIDATION_ERROR", "Selected rate is not available for this order.");
    }

    await this.repository.saveRates(fulfillment.id, {
      status: "RATES_READY",
      amazonRateId: selected.rateId,
      amazonRequestToken: fulfillment.amazonRequestToken,
      amazonCarrier: selected.carrierName,
      amazonService: selected.serviceName,
      estimatedDeliveryStart: selected.deliveryWindowStart ?? null,
      estimatedDeliveryEnd: selected.deliveryWindowEnd ?? null,
      shippingCharge: selected.amount,
      currency: selected.currencyCode,
      rateResponseJson: fulfillment.rateResponseJson
    });
    return selected;
  }

  private async primeBestRateForOrder(order: OrderSummary): Promise<void> {
    try {
      this.validateOrder(order);
    } catch {
      return;
    }

    const record = await this.repository.ensurePendingForOrder(order.id, order.name);
    if (record.status === "FULFILLED" || record.status === "PURCHASING" || record.status === "GETTING_RATES") {
      return;
    }

    try {
      await this.getOrFetchRates(record, order, { markFailedOnError: false });
    } catch {
      // Sync prefetch should not fail the overall sync pipeline.
    }
  }

  private async getOrFetchRates(
    fulfillment: OrderFulfillment,
    order: OrderSummary,
    options?: { markFailedOnError?: boolean }
  ): Promise<ShippingRatesQuote> {
    const markFailedOnError = options?.markFailedOnError !== false;

    if (
      fulfillment.status === "RATES_READY" &&
      fulfillment.amazonRequestToken &&
      fulfillment.rateResponseJson &&
      this.isRateFresh(fulfillment.rateGeneratedAt)
    ) {
      try {
        const rates = JSON.parse(fulfillment.rateResponseJson) as ShippingRateOption[];
        if (Array.isArray(rates) && rates.length > 0) {
          return {
            requestToken: fulfillment.amazonRequestToken,
            rates
          };
        }
      } catch {
        // Ignore corrupted cached rate payload and fetch fresh rates.
      }
    }

    const moved = await this.repository.tryTransitionStatus(
      fulfillment.id,
      ["PENDING", "FAILED", "RECONCILIATION_REQUIRED", "RATES_READY"],
      "GETTING_RATES"
    );

    if (!moved) {
      const latest = await this.repository.getByOrderId(order.id);
      if (latest?.status === "FULFILLED") {
        throw new FulfillmentWorkflowError(
          "SHIPMENT_ALREADY_EXISTS",
          "Shipment already exists for this order."
        );
      }

      throw new FulfillmentWorkflowError(
        "FULFILLMENT_IN_PROGRESS",
        "Another request is already processing rates for this order."
      );
    }

    let quote: ShippingRatesQuote;
    try {
      quote = await this.amazonShippingService.getRatesQuote(order);
    } catch (error) {
      const mapped = this.mapAmazonError(error, "AMAZON_RATE_ERROR");

      if (markFailedOnError) {
        await this.repository.markFailed(fulfillment.id, "FAILED", mapped.code, mapped.message);
      } else {
        await this.repository.tryTransitionStatus(fulfillment.id, ["GETTING_RATES"], "PENDING");
      }

      throw new FulfillmentWorkflowError(mapped.code, mapped.message);
    }

    const selected = selectBestRate(quote.rates);
    await this.repository.saveRates(fulfillment.id, {
      status: "RATES_READY",
      amazonRateId: selected.rateId,
      amazonRequestToken: quote.requestToken,
      amazonCarrier: selected.carrierName,
      amazonService: selected.serviceName,
      estimatedDeliveryStart: selected.deliveryWindowStart ?? null,
      estimatedDeliveryEnd: selected.deliveryWindowEnd ?? null,
      shippingCharge: Number.isFinite(selected.amount) ? selected.amount : null,
      currency: selected.currencyCode,
      rateResponseJson: JSON.stringify(quote.rates)
    });

    return quote;
  }

  private saveLabel(order: OrderSummary, purchased: GeneratedLabel): {
    publicUrl: string;
  } {
    if (!purchased.labelDataUrl.startsWith("data:")) {
      throw new FulfillmentWorkflowError(
        "AMAZON_PURCHASE_ERROR",
        "Amazon label payload is not a data URL."
      );
    }

    if (purchased.labelContentType === "application/pdf") {
      const saved = this.labelStorageService.savePdfLabel(
        order.id,
        purchased.trackingNumber,
        purchased.labelDataUrl
      );
      return { publicUrl: saved.publicUrl };
    }

    const dataUrlMatch = purchased.labelDataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!dataUrlMatch) {
      throw new FulfillmentWorkflowError(
        "AMAZON_PURCHASE_ERROR",
        "Amazon label base64 payload is invalid."
      );
    }

    const base64 = dataUrlMatch[2];
    const decoded = Buffer.from(base64, "base64");
    if (decoded.length === 0) {
      throw new FulfillmentWorkflowError(
        "AMAZON_PURCHASE_ERROR",
        "Decoded Amazon label document is empty."
      );
    }

    const ext = purchased.labelFormat.toLowerCase() || "bin";
    const saved = this.labelStorageService.save(
      `labels_${order.id.split("/").pop() ?? order.id}`,
      decoded,
      ext,
      purchased.labelContentType
    );

    return { publicUrl: saved.publicUrl };
  }

  private validateOrder(order: OrderSummary): void {
    if (!order.id || !order.name) {
      throw new FulfillmentWorkflowError("VALIDATION_ERROR", "Order is missing id or name.");
    }

    if (order.financialStatus.toUpperCase() === "VOIDED") {
      throw new FulfillmentWorkflowError(
        "VALIDATION_ERROR",
        "Voided/cancelled order cannot be fulfilled."
      );
    }

    if (!order.shippingAddress?.address1 || !order.shippingAddress.city || !order.shippingAddress.zip) {
      throw new FulfillmentWorkflowError(
        "VALIDATION_ERROR",
        "Order shipping address is incomplete for Amazon shipment."
      );
    }

    if (order.lineItems.length === 0) {
      throw new FulfillmentWorkflowError(
        "VALIDATION_ERROR",
        "Order has no line items for shipment."
      );
    }

    const collectAmount = calculateCollectOnDeliveryAmount(order);
    if (order.paymentPending && collectAmount <= 0) {
      throw new FulfillmentWorkflowError(
        "VALIDATION_ERROR",
        "Order indicates pending payment but outstanding amount is invalid."
      );
    }
  }

  private isRateFresh(rateGeneratedAt: string | null): boolean {
    if (!rateGeneratedAt) {
      return false;
    }

    const parsed = Date.parse(rateGeneratedAt);
    if (Number.isNaN(parsed)) {
      return false;
    }

    return Date.now() - parsed <= this.rateTtlMs;
  }

  private isProcessingLockStale(
    updatedAt: string,
    timeoutMs = PROCESSING_LOCK_TIMEOUT_MS
  ): boolean {
    const updatedAtMs = Date.parse(updatedAt);
    return Number.isNaN(updatedAtMs) || Date.now() - updatedAtMs > timeoutMs;
  }

  private isAmbiguousPurchaseError(error: unknown): boolean {
    if (error instanceof AmazonIntegrationError) {
      if (error.statusCode === 408 || error.statusCode === 500 || error.statusCode === 503) {
        return true;
      }

      return false;
    }

    return error instanceof Error;
  }

  private mapAmazonError(
    error: unknown,
    fallbackCode: "AMAZON_RATE_ERROR" | "AMAZON_PURCHASE_ERROR"
  ): { code: "AMAZON_AUTH_ERROR" | "AMAZON_RATE_ERROR" | "AMAZON_PURCHASE_ERROR"; message: string } {
    if (error instanceof AmazonIntegrationError) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        return {
          code: "AMAZON_AUTH_ERROR",
          message: "Amazon authentication failed while creating shipment."
        };
      }

      return {
        code: fallbackCode,
        message: error.message
      };
    }

    if (error instanceof Error) {
      return {
        code: fallbackCode,
        message: error.message
      };
    }

    return {
      code: fallbackCode,
      message: "Unknown Amazon integration error."
    };
  }

  private toResult(record: OrderFulfillment, alreadyFulfilled: boolean): FulfillmentResult {
    return {
      id: record.id,
      operationId: record.operationId,
      shopifyOrderId: record.shopifyOrderId,
      shopifyOrderName: record.shopifyOrderName,
      status: record.status,
      trackingNumber: record.amazonTrackingId,
      carrier: record.amazonCarrier,
      service: record.amazonService,
      shippingCharge: record.shippingCharge,
      currency: record.currency,
      labelUrl: record.labelStoragePath,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
      alreadyFulfilled
    };
  }
}
