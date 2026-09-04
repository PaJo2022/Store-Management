import { randomUUID } from "node:crypto";
import { AppDatabase } from "../db/database";
import { OrderFulfillment, OrderFulfillmentStatus } from "../types/orderFulfillment";
import { assertValidTransition } from "../services/fulfillment/fulfillmentStateMachine";

interface OrderFulfillmentRow {
  id: string;
  operation_id: string;
  shopify_order_id: string;
  shopify_order_name: string;
  shopify_order_numeric_id: string | null;
  status: OrderFulfillmentStatus;
  amazon_shipment_id: string | null;
  amazon_tracking_id: string | null;
  amazon_carrier: string | null;
  amazon_service: string | null;
  amazon_rate_id: string | null;
  amazon_request_token: string | null;
  label_document_type: string | null;
  label_storage_path: string | null;
  label_content_type: string | null;
  label_generated_at: string | null;
  purchased_at: string | null;
  estimated_delivery_start: string | null;
  estimated_delivery_end: string | null;
  shipping_charge: number | null;
  currency: string | null;
  package_count: number;
  request_payload_json: string | null;
  rate_response_json: string | null;
  rate_generated_at: string | null;
  error_code: string | null;
  error_message: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SaveRatesInput {
  status: "RATES_READY";
  amazonRateId: string;
  amazonRequestToken: string;
  amazonCarrier: string;
  amazonService: string;
  estimatedDeliveryStart: string | null;
  estimatedDeliveryEnd: string | null;
  shippingCharge: number | null;
  currency: string | null;
  rateResponseJson: string;
}

interface MarkFulfilledInput {
  amazonShipmentId: string;
  amazonTrackingId: string;
  amazonCarrier: string;
  amazonService: string;
  labelDocumentType: string;
  labelStoragePath: string;
  labelContentType: string;
  packageCount: number;
}

export class OrderFulfillmentRepository {
  constructor(private readonly db: AppDatabase) {}

  async ensurePendingForOrder(orderId: string, orderName: string): Promise<OrderFulfillment> {
    const now = new Date().toISOString();
    const numericId = orderId.split("/").pop() ?? null;

    await this.db.run(
      `
      INSERT OR IGNORE INTO order_fulfillments (
        id,
        operation_id,
        shopify_order_id,
        shopify_order_name,
        shopify_order_numeric_id,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `,
      randomUUID(),
      this.createOperationId(),
      orderId,
      orderName,
      numericId,
      now,
      now
    );

    const record = await this.getByOrderId(orderId);
    if (!record) {
      throw new Error("Unable to initialize fulfillment record.");
    }

    return record;
  }

  async getByOrderId(orderId: string): Promise<OrderFulfillment | null> {
    const row = await this.db.get<OrderFulfillmentRow>(
      `
      SELECT *
      FROM order_fulfillments
      WHERE shopify_order_id = ?
      `,
      orderId
    );

    return row ? this.mapRow(row) : null;
  }

  async getById(id: string): Promise<OrderFulfillment | null> {
    const row = await this.db.get<OrderFulfillmentRow>(
      `
      SELECT *
      FROM order_fulfillments
      WHERE id = ?
      `,
      id
    );

    return row ? this.mapRow(row) : null;
  }

  async tryTransitionStatus(
    id: string,
    allowedFrom: OrderFulfillmentStatus[],
    nextStatus: OrderFulfillmentStatus
  ): Promise<boolean> {
    if (allowedFrom.length === 0) {
      return false;
    }

    for (const fromStatus of allowedFrom) {
      assertValidTransition(fromStatus, nextStatus);
    }

    const placeholders = allowedFrom.map(() => "?").join(",");
    const now = new Date().toISOString();
    const result = await this.db.run(
      `
      UPDATE order_fulfillments
      SET status = ?, updated_at = ?, error_code = NULL, error_message = NULL
      WHERE id = ?
        AND status IN (${placeholders})
      `,
      nextStatus,
      now,
      id,
      ...allowedFrom
    );

    return (result.changes ?? 0) === 1;
  }

  async saveRates(id: string, input: SaveRatesInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `
      UPDATE order_fulfillments
      SET status = ?,
          amazon_rate_id = ?,
          amazon_request_token = ?,
          amazon_carrier = ?,
          amazon_service = ?,
          estimated_delivery_start = ?,
          estimated_delivery_end = ?,
          shipping_charge = ?,
          currency = ?,
          rate_response_json = ?,
          rate_generated_at = ?,
          updated_at = ?
      WHERE id = ?
      `,
      input.status,
      input.amazonRateId,
      input.amazonRequestToken,
      input.amazonCarrier,
      input.amazonService,
      input.estimatedDeliveryStart,
      input.estimatedDeliveryEnd,
      input.shippingCharge,
      input.currency,
      input.rateResponseJson,
      now,
      now,
      id
    );
  }

