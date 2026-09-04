# Amazon Shipping Live Setup

This project supports three shipment modes:

- mock: local fake labels, no Amazon API calls
- sandbox: real Amazon Shipping sandbox API calls with LWA + AWS SigV4 signing
- live: real Amazon Shipping production API calls with LWA + AWS SigV4 signing

Separate templates are available:

- .env.sandbox.example
- .env.live.example

## 1) Select Shipment Mode

Set in your .env file:

AMAZON_SHIPPING_MODE=sandbox

Use sandbox for testing and live for production.

## 2) Configure Amazon Credentials

Add these values from your Amazon developer account (required for sandbox and live):

- AMAZON_LWA_CLIENT_ID
- AMAZON_LWA_CLIENT_SECRET
- AMAZON_LWA_REFRESH_TOKEN
- AMAZON_AWS_ACCESS_KEY_ID
- AMAZON_AWS_SECRET_ACCESS_KEY
- AMAZON_AWS_REGION
- AMAZON_AWS_SESSION_TOKEN (optional)

## 3) Configure Shipping API Paths and Headers

Defaults are already provided in .env.example, but you can override:

- AMAZON_SHIPPING_API_BASE_URL
- AMAZON_RATES_PATH
- AMAZON_PURCHASE_SHIPMENT_PATH
- AMAZON_SHIPPING_BUSINESS_ID (optional)
- AMAZON_USER_AGENT
- AMAZON_PREFERRED_SERVICE_ID (optional)

## 4) Configure Ship-From Address

Set these to your warehouse or pickup address used for label generation:

- AMAZON_SHIP_FROM_NAME
- AMAZON_SHIP_FROM_PHONE
- AMAZON_SHIP_FROM_ADDRESS1
- AMAZON_SHIP_FROM_ADDRESS2 (optional)
- AMAZON_SHIP_FROM_CITY
- AMAZON_SHIP_FROM_STATE
- AMAZON_SHIP_FROM_POSTAL_CODE
- AMAZON_SHIP_FROM_COUNTRY_CODE

## 5) Package Defaults

Used as default package specs for shipment booking:

- AMAZON_PACKAGE_WEIGHT_KG
- AMAZON_PACKAGE_LENGTH_CM
- AMAZON_PACKAGE_WIDTH_CM
- AMAZON_PACKAGE_HEIGHT_CM

## 6) Generate Batch Labels

1. Sync orders first from dashboard.
2. Select multiple orders.
3. Use Generate Batch Labels.
4. Disable dry-run in UI to make sandbox/live API calls.

## Live API Workflow Used

When sandbox or live mode is enabled, each selected order follows this sequence:

1. POST /shipping/v2/shipments/rates
2. Select a rate (preferred service if configured, else first eligible)
3. Select the lowest `totalCharge` rate from the returned rates array
4. Build requestedDocumentSpecification from supportedDocumentSpecifications
5. POST /shipping/v2/shipments (purchaseShipment)
6. Parse shipment documents and tracking from purchase response

If Amazon returns TOKEN_EXPIRED on purchase, rates are fetched again and purchase is retried once with a new requestToken.
If Amazon returns an invalid access token response (for example HTTP 401), OAuth token is refreshed and the request is retried automatically.

## Notes

- In sandbox and live mode, missing required Amazon variables fail fast at startup.
- Batch records and label history are stored in SQLite at DATABASE_PATH.
- Current implementation requires rates that do not need additionalInputs. If a selected rate requires additionalInputs, the API returns a clear error message and you can extend the implementation with getAdditionalInputs.
