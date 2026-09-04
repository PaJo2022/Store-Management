export type OrderFulfillmentStatus =
  | "PENDING"
  | "GETTING_RATES"
  | "RATES_READY"
  | "PURCHASING"
  | "FULFILLED"
  | "FAILED"
  | "CANCELLED"
  | "RECONCILIATION_REQUIRED";

export interface OrderFulfillment {
  id: string;
  operationId: string;
  shopifyOrderId: string;
  shopifyOrderName: string;
  shopifyOrderNumericId: string | null;
  status: OrderFulfillmentStatus;
  amazonShipmentId: string | null;
  amazonTrackingId: string | null;
  amazonCarrier: string | null;
  amazonService: string | null;
  amazonRateId: string | null;
  amazonRequestToken: string | null;
  labelDocumentType: string | null;
  labelStoragePath: string | null;
  labelContentType: string | null;
  labelGeneratedAt: string | null;
  purchasedAt: string | null;
  estimatedDeliveryStart: string | null;
  estimatedDeliveryEnd: string | null;
  shippingCharge: number | null;
  currency: string | null;
  packageCount: number;
  requestPayloadJson: string | null;
  rateResponseJson: string | null;
  rateGeneratedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}
