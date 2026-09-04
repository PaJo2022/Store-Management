# Amazon Fulfillment Sandbox Flow

## Overview
This project now supports idempotent order-level fulfillment with a persistent state machine and label storage.

Primary endpoints:
- `POST /api/orders/:legacyId/fulfillment`
- `GET /api/orders/:legacyId/fulfillment`
- `GET /api/fulfillments/:id`
- `GET /api/fulfillments/:id/label`

Compatibility endpoint:
- `POST /api/orders/:legacyId/generate-label` (uses the same fulfillment engine)

## State Machine
Statuses:
- `PENDING`
- `GETTING_RATES`
- `RATES_READY`
- `PURCHASING`
- `FULFILLED`
- `FAILED`
- `CANCELLED`
- `RECONCILIATION_REQUIRED`

Key transitions:
- `PENDING -> GETTING_RATES -> RATES_READY -> PURCHASING -> FULFILLED`
- Errors before purchase: `GETTING_RATES -> FAILED`
- Purchase with ambiguous result: `PURCHASING -> RECONCILIATION_REQUIRED`

`FULFILLED` is terminal and cannot transition back to purchase/rate states.

## Duplicate Protection
- Persistent unique DB constraint on `order_fulfillments.shopify_order_id`.
- Atomic status transitions in SQL (`UPDATE ... WHERE status IN (...)`).
- Requests that find `FULFILLED` return existing fulfillment data.
- Requests during `GETTING_RATES`/`PURCHASING` return `FULFILLMENT_IN_PROGRESS`.

## Retry Strategy
- Token/auth issues: refresh once in Amazon auth flow.
- GetRates HTTP retries are allowed for retriable statuses.
- PurchaseShipment does **not** auto-retry on unknown/ambiguous failures.
- Ambiguous purchase outcomes are marked `RECONCILIATION_REQUIRED`.

## Label Storage
- Base64 label payloads are decoded and saved under `LABELS_STORAGE_PATH`.
- API serves labels via `GET /api/labels/:fileName`.
- Fulfillment record stores label reference path, not raw base64.

## Environment Variables
- `FULFILLMENT_RATE_TTL_SECONDS` (default `480`)
- Existing Amazon sandbox envs remain required.
- Existing label storage env remains used: `LABELS_STORAGE_PATH`.

## Run
1. `npm run dev`
2. `npm run dev:ui`

Or combined:
1. `npm run dev:all`

## Tests
Run:
1. `npm run test`

Current tests include:
- Rate selection logic
- COD/outstanding calculation
- State machine transition guards
