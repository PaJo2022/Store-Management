import { randomUUID } from "node:crypto";
import { AppDatabase } from "../db/database";
import {
  FulfillmentBatch,
  FulfillmentBatchStatus,
  FulfillmentJob,
  FulfillmentJobStatus
} from "../types/fulfillment";

interface FulfillmentBatchRow {
  id: string;
  created_at: string;
  status: FulfillmentBatchStatus;
  dry_run: number;
  total_orders: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
}

interface FulfillmentJobRow {
  id: string;
  batch_id: string;
  order_id: string;
  status: FulfillmentJobStatus;
  carrier: string | null;
  tracking_number: string | null;
  label_url: string | null;
  collect_amount: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class FulfillmentRepository {
  constructor(private readonly db: AppDatabase) {}

  async createBatch(orderIds: string[], dryRun: boolean): Promise<FulfillmentBatch> {
    const batchId = randomUUID();
    const now = new Date().toISOString();

    await this.db.exec("BEGIN");
    try {
      await this.db.run(
        `
        INSERT INTO fulfillment_batches (
          id, created_at, status, dry_run, total_orders,
          success_count, failed_count, skipped_count
        ) VALUES (?, ?, 'PROCESSING', ?, ?, 0, 0, 0)
        `,
        batchId,
        now,
        dryRun ? 1 : 0,
        orderIds.length
      );

      for (const orderId of orderIds) {
        await this.db.run(
          `
          INSERT INTO fulfillment_jobs (
            id, batch_id, order_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'PENDING', ?, ?)
          `,
          randomUUID(),
          batchId,
          orderId,
          now,
          now
        );
      }

      await this.db.exec("COMMIT");
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      id: batchId,
      createdAt: now,
      status: "PROCESSING",
      dryRun,
      totalOrders: orderIds.length,
      successCount: 0,
      failedCount: 0,
      skippedCount: 0
    };
  }

  async updateJobResult(
    batchId: string,
    orderId: string,
    status: FulfillmentJobStatus,
    details: {
      carrier?: string;
      trackingNumber?: string;
      labelUrl?: string;
      collectAmount?: string;
      errorMessage?: string;
    }
  ): Promise<void> {
    await this.db.run(
      `
      UPDATE fulfillment_jobs
      SET status = ?,
          carrier = ?,
          tracking_number = ?,
          label_url = ?,
          collect_amount = ?,
          error_message = ?,
          updated_at = ?
      WHERE batch_id = ? AND order_id = ?
      `,
      status,
      details.carrier ?? null,
      details.trackingNumber ?? null,
      details.labelUrl ?? null,
      details.collectAmount ?? null,
      details.errorMessage ?? null,
      new Date().toISOString(),
      batchId,
      orderId
    );
  }

  async hasSuccessfulJobForOrder(orderId: string): Promise<boolean> {
    const row = await this.db.get<{ count: number }>(
      `
      SELECT COUNT(*) as count
      FROM fulfillment_jobs jobs
      INNER JOIN fulfillment_batches batches
        ON batches.id = jobs.batch_id
      WHERE jobs.order_id = ?
        AND jobs.status = 'SUCCESS'
        AND batches.dry_run = 0
      `,
      orderId
    );
    return (row?.count ?? 0) > 0;
  }

  async supersedeSuccessfulJobsForOrder(orderId: string): Promise<void> {
    await this.db.run(
      `
      UPDATE fulfillment_jobs
      SET status = 'SKIPPED',
          error_message = 'Superseded by a new label generation request.',
          updated_at = ?
      WHERE order_id = ? AND status = 'SUCCESS'
      `,
      new Date().toISOString(),
      orderId
    );
  }

  async getLatestSuccessfulJobForOrder(orderId: string): Promise<FulfillmentJob | null> {
    const row = await this.db.get<FulfillmentJobRow>(
      `
      SELECT
        jobs.id,
        jobs.batch_id,
        jobs.order_id,
        jobs.status,
        jobs.carrier,
        jobs.tracking_number,
        jobs.label_url,
        jobs.collect_amount,
        jobs.error_message,
        jobs.created_at,
        jobs.updated_at
      FROM fulfillment_jobs jobs
      INNER JOIN fulfillment_batches batches
        ON batches.id = jobs.batch_id
      WHERE jobs.order_id = ?
        AND jobs.status = 'SUCCESS'
        AND batches.dry_run = 0
      ORDER BY datetime(jobs.updated_at) DESC
      LIMIT 1
      `,
      orderId
    );

    return row ? this.mapJobRow(row) : null;
  }

  async finalizeBatch(batchId: string): Promise<FulfillmentBatch> {
    const summary = await this.db.get<{
      successCount: number;
      failedCount: number;
      skippedCount: number;
    }>(
      `
      SELECT
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failedCount,
        SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skippedCount
      FROM fulfillment_jobs
      WHERE batch_id = ?
      `,
      batchId
    );

    const successCount = summary?.successCount ?? 0;
    const failedCount = summary?.failedCount ?? 0;
    const skippedCount = summary?.skippedCount ?? 0;

    const finalStatus: FulfillmentBatchStatus =
      failedCount > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";

    await this.db.run(
      `
      UPDATE fulfillment_batches
      SET status = ?, success_count = ?, failed_count = ?, skipped_count = ?
      WHERE id = ?
      `,
      finalStatus,
      successCount,
      failedCount,
      skippedCount,
      batchId
    );

    const batch = await this.getBatch(batchId);
    if (!batch) {
      throw new Error("Batch not found after finalization.");
    }

    return batch;
  }

  async getBatch(batchId: string): Promise<FulfillmentBatch | null> {
    const row = await this.db.get<FulfillmentBatchRow>(
      `
      SELECT
        id,
        created_at,
        status,
        dry_run,
        total_orders,
        success_count,
        failed_count,
        skipped_count
      FROM fulfillment_batches
      WHERE id = ?
      `,
      batchId
    );

    return row ? this.mapBatchRow(row) : null;
  }

  async listBatches(): Promise<FulfillmentBatch[]> {
    const rows = await this.db.all<FulfillmentBatchRow[]>(`
      SELECT id, created_at, status, dry_run, total_orders, success_count, failed_count, skipped_count
      FROM fulfillment_batches
      ORDER BY datetime(created_at) DESC
    `);
    return rows.map((row) => this.mapBatchRow(row));
  }

  async getBatchJobs(batchId: string): Promise<FulfillmentJob[]> {
    const rows = await this.db.all<FulfillmentJobRow[]>(
      `
      SELECT
        id,
        batch_id,
        order_id,
        status,
        carrier,
        tracking_number,
        label_url,
        collect_amount,
        error_message,
        created_at,
        updated_at
      FROM fulfillment_jobs
      WHERE batch_id = ?
      ORDER BY created_at ASC
      `,
      batchId
    );

    return rows.map((row) => this.mapJobRow(row));
  }

  private mapBatchRow(row: FulfillmentBatchRow): FulfillmentBatch {
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status,
      dryRun: row.dry_run === 1,
      totalOrders: row.total_orders,
      successCount: row.success_count,
      failedCount: row.failed_count,
      skippedCount: row.skipped_count
    };
  }

  private mapJobRow(row: FulfillmentJobRow): FulfillmentJob {
    return {
      id: row.id,
      batchId: row.batch_id,
      orderId: row.order_id,
      status: row.status,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      labelUrl: row.label_url,
      collectAmount: row.collect_amount,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
