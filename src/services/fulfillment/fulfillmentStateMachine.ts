import { OrderFulfillmentStatus } from "../../types/orderFulfillment";

const allowedTransitions: Record<OrderFulfillmentStatus, OrderFulfillmentStatus[]> = {
  PENDING: ["GETTING_RATES", "CANCELLED"],
  GETTING_RATES: ["PENDING", "RATES_READY", "FAILED", "CANCELLED"],
  RATES_READY: ["PURCHASING", "GETTING_RATES", "FAILED", "CANCELLED"],
  PURCHASING: ["FULFILLED", "FAILED", "RECONCILIATION_REQUIRED", "CANCELLED"],
  FULFILLED: [],
  FAILED: ["GETTING_RATES", "CANCELLED"],
  CANCELLED: [],
  RECONCILIATION_REQUIRED: ["GETTING_RATES", "CANCELLED"]
};

export function canTransition(
  fromStatus: OrderFulfillmentStatus,
  toStatus: OrderFulfillmentStatus
): boolean {
  return allowedTransitions[fromStatus].includes(toStatus);
}

export function assertValidTransition(
  fromStatus: OrderFulfillmentStatus,
  toStatus: OrderFulfillmentStatus
): void {
  if (!canTransition(fromStatus, toStatus)) {
    throw new Error(`Invalid fulfillment status transition ${fromStatus} -> ${toStatus}`);
  }
}