  async markFulfilled(id: string, input: MarkFulfilledInput): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `
      UPDATE order_fulfillments
      SET status = 'FULFILLED',
          amazon_shipment_id = ?,
          amazon_tracking_id = ?,
          amazon_carrier = ?,
          amazon_service = ?,
          label_document_type = ?,
          label_storage_path = ?,
          label_content_type = ?,
          label_generated_at = ?,
          purchased_at = ?,
          package_count = ?,
          updated_at = ?,
          error_code = NULL,
          error_message = NULL,
          last_error_at = NULL
      WHERE id = ?
      `,
      input.amazonShipmentId,
      input.amazonTrackingId,
      input.amazonCarrier,
      input.amazonService,
      input.labelDocumentType,
      input.labelStoragePath,
      input.labelContentType,
      now,
      now,
      input.packageCount,
      now,
      id
    );
  }

  async markFailed(
    id: string,
    status: "FAILED" | "RECONCILIATION_REQUIRED",
    errorCode: string,
    errorMessage: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `
      UPDATE order_fulfillments
      SET status = ?, error_code = ?, error_message = ?, last_error_at = ?, updated_at = ?
      WHERE id = ?
      `,
      status,
      errorCode,
      errorMessage,
      now,
      now,
      id
    );
  }

  async invalidateRates(id: string): Promise<void> {
    await this.db.run(
      `
      UPDATE order_fulfillments
      SET status = 'PENDING',
          amazon_rate_id = NULL,
          amazon_request_token = NULL,
          amazon_carrier = NULL,
          amazon_service = NULL,
          estimated_delivery_start = NULL,
          estimated_delivery_end = NULL,
          shipping_charge = NULL,
          currency = NULL,
          rate_response_json = NULL,
          rate_generated_at = NULL,
          updated_at = ?
      WHERE id = ? AND status IN ('PENDING', 'FAILED', 'RATES_READY')
      `,
      new Date().toISOString(),
      id
    );
  }

  async updateOperationId(id: string): Promise<string> {
    const operationId = this.createOperationId();
    await this.db.run(
      `
      UPDATE order_fulfillments
      SET operation_id = ?, updated_at = ?
      WHERE id = ?
      `,
      operationId,
      new Date().toISOString(),
      id
    );

    return operationId;
  }

  async recoverStaleProcessing(id: string, staleBefore: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      `
      UPDATE order_fulfillments
      SET status = CASE status
            WHEN 'GETTING_RATES' THEN 'FAILED'
            WHEN 'PURCHASING' THEN 'RECONCILIATION_REQUIRED'
          END,
          error_code = CASE status
            WHEN 'GETTING_RATES' THEN 'STALE_RATE_REQUEST'
            WHEN 'PURCHASING' THEN 'STALE_PURCHASE_REQUEST'
          END,
          error_message = CASE status
            WHEN 'GETTING_RATES' THEN 'Rate request timed out and was released for retry.'
            WHEN 'PURCHASING' THEN 'Purchase request timed out; reconcile with Amazon before retrying.'
          END,
          last_error_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status IN ('GETTING_RATES', 'PURCHASING')
        AND updated_at < ?
      `,
      now,
      now,
      id,
      staleBefore
    );

    return (result.changes ?? 0) === 1;
  }

  private createOperationId(): string {
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
    const suffix = randomUUID().split("-")[0].toUpperCase();
    return `FUL-${stamp}-${suffix}`;
  }

  private mapRow(row: OrderFulfillmentRow): OrderFulfillment {
    return {
      id: row.id,
      operationId: row.operation_id,
      shopifyOrderId: row.shopify_order_id,
      shopifyOrderName: row.shopify_order_name,
      shopifyOrderNumericId: row.shopify_order_numeric_id,
      status: row.status,
      amazonShipmentId: row.amazon_shipment_id,
      amazonTrackingId: row.amazon_tracking_id,
      amazonCarrier: row.amazon_carrier,
      amazonService: row.amazon_service,
      amazonRateId: row.amazon_rate_id,
      amazonRequestToken: row.amazon_request_token,
      labelDocumentType: row.label_document_type,
      labelStoragePath: row.label_storage_path,
      labelContentType: row.label_content_type,
      labelGeneratedAt: row.label_generated_at,
      purchasedAt: row.purchased_at,
      estimatedDeliveryStart: row.estimated_delivery_start,
      estimatedDeliveryEnd: row.estimated_delivery_end,
      shippingCharge: row.shipping_charge,
      currency: row.currency,
      packageCount: row.package_count,
      requestPayloadJson: row.request_payload_json,
      rateResponseJson: row.rate_response_json,
      rateGeneratedAt: row.rate_generated_at,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      lastErrorAt: row.last_error_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
