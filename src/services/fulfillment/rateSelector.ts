import { ShippingRateOption } from "../amazon/amazonShippingService";

export function selectBestRate(rates: ShippingRateOption[]): ShippingRateOption {
  const eligible = rates.filter((rate) => !rate.requiresAdditionalInputs);
  if (eligible.length === 0) {
    throw new Error(
      "No eligible rates available: all returned services require additional inputs."
    );
  }

  const ranked = [...eligible].sort((a, b) => {
    const aStart = toEpochMs(a.deliveryWindowStart);
    const bStart = toEpochMs(b.deliveryWindowStart);
    if (aStart !== bStart) {
      return aStart - bStart;
    }

    const aEnd = toEpochMs(a.deliveryWindowEnd);
    const bEnd = toEpochMs(b.deliveryWindowEnd);
    if (aEnd !== bEnd) {
      return aEnd - bEnd;
    }

    return a.amount - b.amount;
  });

  return ranked[0];
}

function toEpochMs(value: string | undefined): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}
