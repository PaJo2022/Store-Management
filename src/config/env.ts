import dotenv from "dotenv";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

export interface AppEnv {
  shopifyStore: string;
  shopifyAccessToken: string;
  shopifyApiVersion: string;
  port: number;
  frontendOrigin: string;
  databasePath: string;
  labelsStoragePath: string;
  fulfillmentRateTtlSeconds: number;
  amazonShipping: AmazonShippingConfig;
  invoiceCompany: InvoiceCompanyConfig;
}

export interface InvoiceCompanyConfig {
  legalName: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  gstin: string;
  vat?: string;
  fssai?: string;
  defaultTaxRatePercent: number;
}

export interface AmazonShippingConfig {
  mode: "mock" | "sandbox" | "live";
  apiBaseUrl: string;
  ratesPath: string;
  purchaseShipmentPath: string;
  shippingBusinessId?: string;
  userAgent: string;
  preferredServiceId?: string;
  shipperGstId?: string;
  lwaClientId: string;
  lwaClientSecret: string;
  lwaRefreshToken: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  awsRegion: string;
  shipFromName: string;
  shipFromPhone: string;
  shipFromAddress1: string;
  shipFromAddress2?: string;
  shipFromCity: string;
  shipFromState: string;
  shipFromPostalCode: string;
  shipFromCountryCode: string;
  fallbackRecipientPhone: string;
  defaultRecipientCountryCode: string;
  packageWeightKg: string;
  packageLengthCm: number;
  packageWidthCm: number;
  packageHeightCm: number;
}

const REQUIRED_ENV_VARS = [
  "SHOPIFY_STORE",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_API_VERSION"
] as const;

const PLACEHOLDER_PATTERNS = [
  "your-store-name",
  "your_admin_api_access_token",
  "shpat_your_"
];

function containsPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function validateShopifyStore(rawStore: string): string {
  const store = rawStore.trim();

  if (containsPlaceholder(store)) {
    throw new Error(
      "SHOPIFY_STORE is using a placeholder value. Set your real store domain, for example: mystore.myshopify.com"
    );
  }

  if (store.includes("http://") || store.includes("https://")) {
    throw new Error(
      "SHOPIFY_STORE must not include protocol. Use only the domain, for example: mystore.myshopify.com"
    );
  }

  if (store.includes("/")) {
    throw new Error(
      "SHOPIFY_STORE must not include any path. Use only the domain, for example: mystore.myshopify.com"
    );
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(store)) {
    throw new Error(
      "SHOPIFY_STORE must be a valid myshopify domain, for example: mystore.myshopify.com"
    );
  }

  return store;
}

function validateApiVersion(rawVersion: string): string {
  const version = rawVersion.trim();

  if (containsPlaceholder(version)) {
    throw new Error(
      "SHOPIFY_API_VERSION is using a placeholder value. Set a real version like 2026-07"
    );
  }

  if (!/^\d{4}-\d{2}$/.test(version)) {
    throw new Error(
      "SHOPIFY_API_VERSION must be in YYYY-MM format, for example: 2026-07"
    );
  }

  return version;
}

function validateAccessToken(rawToken: string): string {
  const token = rawToken.trim();

  if (containsPlaceholder(token)) {
    throw new Error(
      "SHOPIFY_ACCESS_TOKEN is using a placeholder value. Set your real Admin API access token."
    );
  }

  if (token.startsWith("shpss_")) {
    throw new Error(
      "SHOPIFY_ACCESS_TOKEN appears to be an app secret/client secret. Use the Admin API access token from your custom app's API credentials page."
    );
  }

  if (!token.startsWith("shpat_")) {
    console.warn(
      "Warning: SHOPIFY_ACCESS_TOKEN does not start with 'shpat_'. Ensure you are using the Admin API access token, not a client secret or storefront token."
    );
  }

  return token;
}

