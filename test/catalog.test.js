import assert from "node:assert/strict";
import test from "node:test";
import { replaceCatalog, loadCatalogVariants } from "../src/catalog.js";
import { openDatabase } from "../src/db.js";
import { createShopifyClient } from "../src/shopify.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Produkte, Varianten und Kollektionen werden über Folgeseiten geladen", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).includes("access_token")) return json({ access_token: "token", expires_in: 3600 });
    const body = JSON.parse(options.body);
    calls.push(body.query);
    if (body.query.includes("query Catalog")) {
      if (!body.variables.cursor) {
        return json({ data: { products: { pageInfo: { hasNextPage: true, endCursor: "page-2" }, nodes: [productNode()] } } });
      }
      return json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [secondProduct()] } } });
    }
    if (body.query.includes("MoreVariants")) {
      return json({ data: { product: { variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [variantNode("2002", "Gold-Mount", "2299.00", "2499.00", "AP-600D-GM")] } } } });
    }
    throw new Error(body.query.slice(0, 40));
  };
  const client = createShopifyClient({ shop: "demo", clientId: "id", clientSecret: "secret", fetch: fetchImpl });
  const catalog = await client.fetchCatalog();
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ontec-")), "catalog.sqlite"));
  replaceCatalog(db, { ...catalog, shopName: "On-Tec", currency: "EUR" });
  const variants = loadCatalogVariants(db);
  assert.equal(catalog.products.length, 2);
  assert.equal(variants.length, 3);
  assert.equal(variants.find((variant) => variant.sku === "AP-600D-GM").compareCents, 249900);
  assert.deepEqual(variants.find((variant) => variant.sku === "AP-600D-VM").collectionTitles, ["Dauerleuchten"]);
  assert.equal(calls.filter((query) => query.includes("query Catalog")).length, 2);
  db.close();
});

function productNode() {
  return {
    id: "gid://shopify/Product/1001",
    title: "Aputure LS 600d Pro",
    productType: "Dauerleuchten",
    vendor: "Aputure",
    status: "ACTIVE",
    tags: ["Neuware"],
    collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "gid://shopify/Collection/3001", title: "Dauerleuchten" }] },
    variants: {
      pageInfo: { hasNextPage: true, endCursor: "var-2" },
      nodes: [variantNode("2001", "V-Mount", "2199.00", null, "AP-600D-VM")],
    },
  };
}

function secondProduct() {
  return {
    id: "gid://shopify/Product/1003",
    title: "Hollyland Pyro 7",
    productType: "Monitore",
    vendor: "Hollyland",
    status: "ACTIVE",
    tags: ["Neuware"],
    collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [variantNode("2004", "Standard", "549.00", null, "HL-PYRO7")] },
  };
}

function variantNode(id, title, price, compareAtPrice, sku = `AP-${id}`) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title,
    sku,
    barcode: id,
    price,
    compareAtPrice,
    inventoryQuantity: 3,
    selectedOptions: [{ name: "Ausführung", value: title }],
  };
}

function json(body) {
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
}
