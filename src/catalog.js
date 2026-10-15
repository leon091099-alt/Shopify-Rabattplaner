import { randomUUID } from "node:crypto";
import { addLog, setSetting, transaction } from "./db.js";

export function replaceCatalog(db, catalog, syncedAt = new Date().toISOString()) {
  transaction(db, () => {
    db.exec("DELETE FROM product_collections");
    db.exec("DELETE FROM variants");
    db.exec("DELETE FROM products");
    db.exec("DELETE FROM collections");
    const insertProduct = db.prepare(`
      INSERT INTO products (id, title, product_type, vendor, status, tags_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertVariant = db.prepare(`
      INSERT INTO variants (id, product_id, title, sku, barcode, price_cents, compare_cents, inventory, options_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCollection = db.prepare("INSERT INTO collections (id, title) VALUES (?, ?)");
    const insertLink = db.prepare("INSERT OR IGNORE INTO product_collections (product_id, collection_id) VALUES (?, ?)");
    for (const product of catalog.products) {
      insertProduct.run(product.id, product.title, product.productType || "", product.vendor || "", product.status || "", JSON.stringify(product.tags || []));
    }
    for (const variant of catalog.variants) {
      insertVariant.run(
        variant.id,
        variant.productId,
        variant.title || "",
        variant.sku || "",
        variant.barcode || "",
        variant.priceCents ?? null,
        variant.compareCents ?? null,
        variant.inventory ?? null,
        JSON.stringify(variant.options || []),
      );
    }
    for (const collection of catalog.collections) insertCollection.run(collection.id, collection.title);
    for (const link of catalog.links) insertLink.run(link.productId, link.collectionId);
    setSetting(db, "catalog_synced_at", syncedAt);
    if (catalog.shopName) setSetting(db, "shop_name", catalog.shopName);
    if (catalog.currency) setSetting(db, "shop_currency", catalog.currency);
  });
}

export function updateSnapshotPrice(db, variantId, priceCents, compareCents) {
  db.prepare("UPDATE variants SET price_cents = ?, compare_cents = ? WHERE id = ?").run(priceCents, compareCents ?? null, variantId);
}

export function loadCatalogVariants(db) {
  const products = new Map(db.prepare("SELECT * FROM products").all().map((row) => [row.id, row]));
  const collections = new Map(db.prepare("SELECT * FROM collections").all().map((row) => [row.id, row]));
  const links = db.prepare("SELECT * FROM product_collections").all();
  const byProduct = new Map();
  for (const link of links) {
    const list = byProduct.get(link.product_id) || [];
    list.push(link.collection_id);
    byProduct.set(link.product_id, list);
  }
  return db.prepare("SELECT * FROM variants ORDER BY product_id, id").all().map((variant) => {
    const product = products.get(variant.product_id);
    const collectionIds = byProduct.get(variant.product_id) || [];
    return {
      variantId: variant.id,
      productId: variant.product_id,
      productTitle: product?.title || "",
      variantTitle: variant.title,
      productType: product?.product_type || "",
      vendor: product?.vendor || "",
      status: product?.status || "",
      tags: JSON.parse(product?.tags_json || "[]"),
      sku: variant.sku,
      barcode: variant.barcode,
      options: JSON.parse(variant.options_json || "[]"),
      collectionIds,
      collectionTitles: collectionIds.map((id) => collections.get(id)?.title || "").filter(Boolean),
      priceCents: variant.price_cents,
      compareCents: variant.compare_cents,
      inventory: variant.inventory,
    };
  });
}

export function catalogFacets(db) {
  const variants = loadCatalogVariants(db);
  const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  return {
    vendors: unique(variants.map((variant) => variant.vendor)),
    types: unique(variants.map((variant) => variant.productType)),
    tags: unique(variants.flatMap((variant) => variant.tags)),
    statuses: unique(variants.map((variant) => variant.status)),
    collections: db.prepare("SELECT id, title FROM collections ORDER BY title COLLATE NOCASE").all(),
    productCount: db.prepare("SELECT COUNT(*) AS count FROM products").get().count,
    variantCount: variants.length,
  };
}

export function readSnapshotVariant(db, variantId) {
  const row = db.prepare("SELECT * FROM variants WHERE id = ?").get(variantId);
  if (!row) return { id: variantId, exists: false };
  return {
    id: row.id,
    exists: true,
    productId: row.product_id,
    priceCents: row.price_cents,
    compareCents: row.compare_cents,
  };
}

export function demoCatalog() {
  const products = [
    product("1001", "Aputure LS 600d Pro", "Aputure", "Dauerleuchten", "ACTIVE", ["Neuware", "Licht"]),
    product("1002", "Aputure Light Dome 150", "Aputure", "Lichtformer", "ACTIVE", ["Neuware"]),
    product("1003", "Hollyland Pyro 7", "Hollyland", "Monitore", "ACTIVE", ["Neuware", "Video"]),
    product("1004", "Lichtstativ 300 B-Ware", "On-Tec", "Stative", "ACTIVE", ["B-Ware"]),
    product("1005", "On-Tec Richtmikrofon", "On-Tec", "Mikrofone", "DRAFT", ["Neuware"]),
  ];
  const variants = [
    variant("2001", "1001", "V-Mount", "AP-600D-VM", 219900, null, 4, [["Ausführung", "V-Mount"]]),
    variant("2002", "1001", "Gold-Mount", "AP-600D-GM", 229900, 249900, 2, [["Ausführung", "Gold-Mount"]]),
    variant("2003", "1002", "Standard", "AP-LD150", 18900, 21900, 11, []),
    variant("2004", "1003", "Standard", "HL-PYRO7", 54900, null, 6, [["Farbe", "Schwarz"]]),
    variant("2005", "1004", "Standard", "OT-LS300-B", 7900, 12900, 1, []),
    variant("2006", "1005", "Standard", "OT-MIC-1", 24900, null, 0, []),
  ];
  const collections = [
    collection("3001", "Dauerleuchten"),
    collection("3002", "Lichtformer"),
    collection("3003", "Video"),
    collection("3004", "Stative"),
    collection("3005", "Ton"),
  ];
  const links = [
    ["1001", "3001"],
    ["1002", "3002"],
    ["1003", "3003"],
    ["1004", "3004"],
    ["1005", "3005"],
  ].map(([productId, collectionId]) => ({ productId: gid("Product", productId), collectionId: gid("Collection", collectionId) }));
  return {
    shopName: "On-Tec Demo",
    currency: "EUR",
    products,
    variants,
    collections,
    links,
  };
}

function product(id, title, vendor, productType, status, tags) {
  return { id: gid("Product", id), title, vendor, productType, status, tags };
}

function collection(id, title) {
  return { id: gid("Collection", id), title };
}

function variant(id, productId, title, sku, priceCents, compareCents, inventory, options) {
  return {
    id: gid("ProductVariant", id),
    productId: gid("Product", productId),
    title,
    sku,
    barcode: `400000${id}`,
    priceCents,
    compareCents,
    inventory,
    options: options.map(([name, value]) => ({ name, value })),
  };
}

function gid(type, id) {
  return `gid://shopify/${type}/${id}`;
}

export function seedDemoIfEmpty(db) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
  if (count > 0) return false;
  replaceCatalog(db, demoCatalog());
  addLog(db, { level: "info", message: "Demo-Katalog mit fünf fiktiven Produkten angelegt.", createdAt: new Date().toISOString() });
  return true;
}

export function newId() {
  return randomUUID();
}