function parseAmazonShippingConfig(): AmazonShippingConfig {
  const modeRaw = (process.env.AMAZON_SHIPPING_MODE ?? "mock").trim().toLowerCase();
  const mode = modeRaw === "live" || modeRaw === "sandbox" ? modeRaw : "mock";

  const config: AmazonShippingConfig = {
    mode,
    apiBaseUrl: (process.env.AMAZON_SHIPPING_API_BASE_URL ?? "https://sellingpartnerapi-fe.amazon.com").trim(),
    ratesPath: (process.env.AMAZON_RATES_PATH ?? "/shipping/v2/shipments/rates").trim(),
    purchaseShipmentPath: (process.env.AMAZON_PURCHASE_SHIPMENT_PATH ?? "/shipping/v2/shipments").trim(),
    shippingBusinessId: (process.env.AMAZON_SHIPPING_BUSINESS_ID ?? "").trim() || undefined,
    userAgent: (process.env.AMAZON_USER_AGENT ?? "StoreFulfillmentSystem/1.0 (Language=TypeScript)").trim(),
    preferredServiceId: (process.env.AMAZON_PREFERRED_SERVICE_ID ?? "").trim() || undefined,
    shipperGstId:
      (process.env.AMAZON_SHIPPER_GST_ID ?? process.env.GST_COMPANY_GSTIN ?? "").trim() ||
      undefined,
    lwaClientId: (process.env.AMAZON_LWA_CLIENT_ID ?? "").trim(),
    lwaClientSecret: (process.env.AMAZON_LWA_CLIENT_SECRET ?? "").trim(),
    lwaRefreshToken: (process.env.AMAZON_LWA_REFRESH_TOKEN ?? "").trim(),
    awsAccessKeyId: (process.env.AMAZON_AWS_ACCESS_KEY_ID ?? "").trim(),
    awsSecretAccessKey: (process.env.AMAZON_AWS_SECRET_ACCESS_KEY ?? "").trim(),
    awsSessionToken: (process.env.AMAZON_AWS_SESSION_TOKEN ?? "").trim() || undefined,
    awsRegion: (process.env.AMAZON_AWS_REGION ?? "us-east-1").trim(),
    shipFromName: (process.env.AMAZON_SHIP_FROM_NAME ?? "").trim(),
    shipFromPhone: (process.env.AMAZON_SHIP_FROM_PHONE ?? "").trim(),
    shipFromAddress1: (process.env.AMAZON_SHIP_FROM_ADDRESS1 ?? "").trim(),
    shipFromAddress2: (process.env.AMAZON_SHIP_FROM_ADDRESS2 ?? "").trim() || undefined,
    shipFromCity: (process.env.AMAZON_SHIP_FROM_CITY ?? "").trim(),
    shipFromState: (process.env.AMAZON_SHIP_FROM_STATE ?? "").trim(),
    shipFromPostalCode: (process.env.AMAZON_SHIP_FROM_POSTAL_CODE ?? "").trim(),
    shipFromCountryCode: (process.env.AMAZON_SHIP_FROM_COUNTRY_CODE ?? "IN").trim().toUpperCase(),
    fallbackRecipientPhone: (process.env.AMAZON_FALLBACK_RECIPIENT_PHONE ?? "9999999999").trim(),
    defaultRecipientCountryCode: (process.env.AMAZON_DEFAULT_RECIPIENT_COUNTRY_CODE ?? "IN").trim().toUpperCase(),
    packageWeightKg: (process.env.AMAZON_PACKAGE_WEIGHT_KG ?? "0.5").trim(),
    packageLengthCm: Number(process.env.AMAZON_PACKAGE_LENGTH_CM ?? "20"),
    packageWidthCm: Number(process.env.AMAZON_PACKAGE_WIDTH_CM ?? "15"),
    packageHeightCm: Number(process.env.AMAZON_PACKAGE_HEIGHT_CM ?? "10")
  };

  if (mode !== "mock") {
    const requiredAmazonApi = [
      ["AMAZON_LWA_CLIENT_ID", config.lwaClientId],
      ["AMAZON_LWA_CLIENT_SECRET", config.lwaClientSecret],
      ["AMAZON_LWA_REFRESH_TOKEN", config.lwaRefreshToken],
      ["AMAZON_SHIP_FROM_NAME", config.shipFromName],
      ["AMAZON_SHIP_FROM_PHONE", config.shipFromPhone],
      ["AMAZON_SHIP_FROM_ADDRESS1", config.shipFromAddress1],
      ["AMAZON_SHIP_FROM_CITY", config.shipFromCity],
      ["AMAZON_SHIP_FROM_STATE", config.shipFromState],
      ["AMAZON_SHIP_FROM_POSTAL_CODE", config.shipFromPostalCode]
    ] as const;

    const missing = [...requiredAmazonApi]
      .filter((entry) => !entry[1])
      .map((entry) => entry[0]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required ${mode} Amazon variables: ${missing.join(", ")}`
      );
    }

    if (!config.apiBaseUrl.startsWith("https://")) {
      throw new Error("AMAZON_SHIPPING_API_BASE_URL must start with https://");
    }

    if (!config.ratesPath.startsWith("/")) {
      throw new Error("AMAZON_RATES_PATH must start with /");
    }

    if (!config.purchaseShipmentPath.startsWith("/")) {
      throw new Error("AMAZON_PURCHASE_SHIPMENT_PATH must start with /");
    }
  }

  return config;
}

function parseInvoiceCompanyConfig(): InvoiceCompanyConfig {
  const defaultTaxRatePercent = Number(process.env.GST_DEFAULT_TAX_RATE_PERCENT ?? "18");

  return {
    legalName: (process.env.GST_COMPANY_LEGAL_NAME ?? "Your Company").trim(),
    addressLine1: (process.env.GST_COMPANY_ADDRESS_LINE1 ?? "").trim(),
    addressLine2: (process.env.GST_COMPANY_ADDRESS_LINE2 ?? "").trim() || undefined,
    city: (process.env.GST_COMPANY_CITY ?? "").trim(),
    state: (process.env.GST_COMPANY_STATE ?? "").trim(),
    postalCode: (process.env.GST_COMPANY_POSTAL_CODE ?? "").trim(),
    country: (process.env.GST_COMPANY_COUNTRY ?? "India").trim(),
    phone: (process.env.GST_COMPANY_PHONE ?? "").trim(),
    email: (process.env.GST_COMPANY_EMAIL ?? "").trim(),
    gstin: (process.env.GST_COMPANY_GSTIN ?? "").trim(),
    vat: (process.env.GST_COMPANY_VAT ?? "").trim() || undefined,
    fssai: (process.env.GST_COMPANY_FSSAI ?? "").trim() || undefined,
    defaultTaxRatePercent:
      Number.isFinite(defaultTaxRatePercent) && defaultTaxRatePercent > 0
        ? defaultTaxRatePercent
        : 18
  };
}

function parseFulfillmentRateTtlSeconds(): number {
  const raw = Number(process.env.FULFILLMENT_RATE_TTL_SECONDS ?? "480");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 480;
  }

  return Math.round(raw);
}

export function getEnv(): AppEnv {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  return {
    shopifyStore: validateShopifyStore(process.env.SHOPIFY_STORE!),
    shopifyAccessToken: validateAccessToken(process.env.SHOPIFY_ACCESS_TOKEN!),
    shopifyApiVersion: validateApiVersion(process.env.SHOPIFY_API_VERSION!),
    port: Number(process.env.PORT ?? "4000"),
    frontendOrigin: (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173").trim(),
    databasePath: (process.env.DATABASE_PATH ?? "data/store.db").trim(),
    labelsStoragePath: (process.env.LABELS_STORAGE_PATH ?? "storage/labels").trim(),
    fulfillmentRateTtlSeconds: parseFulfillmentRateTtlSeconds(),
    amazonShipping: parseAmazonShippingConfig(),
    invoiceCompany: parseInvoiceCompanyConfig()
  };
}
