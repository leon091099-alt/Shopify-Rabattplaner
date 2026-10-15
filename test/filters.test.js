import assert from "node:assert/strict";
import test from "node:test";
import { matchesFilters, normalizeFilters } from "../src/filters.js";

const aputure = {
  productId: "gid://shopify/Product/1001",
  variantId: "gid://shopify/ProductVariant/2001",
  productTitle: "Aputure LS 600d Pro",
  variantTitle: "V-Mount",
  vendor: "Aputure",
  productType: "Dauerleuchten",
  status: "ACTIVE",
  tags: ["Neuware", "Licht"],
  sku: "AP-600D-VM",
  barcode: "4000002001",
  options: [{ name: "Ausführung", value: "V-Mount" }],
  collectionIds: ["gid://shopify/Collection/3001"],
  collectionTitles: ["Dauerleuchten"],
  priceCents: 219900,
  compareCents: null,
  inventory: 4,
};

const bware = {
  ...aputure,
  productId: "gid://shopify/Product/1004",
  variantId: "gid://shopify/ProductVariant/2005",
  productTitle: "Lichtstativ 300 B-Ware",
  vendor: "On-Tec",
  productType: "Stative",
  tags: ["B-Ware"],
  sku: "OT-LS300-B",
  options: [],
  collectionIds: ["gid://shopify/Collection/3004"],
  collectionTitles: ["Stative"],
  priceCents: 7900,
  compareCents: 12900,
  inventory: 0,
};

function filters(input) {
  const normalized = normalizeFilters(input);
  assert.equal(normalized.ok, true, normalized.error);
  return normalized.filters;
}

test("UND, ODER und vorrangige Ausschlüsse", () => {
  const andFilters = filters({
    includeMode: "and",
    include: [
      { field: "vendor", op: "eq", value: "aputure" },
      { field: "product_type", op: "eq", value: "Dauerleuchten" },
    ],
    exclude: [{ field: "tag", op: "eq", value: "B-Ware" }],
  });
  assert.equal(matchesFilters(aputure, andFilters), true);
  assert.equal(matchesFilters(bware, andFilters), false);
  const orFilters = filters({
    includeMode: "or",
    include: [
      { field: "vendor", op: "eq", value: "Hollyland" },
      { field: "sku", op: "eq", value: "OT-LS300-B" },
    ],
  });
  assert.equal(matchesFilters(aputure, orFilters), false);
  assert.equal(matchesFilters(bware, orFilters), true);
  const excluded = filters({
    includeMode: "or",
    include: [{ field: "vendor", op: "in_list", value: "Aputure | On-Tec" }],
    exclude: [{ field: "product_title", op: "contains", value: "b-ware" }],
  });
  assert.equal(matchesFilters(aputure, excluded), true);
  assert.equal(matchesFilters(bware, excluded), false);
});

test("Tags, Listen, IDs, Kollektionen, Optionen, Preise und leere Werte", () => {
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "tag", op: "eq", value: "licht" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "sku", op: "in_list", value: "AP-600D-VM | HL-PYRO7" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "sku", op: "starts_with", value: "ap-" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "product_id", op: "eq", value: "1001" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "variant_id", op: "eq", value: "gid://shopify/ProductVariant/2001" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "collection", op: "eq", value: "3001" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "collection", op: "eq", value: "Dauerleuchten" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "option", op: "eq", value: "Ausführung=V-Mount" }] })), true);
  assert.equal(matchesFilters(bware, filters({ include: [{ field: "option", op: "empty", value: "" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "price", op: "gte", value: "100" }, { field: "price", op: "lte", value: "2.500,00" }] })), true);
  assert.equal(matchesFilters(bware, filters({ include: [{ field: "price", op: "gte", value: "100" }] })), false);
  assert.equal(matchesFilters(aputure, filters({ include: [{ field: "compare_at", op: "empty", value: "" }] })), true);
  assert.equal(matchesFilters(bware, filters({ include: [{ field: "compare_at", op: "not_empty", value: "" }] })), true);
  assert.equal(matchesFilters(bware, filters({ include: [{ field: "inventory", op: "lte", value: "0" }] })), true);
  assert.equal(matchesFilters(aputure, filters({ include: [], exclude: [] })), true);
});
