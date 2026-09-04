import fs from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";
import { Database, open } from "sqlite";

export type AppDatabase = Database<sqlite3.Database, sqlite3.Statement>;

export async function createDatabase(dbPath: string): Promise<AppDatabase> {
  const resolvedPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = await open({
    filename: resolvedPath,
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS orders_cache (
      id TEXT PRIMARY KEY,
      legacy_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      financial_status TEXT NOT NULL,
      fulfillment_status TEXT NOT NULL,
      total_price TEXT NOT NULL,
      currency_code TEXT NOT NULL,
      amount_to_collect TEXT NOT NULL,
      payment_pending INTEGER NOT NULL,
      customer_json TEXT,
      shipping_json TEXT,
      line_items_json TEXT NOT NULL,
      package_profile_id TEXT,
      payment_status_override INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fulfillment_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      dry_run INTEGER NOT NULL,
      total_orders INTEGER NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS fulfillment_jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      carrier TEXT,
      tracking_number TEXT,
      label_url TEXT,
      collect_amount TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES fulfillment_batches(id) ON DELETE CASCADE,
      FOREIGN KEY(order_id) REFERENCES orders_cache(id) ON DELETE CASCADE,
      UNIQUE(batch_id, order_id)
    );

    CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_order_id
      ON fulfillment_jobs(order_id);

    CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_batch_id
      ON fulfillment_jobs(batch_id);

    CREATE TABLE IF NOT EXISTS order_fulfillments (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      shopify_order_id TEXT NOT NULL UNIQUE,
      shopify_order_name TEXT NOT NULL,
      shopify_order_numeric_id TEXT,
      status TEXT NOT NULL,
      amazon_shipment_id TEXT,
      amazon_tracking_id TEXT,
      amazon_carrier TEXT,
      amazon_service TEXT,
      amazon_rate_id TEXT,
      amazon_request_token TEXT,
      label_document_type TEXT,
      label_storage_path TEXT,
      label_content_type TEXT,
      label_generated_at TEXT,
      purchased_at TEXT,
      estimated_delivery_start TEXT,
      estimated_delivery_end TEXT,
      shipping_charge REAL,
      currency TEXT,
      package_count INTEGER NOT NULL DEFAULT 0,
      request_payload_json TEXT,
      rate_response_json TEXT,
      rate_generated_at TEXT,
      error_code TEXT,
      error_message TEXT,
      last_error_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_order_fulfillments_status
      ON order_fulfillments(status);

    CREATE INDEX IF NOT EXISTS idx_order_fulfillments_updated_at
      ON order_fulfillments(updated_at);

    CREATE TABLE IF NOT EXISTS shipping_package_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      length_cm REAL NOT NULL,
      width_cm REAL NOT NULL,
      height_cm REAL NOT NULL,
      weight_kg REAL NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_shipping_package_profiles_default
      ON shipping_package_profiles(is_default);
  `);

  const orderColumns = await db.all<Array<{ name: string }>>("PRAGMA table_info(orders_cache)");
  if (!orderColumns.some((column) => column.name === "package_profile_id")) {
    await db.exec("ALTER TABLE orders_cache ADD COLUMN package_profile_id TEXT");
  }
  if (!orderColumns.some((column) => column.name === "payment_status_override")) {
    await db.exec("ALTER TABLE orders_cache ADD COLUMN payment_status_override INTEGER NOT NULL DEFAULT 0");
  }
  if (!orderColumns.some((column) => column.name === "shopify_tracking_number")) {
    await db.exec("ALTER TABLE orders_cache ADD COLUMN shopify_tracking_number TEXT");
  }
  if (!orderColumns.some((column) => column.name === "shopify_tracking_company")) {
    await db.exec("ALTER TABLE orders_cache ADD COLUMN shopify_tracking_company TEXT");
  }

  return db;
}
