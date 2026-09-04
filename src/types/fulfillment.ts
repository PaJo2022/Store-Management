export type FulfillmentBatchStatus =
  | "PROCESSING"
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS";

export type FulfillmentJobStatus =
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED";

export interface FulfillmentBatch {
  id: string;
  createdAt: string;
  status: FulfillmentBatchStatus;
  dryRun: boolean;
  totalOrders: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface FulfillmentJob {
  id: string;
  batchId: string;
  orderId: string;
  status: FulfillmentJobStatus;
  carrier: string | null;
  trackingNumber: string | null;
  labelUrl: string | null;
  collectAmount: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
