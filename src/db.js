import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  product_type TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  compare_cents INTEGER,
  inventory INTEGER,
  options_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_collections (
  product_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  PRIMARY KEY (product_id, collection_id)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  discount_type TEXT NOT NULL,
  discount_value INTEGER NOT NULL,
  compare_mode TEXT NOT NULL,
  include_existing INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  reference_confirmed INTEGER NOT NULL DEFAULT 0,
  ended_early INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_variants (
  campaign_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_title TEXT NOT NULL,
  variant_title TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  original_price_cents INTEGER NOT NULL,
  original_compare_cents INTEGER,
  target_price_cents INTEGER,
  target_compare_cents INTEGER,
  state TEXT NOT NULL,
  skip_reason TEXT,
  intent TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, variant_id)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT,
  variant_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduler_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  until_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_campaign_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_logs_campaign ON logs(campaign_id, id);
`;

export function openDatabase(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const lock = db.prepare("SELECT id FROM scheduler_lock WHERE id = 1").get();
  if (!lock) db.prepare("INSERT INTO scheduler_lock (id, owner, until_ms) VALUES (1, NULL, 0)").run();
  return db;
}

export function setting(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? "" : String(value));
}

export function addLog(db, entry) {
  db.prepare(`
    INSERT INTO logs (campaign_id, variant_id, level, message, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    entry.campaignId || null,
    entry.variantId || null,
    entry.level || "info",
    entry.message,
    entry.detail || null,
    entry.createdAt || new Date().toISOString(),
  );
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already closed */ }
    throw error;
  }
}

export function isBusyError(error) {
  return /database is locked|SQLITE_BUSY/i.test(String(error?.message || error));
}
