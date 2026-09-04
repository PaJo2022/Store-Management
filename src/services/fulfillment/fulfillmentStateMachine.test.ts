import test from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "./fulfillmentStateMachine";

test("allows valid forward transitions", () => {
  assert.equal(canTransition("PENDING", "GETTING_RATES"), true);
  assert.equal(canTransition("GETTING_RATES", "RATES_READY"), true);
  assert.equal(canTransition("RATES_READY", "PURCHASING"), true);
  assert.equal(canTransition("PURCHASING", "FULFILLED"), true);
});

test("blocks invalid transitions from fulfilled", () => {
  assert.equal(canTransition("FULFILLED", "PURCHASING"), false);
  assert.equal(canTransition("FULFILLED", "GETTING_RATES"), false);
  assert.equal(canTransition("FULFILLED", "FULFILLED"), false);
});
