import { OrderSummary } from "../../models/order";

export function calculateCollectOnDeliveryAmount(order: OrderSummary): number {
  const outstanding = Number(order.amountToCollect);
  if (!Number.isFinite(outstanding) || outstanding <= 0) {
    return 0;
  }

  return Number(outstanding.toFixed(2));
}
