const fs = require("node:fs");
const path = require("node:path");

function parseEnvFile(content) {
  const parsed = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = rawLine.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, equalsIndex).trim();
    const value = rawLine.slice(equalsIndex + 1).trim();
    parsed[key] = value;
  }

  return parsed;
}

function main() {
  const envFileArg = process.argv[2] || ".env.live";
  const envPath = path.resolve(process.cwd(), envFileArg);

  if (!fs.existsSync(envPath)) {
    console.error(`PROD-CHECK FAILED: env file not found: ${envPath}`);
    process.exit(1);
  }

  const env = parseEnvFile(fs.readFileSync(envPath, "utf8"));

  const requiredLiveVars = [
    "SHOPIFY_STORE",
    "SHOPIFY_ACCESS_TOKEN",
    "SHOPIFY_API_VERSION",
    "AMAZON_SHIPPING_MODE",
    "AMAZON_SHIPPING_API_BASE_URL",
    "AMAZON_RATES_PATH",
    "AMAZON_PURCHASE_SHIPMENT_PATH",
    "AMAZON_LWA_CLIENT_ID",
    "AMAZON_LWA_CLIENT_SECRET",
    "AMAZON_LWA_REFRESH_TOKEN",
    "AMAZON_SHIP_FROM_NAME",
    "AMAZON_SHIP_FROM_PHONE",
    "AMAZON_SHIP_FROM_ADDRESS1",
    "AMAZON_SHIP_FROM_CITY",
    "AMAZON_SHIP_FROM_STATE",
    "AMAZON_SHIP_FROM_POSTAL_CODE"
  ];

  const missing = requiredLiveVars.filter((key) => !(env[key] || "").trim());

  const mode = (env.AMAZON_SHIPPING_MODE || "").trim().toLowerCase();
  if (mode !== "live") {
    missing.push("AMAZON_SHIPPING_MODE=live");
  }

  if (missing.length > 0) {
    console.error("PROD-CHECK FAILED: missing required live configuration:");
    for (const item of missing) {
      console.error(` - ${item}`);
    }
    process.exit(1);
  }

  console.log(`PROD-CHECK OK: ${envFileArg}`);
  console.log(`Mode: ${env.AMAZON_SHIPPING_MODE}`);
  console.log(`API Base: ${env.AMAZON_SHIPPING_API_BASE_URL}`);
  console.log(`DB Path: ${env.DATABASE_PATH || "data/store.live.db"}`);

  const hasAwsCreds =
    (env.AMAZON_AWS_ACCESS_KEY_ID || "").trim().length > 0 &&
    (env.AMAZON_AWS_SECRET_ACCESS_KEY || "").trim().length > 0;
  if (!hasAwsCreds) {
    console.log("Note: AWS SigV4 credentials are not set; runtime will use token-only live requests.");
  }
}

main();
