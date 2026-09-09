import { AppDatabase } from "../db/database";
import { OrderSummary } from "../models/order";
import { randomUUID } from "node:crypto";

export type OrderFilter = "all" | "open" | "fulfilled";

interface OrderRow {
  id: string;
  name: string;
  created_at: string;
  financial_status: string;
  fulfillment_status: string;
  total_price: string;
  currency_code: string;
  amount_to_collect: string;
  payment_pending: number;
  customer_json: string | null;
  shipping_json: string | null;
  line_items_json: string;
  best_rate_carrier: string | null;
  best_rate_service: string | null;
  best_rate_amount: number | null;
  best_rate_currency: string | null;
  fulfillment_tracking_number: string | null;
  fulfillment_tracking_url: string | null;
  fulfillment_label_url: string | null;
  fulfillment_carrier: string | null;
  fulfillment_service: string | null;
  fulfillment_shipping_cost: number | null;
  fulfillment_currency: string | null;
  package_profile_id: string | null;
}

export class OrderRepository {
  constructor(private readonly db: AppDatabase) {}

  async upsertOrders(orders: OrderSummary[], syncedAt: string): Promise<void> {
    await this.db.exec("BEGIN");
    try {
      for (const order of orders) {
        const legacyId = order.id.split("/").pop() ?? order.id;
        await this.db.run(
          `
            INSERT INTO orders_cache (
              id,
              legacy_id,
              name,
              created_at,
              financial_status,
              fulfillment_status,
              total_price,
              currency_code,
              amount_to_collect,
              payment_pending,
              customer_json,
              shipping_json,
              line_items_json,
              shopify_tracking_number,
              shopify_tracking_company,
              synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              legacy_id = excluded.legacy_id,
              name = excluded.name,
              created_at = excluded.created_at,
              financial_status = CASE WHEN orders_cache.payment_status_override = 1 THEN orders_cache.financial_status ELSE excluded.financial_status END,
              fulfillment_status = excluded.fulfillment_status,
              total_price = excluded.total_price,
              currency_code = excluded.currency_code,
              amount_to_collect = CASE WHEN orders_cache.payment_status_override = 1 THEN orders_cache.amount_to_collect ELSE excluded.amount_to_collect END,
              payment_pending = CASE WHEN orders_cache.payment_status_override = 1 THEN orders_cache.payment_pending ELSE excluded.payment_pending END,
              customer_json = excluded.customer_json,
              shipping_json = excluded.shipping_json,
              line_items_json = excluded.line_items_json,
              shopify_tracking_number = excluded.shopify_tracking_number,
              shopify_tracking_company = excluded.shopify_tracking_company,
              synced_at = excluded.synced_at
          `,
          order.id,
          legacyId,
          order.name,
          order.createdAt,
          order.financialStatus,
          order.fulfillmentStatus,
          order.totalPrice,
          order.currencyCode,
          order.amountToCollect,
          order.paymentPending ? 1 : 0,
          order.customer ? JSON.stringify(order.customer) : null,
          order.shippingAddress ? JSON.stringify(order.shippingAddress) : null,
          JSON.stringify(order.lineItems),
          order.fulfillmentTrackingNumber ?? null,
          order.fulfillmentCarrier ?? null,
          syncedAt
        );
      }

      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async createManualOrder(input: {
    customer: NonNullable<OrderSummary["customer"]>;
    shippingAddress: NonNullable<OrderSummary["shippingAddress"]>;
    lineItems: OrderSummary["lineItems"];
    paymentPending: boolean;
    packageProfileId?: string;
  }): Promise<OrderSummary> {
    const uniqueId = randomUUID();
    const legacyId = uniqueId.slice(0, 6).toUpperCase();
    const id = `gid://store/ManualOrder/${uniqueId}`;
    const now = new Date().toISOString();
    const name = `MANUAL-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${legacyId.slice(0, 6).toUpperCase()}`;
    const totalPrice = input.lineItems
      .reduce((total, lineItem) => total + Number(lineItem.unitPrice) * lineItem.quantity, 0)
      .toFixed(2);

    await this.db.run(
      `
      INSERT INTO orders_cache (
        id, legacy_id, name, created_at, financial_status, fulfillment_status,
        total_price, currency_code, amount_to_collect, payment_pending,
        customer_json, shipping_json, line_items_json, package_profile_id,
        payment_status_override, synced_at
      ) VALUES (?, ?, ?, ?, ?, 'UNFULFILLED', ?, 'INR', ?, ?, ?, ?, ?, ?, 1, ?)
      `,
      id,
      legacyId,
      name,
      now,
      input.paymentPending ? "PENDING" : "PAID",
      totalPrice,
      input.paymentPending ? totalPrice : "0.00",
      input.paymentPending ? 1 : 0,
      JSON.stringify(input.customer),
      JSON.stringify(input.shippingAddress),
      JSON.stringify(input.lineItems),
      input.packageProfileId ?? null,
      now
    );

    const order = await this.getOrderById(id);
    if (!order) {
      throw new Error("Manual order could not be created.");
    }
    return order;
  }

  async countOrders(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM orders_cache"
    );
    return row?.count ?? 0;
  }

  async listOrders(filter: OrderFilter): Promise<OrderSummary[]> {
    let whereClause = "";
    if (filter === "fulfilled") {
      whereClause = "WHERE UPPER(CASE WHEN o.id LIKE 'gid://store/ManualOrder/%' AND (f.status = 'FULFILLED' OR o.manual_tracking_number IS NOT NULL) THEN 'FULFILLED' ELSE o.fulfillment_status END) = 'FULFILLED'";
    } else if (filter === "open") {
      whereClause = "WHERE UPPER(CASE WHEN o.id LIKE 'gid://store/ManualOrder/%' AND (f.status = 'FULFILLED' OR o.manual_tracking_number IS NOT NULL) THEN 'FULFILLED' ELSE o.fulfillment_status END) NOT IN ('FULFILLED', 'CANCELLED')";
    }

    const rows = await this.db.all<OrderRow[]>(
      `
      SELECT o.id,
             o.name,
             o.created_at,
             o.financial_status,
             CASE WHEN o.id LIKE 'gid://store/ManualOrder/%' AND (f.status = 'FULFILLED' OR o.manual_tracking_number IS NOT NULL) THEN 'FULFILLED' ELSE o.fulfillment_status END AS fulfillment_status,
             o.total_price,
             o.currency_code,
             o.amount_to_collect,
             o.payment_pending,
             o.customer_json,
             o.shipping_json,
             o.line_items_json,
             o.package_profile_id,
             f.amazon_carrier AS best_rate_carrier,
             f.amazon_service AS best_rate_service,
             f.shipping_charge AS best_rate_amount,
                  COALESCE(f.currency, o.currency_code) AS best_rate_currency,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_tracking_id END, (SELECT jobs.tracking_number FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1), o.manual_tracking_number, o.shopify_tracking_number) AS fulfillment_tracking_number,
                  o.manual_tracking_url AS fulfillment_tracking_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.label_storage_path END, (SELECT jobs.label_url FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1)) AS fulfillment_label_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_carrier END, o.manual_tracking_company, o.shopify_tracking_company) AS fulfillment_carrier,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_service END, o.manual_tracking_service) AS fulfillment_service,
                  CASE WHEN f.status = 'FULFILLED' THEN f.shipping_charge ELSE NULL END AS fulfillment_shipping_cost,
                  CASE WHEN f.status = 'FULFILLED' THEN COALESCE(f.currency, o.currency_code) ELSE NULL END AS fulfillment_currency
      FROM orders_cache o
      LEFT JOIN order_fulfillments f
        ON f.shopify_order_id = o.id
       AND f.status IN ('RATES_READY', 'PURCHASING', 'FULFILLED')
      ${whereClause}
      ORDER BY datetime(o.created_at) DESC
      `
    );

    return rows.map((row) => this.mapRow(row));
  }

  async getOrderById(orderId: string): Promise<OrderSummary | null> {
    const row = await this.db.get<OrderRow>(
      `
      SELECT o.id,
             o.name,
             o.created_at,
             o.financial_status,
             CASE WHEN o.id LIKE 'gid://store/ManualOrder/%' AND (f.status = 'FULFILLED' OR o.manual_tracking_number IS NOT NULL) THEN 'FULFILLED' ELSE o.fulfillment_status END AS fulfillment_status,
             o.total_price,
             o.currency_code,
             o.amount_to_collect,
             o.payment_pending,
             o.customer_json,
             o.shipping_json,
             o.line_items_json,
             o.package_profile_id,
             f.amazon_carrier AS best_rate_carrier,
             f.amazon_service AS best_rate_service,
             f.shipping_charge AS best_rate_amount,
                  COALESCE(f.currency, o.currency_code) AS best_rate_currency,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_tracking_id END, (SELECT jobs.tracking_number FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1), o.manual_tracking_number, o.shopify_tracking_number) AS fulfillment_tracking_number,
                  o.manual_tracking_url AS fulfillment_tracking_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.label_storage_path END, (SELECT jobs.label_url FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1)) AS fulfillment_label_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_carrier END, o.manual_tracking_company, o.shopify_tracking_company) AS fulfillment_carrier,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_service END, o.manual_tracking_service) AS fulfillment_service,
                  CASE WHEN f.status = 'FULFILLED' THEN f.shipping_charge ELSE NULL END AS fulfillment_shipping_cost,
                  CASE WHEN f.status = 'FULFILLED' THEN COALESCE(f.currency, o.currency_code) ELSE NULL END AS fulfillment_currency
      FROM orders_cache o
      LEFT JOIN order_fulfillments f
        ON f.shopify_order_id = o.id
       AND f.status IN ('RATES_READY', 'PURCHASING', 'FULFILLED')
      WHERE o.id = ?
      `,
      orderId
    );

    return row ? this.mapRow(row) : null;
  }

  async getOrderByLegacyId(legacyId: string): Promise<OrderSummary | null> {
    const row = await this.db.get<OrderRow>(
      `
      SELECT o.id,
             o.name,
             o.created_at,
             o.financial_status,
             CASE WHEN o.id LIKE 'gid://store/ManualOrder/%' AND (f.status = 'FULFILLED' OR o.manual_tracking_number IS NOT NULL) THEN 'FULFILLED' ELSE o.fulfillment_status END AS fulfillment_status,
             o.total_price,
             o.currency_code,
             o.amount_to_collect,
             o.payment_pending,
             o.customer_json,
             o.shipping_json,
             o.line_items_json,
             o.package_profile_id,
             f.amazon_carrier AS best_rate_carrier,
             f.amazon_service AS best_rate_service,
             f.shipping_charge AS best_rate_amount,
                  COALESCE(f.currency, o.currency_code) AS best_rate_currency,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_tracking_id END, (SELECT jobs.tracking_number FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1), o.manual_tracking_number, o.shopify_tracking_number) AS fulfillment_tracking_number,
                  o.manual_tracking_url AS fulfillment_tracking_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.label_storage_path END, (SELECT jobs.label_url FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1)) AS fulfillment_label_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_carrier END, o.manual_tracking_company, o.shopify_tracking_company) AS fulfillment_carrier,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_service END, o.manual_tracking_service) AS fulfillment_service,
                  CASE WHEN f.status = 'FULFILLED' THEN f.shipping_charge ELSE NULL END AS fulfillment_shipping_cost,
                  CASE WHEN f.status = 'FULFILLED' THEN COALESCE(f.currency, o.currency_code) ELSE NULL END AS fulfillment_currency
      FROM orders_cache o
      LEFT JOIN order_fulfillments f
        ON f.shopify_order_id = o.id
       AND f.status IN ('RATES_READY', 'PURCHASING', 'FULFILLED')
      WHERE o.legacy_id = ?
        OR o.id = ?
        OR o.id = ?
        OR o.name LIKE ?
      `,
      legacyId,
      legacyId,
      `gid://store/ManualOrder/${legacyId}`,
      `MANUAL-%-${legacyId.toUpperCase()}`
    );

    return row ? this.mapRow(row) : null;
  }

  async getOrdersByIds(orderIds: string[]): Promise<OrderSummary[]> {
    if (orderIds.length === 0) {
      return [];
    }

    const placeholders = orderIds.map(() => "?").join(",");
    const rows = await this.db.all<OrderRow[]>(
      `
      SELECT o.id,
             o.name,
             o.created_at,
             o.financial_status,
             CASE WHEN o.id LIKE 'gid://store/ManualOrder/%' AND (f.status = 'FULFILLED' OR o.manual_tracking_number IS NOT NULL) THEN 'FULFILLED' ELSE o.fulfillment_status END AS fulfillment_status,
             o.total_price,
             o.currency_code,
             o.amount_to_collect,
             o.payment_pending,
             o.customer_json,
             o.shipping_json,
             o.line_items_json,
             o.package_profile_id,
             f.amazon_carrier AS best_rate_carrier,
             f.amazon_service AS best_rate_service,
             f.shipping_charge AS best_rate_amount,
                  COALESCE(f.currency, o.currency_code) AS best_rate_currency,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_tracking_id END, (SELECT jobs.tracking_number FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1), o.manual_tracking_number, o.shopify_tracking_number) AS fulfillment_tracking_number,
                  o.manual_tracking_url AS fulfillment_tracking_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.label_storage_path END, (SELECT jobs.label_url FROM fulfillment_jobs jobs INNER JOIN fulfillment_batches batches ON batches.id = jobs.batch_id WHERE jobs.order_id = o.id AND jobs.status = 'SUCCESS' AND batches.dry_run = 0 ORDER BY datetime(jobs.updated_at) DESC LIMIT 1)) AS fulfillment_label_url,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_carrier END, o.manual_tracking_company, o.shopify_tracking_company) AS fulfillment_carrier,
                  COALESCE(CASE WHEN f.status = 'FULFILLED' THEN f.amazon_service END, o.manual_tracking_service) AS fulfillment_service,
                  CASE WHEN f.status = 'FULFILLED' THEN f.shipping_charge ELSE NULL END AS fulfillment_shipping_cost,
                  CASE WHEN f.status = 'FULFILLED' THEN COALESCE(f.currency, o.currency_code) ELSE NULL END AS fulfillment_currency
      FROM orders_cache o
      LEFT JOIN order_fulfillments f
        ON f.shopify_order_id = o.id
       AND f.status IN ('RATES_READY', 'PURCHASING', 'FULFILLED')
      WHERE o.id IN (${placeholders})
      ORDER BY datetime(o.created_at) DESC
      `,
      ...orderIds
    );

    return rows.map((row) => this.mapRow(row));
  }

  async updateOrderDetailsByLegacyId(
    legacyId: string,
    customer: OrderSummary["customer"],
    shippingAddress: OrderSummary["shippingAddress"]
  ): Promise<OrderSummary | null> {
    const now = new Date().toISOString();
    const result = await this.db.run(
      `
      UPDATE orders_cache
      SET customer_json = ?, shipping_json = ?, synced_at = ?
      WHERE legacy_id = ?
      `,
      customer ? JSON.stringify(customer) : null,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      now,
      legacyId
    );

    if ((result.changes ?? 0) === 0) {
      return null;
    }

    return this.getOrderByLegacyId(legacyId);
  }

  async updateManualFulfillmentByLegacyId(
    legacyId: string,
    details: {
      trackingNumber: string;
      trackingUrl: string;
      carrier: string;
      service: string;
    }
  ): Promise<OrderSummary | null> {
    const result = await this.db.run(
      `
      UPDATE orders_cache
      SET manual_tracking_number = ?,
          manual_tracking_url = ?,
          manual_tracking_company = ?,
          manual_tracking_service = ?,
          fulfillment_status = CASE WHEN id LIKE 'gid://store/ManualOrder/%' THEN 'FULFILLED' ELSE fulfillment_status END,
          synced_at = ?
        WHERE legacy_id = ? OR id = ? OR id = ?
      `,
      details.trackingNumber,
      details.trackingUrl,
      details.carrier,
      details.service,
      new Date().toISOString(),
      legacyId,
      legacyId,
      `gid://store/ManualOrder/${legacyId}`
    );

    return (result.changes ?? 0) === 0 ? null : this.getOrderByLegacyId(legacyId);
  }

  async clearManualFulfillmentByLegacyId(legacyId: string): Promise<OrderSummary | null> {
    const result = await this.db.run(
      `
      UPDATE orders_cache
      SET manual_tracking_number = NULL,
          manual_tracking_url = NULL,
          manual_tracking_company = NULL,
          manual_tracking_service = NULL,
          fulfillment_status = CASE WHEN id LIKE 'gid://store/ManualOrder/%' THEN 'UNFULFILLED' ELSE fulfillment_status END,
          synced_at = ?
        WHERE legacy_id = ? OR id = ? OR id = ?
      `,
      new Date().toISOString(),
      legacyId,
      legacyId,
      `gid://store/ManualOrder/${legacyId}`
    );

    return (result.changes ?? 0) === 0 ? null : this.getOrderByLegacyId(legacyId);
  }

  async updatePackageProfileByLegacyId(
    legacyId: string,
    packageProfileId: string | null
  ): Promise<OrderSummary | null> {
    const result = await this.db.run(
      "UPDATE orders_cache SET package_profile_id = ?, synced_at = ? WHERE legacy_id = ? OR id = ? OR id = ?",
      packageProfileId,
      new Date().toISOString(),
      legacyId,
      legacyId,
      `gid://store/ManualOrder/${legacyId}`
    );

    if ((result.changes ?? 0) === 0) {
      return null;
    }

    return this.getOrderByLegacyId(legacyId);
  }

  async updatePaymentStatusByLegacyId(
    legacyId: string,
    status: "PENDING" | "PAID"
  ): Promise<OrderSummary | null> {
    const result = await this.db.run(
      `
      UPDATE orders_cache
      SET financial_status = ?,
          payment_pending = ?,
          amount_to_collect = CASE
            WHEN ? = 'PAID' THEN '0.00'
            ELSE total_price
          END,
          payment_status_override = 1,
          synced_at = ?
      WHERE legacy_id = ? OR id = ? OR id = ?
      `,
      status,
      status === "PENDING" ? 1 : 0,
      status,
      new Date().toISOString(),
      legacyId,
      legacyId,
      `gid://store/ManualOrder/${legacyId}`
    );
    return (result.changes ?? 0) === 0 ? null : this.getOrderByLegacyId(legacyId);
  }

  async updateFulfillmentStatusByLegacyId(
    legacyId: string,
    fulfillmentStatus: string
  ): Promise<OrderSummary | null> {
    const result = await this.db.run(
      "UPDATE orders_cache SET fulfillment_status = ?, synced_at = ? WHERE legacy_id = ? OR name LIKE ?",
      fulfillmentStatus,
      new Date().toISOString(),
      legacyId,
      `MANUAL-%-${legacyId.toUpperCase()}`
    );
    return (result.changes ?? 0) === 0 ? null : this.getOrderByLegacyId(legacyId);
  }

  async getPackageProfileIdForOrder(orderId: string): Promise<string | null> {
    const row = await this.db.get<{ package_profile_id: string | null }>(
      "SELECT package_profile_id FROM orders_cache WHERE id = ?",
      orderId
    );
    return row?.package_profile_id ?? null;
  }

  private mapRow(row: OrderRow): OrderSummary {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      financialStatus: row.financial_status,
      fulfillmentStatus: row.fulfillment_status,
      totalPrice: row.total_price,
      currencyCode: row.currency_code,
      amountToCollect: row.amount_to_collect,
      paymentPending: row.payment_pending === 1,
      customer: row.customer_json
        ? (JSON.parse(row.customer_json) as OrderSummary["customer"])
        : null,
      shippingAddress: row.shipping_json
        ? (JSON.parse(row.shipping_json) as OrderSummary["shippingAddress"])
        : null,
      lineItems: JSON.parse(row.line_items_json) as OrderSummary["lineItems"],
      bestRateCarrier: row.best_rate_carrier,
      bestRateService: row.best_rate_service,
      bestRateAmount: row.best_rate_amount,
      bestRateCurrency: row.best_rate_currency,
      fulfillmentTrackingNumber: row.fulfillment_tracking_number,
      fulfillmentTrackingUrl: row.fulfillment_tracking_url,
      fulfillmentLabelUrl: row.fulfillment_label_url,
      fulfillmentCarrier: row.fulfillment_carrier,
      fulfillmentService: row.fulfillment_service,
      fulfillmentShippingCost: row.fulfillment_shipping_cost,
      fulfillmentCurrency: row.fulfillment_currency,
      packageProfileId: row.package_profile_id
    };
  }
}
