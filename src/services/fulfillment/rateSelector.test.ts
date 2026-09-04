import test from "node:test";
import assert from "node:assert/strict";
import { selectBestRate } from "./rateSelector";

test("selectBestRate picks earliest delivery window", () => {
  const selected = selectBestRate([
    {
      rateId: "slow-cheap",
      carrierName: "CarrierA",
      serviceName: "Economy",
      serviceId: "ECO",
      amount: 100,
      currencyCode: "INR",
      requiresAdditionalInputs: false,
      deliveryWindowStart: "2026-09-05T10:00:00Z",
      deliveryWindowEnd: "2026-09-05T18:00:00Z"
    },
    {
      rateId: "fast-expensive",
      carrierName: "CarrierB",
      serviceName: "Express",
      serviceId: "EXP",
      amount: 150,
      currencyCode: "INR",
      requiresAdditionalInputs: false,
      deliveryWindowStart: "2026-09-02T08:00:00Z",
      deliveryWindowEnd: "2026-09-02T12:00:00Z"
    }
  ]);

  assert.equal(selected.rateId, "fast-expensive");
});

test("selectBestRate uses lowest price for identical window", () => {
  const selected = selectBestRate([
    {
      rateId: "same-window-high",
      carrierName: "CarrierA",
      serviceName: "A",
      serviceId: "A",
      amount: 200,
      currencyCode: "INR",
      requiresAdditionalInputs: false,
      deliveryWindowStart: "2026-09-03T08:00:00Z",
      deliveryWindowEnd: "2026-09-03T18:00:00Z"
    },
    {
      rateId: "same-window-low",
      carrierName: "CarrierB",
      serviceName: "B",
      serviceId: "B",
      amount: 120,
      currencyCode: "INR",
      requiresAdditionalInputs: false,
      deliveryWindowStart: "2026-09-03T08:00:00Z",
      deliveryWindowEnd: "2026-09-03T18:00:00Z"
    }
  ]);

  assert.equal(selected.rateId, "same-window-low");
});
