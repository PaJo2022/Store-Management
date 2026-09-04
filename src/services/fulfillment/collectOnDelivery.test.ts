import test from "node:test";
import assert from "node:assert/strict";
import { calculateCollectOnDeliveryAmount } from "./collectOnDelivery";

const baseOrder = {
  id: "gid://shopify/Order/1",
  name: "#1",
  createdAt: "2026-01-01T00:00:00Z",
  financialStatus: "PENDING",
  fulfillmentStatus: "UNFULFILLED",
  totalPrice: "999.00",
  currencyCode: "INR",
  shippingAddress: {
    address1: "Street",
    city: "Kolkata",
    zip: "700001",
    country: "India"
  },
  customer: null,
  lineItems: [
    {
      title: "Item",
      quantity: 1,
      unitPrice: "999.00",
      currencyCode: "INR"
    }
  ]
};

test("returns outstanding amount for partial payment", () => {
  const amount = calculateCollectOnDeliveryAmount({
    ...baseOrder,
    amountToCollect: "699.00",
    paymentPending: true
  });

  assert.equal(amount, 699);
});

test("returns zero for prepaid orders", () => {
  const amount = calculateCollectOnDeliveryAmount({
    ...baseOrder,
    amountToCollect: "0.00",
    paymentPending: false
  });

  assert.equal(amount, 0);
});
