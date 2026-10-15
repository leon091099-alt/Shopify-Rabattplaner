import assert from "node:assert/strict";
import test from "node:test";
import { applyDiscount, parseEuroToCents, parsePercentToBasisPoints, parseShopifyMoney } from "../src/money.js";

test("Cent-Beträge, Rundung und ungültige Werte", () => {
  assert.deepEqual(parseEuroToCents("10"), { ok: true, cents: 1000 });
  assert.deepEqual(parseEuroToCents("10,50 €"), { ok: true, cents: 1050 });
  assert.deepEqual(parseEuroToCents("1.000,50"), { ok: true, cents: 100050 });
  assert.equal(parseEuroToCents("0").ok, false);
  assert.equal(parseEuroToCents("-1").ok, false);
  assert.equal(parseEuroToCents("10,555").ok, false);
  assert.equal(parseEuroToCents("-1").ok, false);
  assert.equal(parsePercentToBasisPoints("10").basisPoints, 1000);
  assert.equal(parsePercentToBasisPoints("10,5%").basisPoints, 1050);
  assert.equal(parsePercentToBasisPoints("0").ok, false);
  assert.equal(parsePercentToBasisPoints("100").ok, false);
  assert.equal(parseShopifyMoney("19.99"), 1999);
  assert.equal(parseShopifyMoney("10.005"), 1001);
  assert.equal(parseShopifyMoney(null), null);
});

test("Euro- und Prozentrabatt mit Untergrenze 0,01 €", () => {
  assert.deepEqual(applyDiscount(10000, "amount", 100), { ok: true, priceCents: 9900 });
  assert.deepEqual(applyDiscount(1999, "percent", 1000), { ok: true, priceCents: 1799 });
  assert.equal(applyDiscount(10000, "amount", 10000).reason, "Rabatt wäre unter 0,01 €.");
  assert.equal(applyDiscount(100, "percent", 50).reason, "Keine wirksame Preisverringerung.");
  assert.equal(applyDiscount(1, "amount", 1).ok, false);
});
