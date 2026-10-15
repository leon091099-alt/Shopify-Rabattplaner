import assert from "node:assert/strict";
import test from "node:test";
import { createShopifyClient } from "../src/shopify.js";

test("Client-Credentials-Token wird zwischengespeichert und erneuert", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const calls = [];
  try {
    const fetchImpl = async (url, options) => {
      calls.push(url);
      if (String(url).includes("/oauth/access_token")) {
        return jsonResponse({ access_token: `token-${calls.length}`, expires_in: 86_399 });
      }
      return jsonResponse({ data: { shop: { name: "On-Tec", currencyCode: "EUR" } } });
    };
    const client = createShopifyClient({
      shop: "on-tec-demo.myshopify.com",
      clientId: "id",
      clientSecret: "secret",
      fetch: fetchImpl,
    });
    await client.getShop();
    await client.getShop();
    assert.equal(calls.filter((url) => url.includes("access_token")).length, 1);
    now += 24 * 60 * 60 * 1000;
    await client.getToken();
    assert.equal(calls.filter((url) => url.includes("access_token")).length, 2);
  } finally {
    Date.now = realNow;
  }
});

test("Preisänderung sendet explizites null und wiederholt eine Mutation nicht selbst", async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("access_token")) return jsonResponse({ access_token: "token", expires_in: 3600 });
    bodies.push(JSON.parse(options.body));
    return jsonResponse({
      data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/1" }], userErrors: [] } },
    });
  };
  const client = createShopifyClient({ shop: "demo", clientId: "id", clientSecret: "secret", fetch: fetchImpl });
  await client.updateVariant({ productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1", priceCents: 9000, compareCents: null });
  const variant = bodies[0].variables.variants[0];
  assert.equal(variant.price, "90.00");
  assert.equal(Object.hasOwn(variant, "compareAtPrice"), true);
  assert.equal(variant.compareAtPrice, null);
  assert.equal(bodies.length, 1);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}
