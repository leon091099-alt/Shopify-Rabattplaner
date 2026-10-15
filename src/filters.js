import { parseEuroToCents } from "./money.js";

const TEXT_FIELDS = new Set([
  "vendor",
  "product_title",
  "variant_title",
  "product_type",
  "tag",
  "product_status",
  "sku",
  "barcode",
  "product_id",
  "variant_id",
  "collection",
  "option",
]);

const NUMERIC_FIELDS = new Set(["price", "compare_at", "inventory"]);
const TEXT_OPS = new Set(["eq", "contains", "starts_with", "in_list", "empty", "not_empty"]);
const NUMERIC_OPS = new Set(["eq", "gte", "lte", "empty", "not_empty"]);

function fold(value) {
  return String(value ?? "").trim().toLocaleLowerCase("de-DE");
}

function listValues(value) {
  return String(value ?? "")
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function idMatches(gid, query) {
  const left = fold(gid);
  const right = fold(query);
  if (!right) return false;
  if (left === right) return true;
  return left.split("/").pop() === right;
}

function textOf(variant, field) {
  switch (field) {
    case "vendor": return variant.vendor || "";
    case "product_title": return variant.productTitle || "";
    case "variant_title": return variant.variantTitle || "";
    case "product_type": return variant.productType || "";
    case "product_status": return variant.status || "";
    case "sku": return variant.sku || "";
    case "barcode": return variant.barcode || "";
    default: return "";
  }
}

function optionPairs(variant) {
  return (variant.options || []).map((option) => ({
    name: option.name || "",
    value: option.value || "",
    pair: `${option.name || ""}=${option.value || ""}`,
  }));
}

function compareText(candidate, operator, expected) {
  const left = fold(candidate);
  if (operator === "empty") return left.length === 0;
  if (operator === "not_empty") return left.length > 0;
  const right = fold(expected);
  if (operator === "eq") return left === right;
  if (operator === "contains") return right.length > 0 && left.includes(right);
  if (operator === "starts_with") return right.length > 0 && left.startsWith(right);
  return false;
}

function compareList(values, operator, expected) {
  if (operator === "empty") return values.length === 0;
  if (operator === "not_empty") return values.length > 0;
  if (operator === "in_list") {
    const items = listValues(expected);
    return items.some((item) => values.some((value) => fold(value) === fold(item) || idMatches(value, item)));
  }
  return values.some((value) => compareText(value, operator, expected) || (operator === "eq" && idMatches(value, expected)));
}

function compareOption(variant, operator, expected) {
  const pairs = optionPairs(variant);
  if (operator === "empty") return pairs.length === 0;
  if (operator === "not_empty") return pairs.length > 0;
  if (operator === "in_list") {
    return listValues(expected).some((item) => compareOption(variant, item.includes("=") ? "eq" : "eq", item));
  }
  if (String(expected ?? "").includes("=") && operator === "eq") {
    const [name, ...rest] = String(expected).split("=");
    const value = rest.join("=");
    return pairs.some((pair) => fold(pair.name) === fold(name) && fold(pair.value) === fold(value));
  }
  return pairs.some((pair) => compareText(pair.value, operator, expected) || compareText(pair.pair, operator, expected));
}

function numericValue(variant, field) {
  if (field === "price") return variant.priceCents;
  if (field === "compare_at") return variant.compareCents;
  return variant.inventory;
}

function parseNumericExpected(field, value) {
  if (field === "inventory") {
    if (!/^-?\d+$/.test(String(value ?? "").trim())) return { ok: false, error: "Bestand muss eine ganze Zahl sein." };
    return { ok: true, value: Number(value) };
  }
  const euro = parseEuroToCents(value, { allowZero: true });
  if (!euro.ok) return { ok: false, error: "Preisfilter braucht einen Eurobetrag." };
  return { ok: true, value: euro.cents };
}

function matchNumeric(variant, condition) {
  const actual = numericValue(variant, condition.field);
  if (condition.op === "empty") return actual == null;
  if (condition.op === "not_empty") return actual != null;
  if (actual == null) return false;
  const expected = condition.numericValue;
  if (condition.op === "eq") return actual === expected;
  if (condition.op === "gte") return actual >= expected;
  if (condition.op === "lte") return actual <= expected;
  return false;
}

export function normalizeFilters(input) {
  const source = input && typeof input === "object" ? input : {};
  const includeMode = source.includeMode === "or" ? "or" : "and";
  const include = normalizeList(source.include, "Einschluss");
  const exclude = normalizeList(source.exclude, "Ausschluss");
  if (!include.ok) return include;
  if (!exclude.ok) return exclude;
  if (include.conditions.length + exclude.conditions.length > 40) {
    return { ok: false, error: "Höchstens 40 Filterbedingungen." };
  }
  return { ok: true, filters: { includeMode, include: include.conditions, exclude: exclude.conditions } };
}

function normalizeList(list, label) {
  if (list == null) return { ok: true, conditions: [] };
  if (!Array.isArray(list)) return { ok: false, error: `${label}filter müssen eine Liste sein.` };
  const conditions = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return { ok: false, error: "Unvollständige Filterbedingung." };
    const field = String(item.field || "");
    const op = String(item.op || "");
    const value = item.value == null ? "" : String(item.value).trim();
    const known = TEXT_FIELDS.has(field) || NUMERIC_FIELDS.has(field);
    if (!known) return { ok: false, error: `Unbekanntes Filterfeld: ${field || "leer"}.` };
    const allowed = NUMERIC_FIELDS.has(field) ? NUMERIC_OPS : TEXT_OPS;
    if (!allowed.has(op)) return { ok: false, error: `Operator ${op || "leer"} passt nicht zu ${field}.` };
    if (!["empty", "not_empty"].includes(op) && value.length === 0) {
      return { ok: false, error: `Filterwert für ${field} fehlt.` };
    }
    if (value.length > 500) return { ok: false, error: "Filterwert ist zu lang." };
    const condition = { field, op, value };
    if (NUMERIC_FIELDS.has(field) && !["empty", "not_empty"].includes(op)) {
      const parsed = parseNumericExpected(field, value);
      if (!parsed.ok) return parsed;
      condition.numericValue = parsed.value;
    }
    conditions.push(condition);
  }
  return { ok: true, conditions };
}

