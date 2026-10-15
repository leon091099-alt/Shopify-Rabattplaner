import { readSnapshotVariant, updateSnapshotPrice } from "./catalog.js";
import { ShopifyError } from "./errors.js";

export function createDemoShop(db) {
  return {
    mode: "demo",
    async getShop() {
      return { name: "On-Tec Demo", currencyCode: "EUR" };
    },
    async readVariant(id) {
      return readSnapshotVariant(db, id);
    },
    async updateVariant({ variantId, priceCents, compareCents }) {
      const current = readSnapshotVariant(db, variantId);
      if (!current.exists) {
        throw new ShopifyError("Variante nicht gefunden.", {
          sent: true,
          applied: false,
          userErrors: [{ message: "Variante nicht gefunden." }],
          code: "user_error",
        });
      }
      updateSnapshotPrice(db, variantId, priceCents, compareCents);
      return { ok: true };
    },
  };
}
