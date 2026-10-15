import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoCatalog, replaceCatalog } from "../src/catalog.js";
import { openDatabase } from "../src/db.js";
import { ShopifyError } from "../src/errors.js";

export function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "ontec-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  replaceCatalog(db, demoCatalog());
  return db;
}

export function scriptedShop(seed = demoCatalog()) {
  const prices = new Map(seed.variants.map((variant) => [variant.id, {
    productId: variant.productId,
    priceCents: variant.priceCents,
    compareCents: variant.compareCents,
    exists: true,
  }]));
  return {
    currency: "EUR",
    calls: [],
    script: [],
    async getShop() {
      return { name: "Testshop", currencyCode: this.currency };
    },
    async readVariant(id) {
      const row = prices.get(id);
      if (!row || row.exists === false) return { id, exists: false };
      return { id, exists: true, productId: row.productId, priceCents: row.priceCents, compareCents: row.compareCents };
    },
    async updateVariant(input) {
      this.calls.push({ ...input, compareCents: input.compareCents ?? null });
      const step = this.script.shift();
      if (step === "not_sent") throw new ShopifyError("nicht gesendet", { sent: false, code: "network" });
      if (step === "ambiguous") {
        const current = prices.get(input.variantId);
        prices.set(input.variantId, { ...current, priceCents: input.priceCents, compareCents: input.compareCents ?? null });
        throw new ShopifyError("Antwort verloren", { sent: true, code: "network" });
      }
      if (step === "user_error") {
        throw new ShopifyError("Preis ungültig", { sent: true, applied: false, userErrors: [{ message: "Preis ungültig" }], code: "user_error" });
      }
      const current = prices.get(input.variantId);
      if (!current || current.exists === false) {
        throw new ShopifyError("Variante fehlt", { sent: true, userErrors: [{ message: "fehlt" }], code: "user_error" });
      }
      prices.set(input.variantId, { ...current, priceCents: input.priceCents, compareCents: input.compareCents ?? null });
      return { ok: true };
    },
    setPrice(id, priceCents, compareCents) {
      const current = prices.get(id);
      prices.set(id, { ...current, priceCents, compareCents });
    },
    remove(id) {
      const current = prices.get(id);
      prices.set(id, { ...current, exists: false });
    },
    price(id) {
      return prices.get(id);
    },
  };
}

export function runtime(db, shop, owner = "test") {
  return { db, shop, owner, lockTtl: 60_000, batchSize: 100, demo: false };
}