export function matchesFilters(variant, filters) {
  const include = filters.include || [];
  let included = true;
  if (include.length > 0) {
    const results = include.map((condition) => matchesCondition(variant, condition));
    included = filters.includeMode === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  if (!included) return false;
  return !(filters.exclude || []).some((condition) => matchesCondition(variant, condition));
}

function matchesCondition(variant, condition) {
  if (NUMERIC_FIELDS.has(condition.field)) return matchNumeric(variant, condition);
  if (condition.field === "tag") return compareList(variant.tags || [], condition.op, condition.value);
  if (condition.field === "collection") return compareList([...(variant.collectionIds || []), ...(variant.collectionTitles || [])], condition.op, condition.value);
  if (condition.field === "product_id") return compareList([variant.productId], condition.op, condition.value);
  if (condition.field === "variant_id") return compareList([variant.variantId], condition.op, condition.value);
  if (condition.field === "option") return compareOption(variant, condition.op, condition.value);
  if (condition.op === "in_list") return listValues(condition.value).some((item) => compareText(textOf(variant, condition.field), "eq", item));
  return compareText(textOf(variant, condition.field), condition.op, condition.value);
}

export const FILTER_FIELDS = [
  ["vendor", "Hersteller"],
  ["product_title", "Produkttitel"],
  ["variant_title", "Variantentitel"],
  ["product_type", "Produkttyp"],
  ["tag", "Tag"],
  ["product_status", "Produktstatus"],
  ["sku", "SKU"],
  ["barcode", "Barcode"],
  ["product_id", "Produkt-ID"],
  ["variant_id", "Varianten-ID"],
  ["collection", "Kollektion"],
  ["option", "Variantenoption"],
  ["price", "Verkaufspreis"],
  ["compare_at", "Vergleichspreis"],
  ["inventory", "Bestand"],
];
