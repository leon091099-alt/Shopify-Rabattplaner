import assert from "node:assert/strict";
import test from "node:test";
import { hasExistingDiscount, pricesEqual, targetCompareCents } from "../src/pricing.js";

test("Vergleichspreis ersetzen oder höheren bestehenden Wert behalten", () => {
  assert.equal(targetCompareCents(10000, 12000, "previous_price"), 10000);
  assert.equal(targetCompareCents(10000, 12000, "keep_higher"), 12000);
  assert.equal(targetCompareCents(10000, 9500, "keep_higher"), 10000);
  assert.equal(targetCompareCents(10000, null, "keep_higher"), 10000);
  assert.equal(hasExistingDiscount(10000, 12000), true);
  assert.equal(hasExistingDiscount(10000, null), false);
  assert.equal(pricesEqual(10000, null, 10000, null), true);
  assert.equal(pricesEqual(10000, null, 10000, 12000), false);
});
