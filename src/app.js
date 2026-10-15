import { randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFacets, seedDemoIfEmpty } from "./catalog.js";
import {
  campaignCsv,
  createPreview,
  endEarly,
  getCampaign,
  keepExternalPrice,
  listCampaigns,
  planCampaign,
} from "./campaigns.js";
import { openDatabase, setSetting, setting } from "./db.js";
import { createDemoShop } from "./demo-shop.js";
import { AppError } from "./errors.js";
import { FILTER_FIELDS } from "./filters.js";
import { alignVariant, runTick, withLock } from "./scheduler.js";
import { createShopifyClient } from "./shopify.js";
import { verifyShopifyIdToken } from "./shopify-session.js";
import { berlinInputValue, formatBerlin } from "./time.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.css", "app.css"],
  ["/app.js", "app.js"],
  ["/favicon.svg", "favicon.svg"],
]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function createApp(options) {
  const demo = Boolean(options.demo);
  const db = openDatabase(options.dataFile || (demo ? "data/demo.sqlite" : "data/on-tec.sqlite"));
  if (demo) {
    seedDemoIfEmpty(db);
    setSetting(db, "catalog_synced_at", new Date().toISOString());
    setSetting(db, "shop_name", setting(db, "shop_name") || "On-Tec Demo");
    setSetting(db, "shop_currency", "EUR");
  }
  if (!setting(db, "last_tick_status")) setSetting(db, "last_tick_status", "ready");
  const runtime = {
    db,
    demo,
    owner: options.owner || randomUUID(),
    lockTtl: options.lockTtl ?? 120_000,
    batchSize: options.batchSize ?? 25,
    origin: options.appOrigin || null,
    shopifyConfig: options.shopify || null,
    client: null,
  };
  runtime.shop = demo ? createDemoShop(db) : {
    mode: "shopify",
    getShop: () => shopify(runtime).getShop(),
    readVariant: (id) => shopify(runtime).readVariant(id),
    updateVariant: (input) => shopify(runtime).updateVariant(input),
    fetchCatalog: () => shopify(runtime).fetchCatalog(),
  };

  const server = createServer((req, res) => {
    handle(runtime, req, res).catch((error) => sendError(runtime, res, error));
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, options.host || "127.0.0.1", resolve));
  const address = server.address();
  runtime.server = server;
  runtime.port = address.port;
  if (!runtime.origin) runtime.origin = `http://127.0.0.1:${address.port}`;
  if (options.startScheduler !== false) {
    runtime.timer = setInterval(() => {
      runTick(runtime).catch(() => {});
    }, options.intervalMs ?? 30_000);
    runtime.timer.unref?.();
    const starter = setTimeout(() => runTick(runtime).catch(() => {}), options.firstTickMs ?? 1000);
    starter.unref?.();
  }
  return {
    db,
    port: runtime.port,
    origin: runtime.origin,
    tick: (now) => runTick(runtime, now),
    async close() {
      clearInterval(runtime.timer);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

async function handle(runtime, req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/healthz") return sendJson(runtime, res, 200, { ok: true, demo: runtime.demo });
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return sendDocument(runtime, res);
  if (req.method === "GET" && FILES.has(url.pathname)) return sendFile(runtime, res, FILES.get(url.pathname));
  if (!url.pathname.startsWith("/api/")) return sendJson(runtime, res, 404, { error: "Nicht gefunden." });

  authorize(runtime, req);
  if (req.method === "GET" && url.pathname === "/api/status") return sendJson(runtime, res, 200, statusPayload(runtime));
  if (req.method === "GET" && url.pathname === "/api/facets") {
    return sendJson(runtime, res, 200, { ...catalogFacets(runtime.db), fields: FILTER_FIELDS });
  }
  if (req.method === "GET" && url.pathname === "/api/campaigns") return sendJson(runtime, res, 200, { campaigns: listCampaigns(runtime.db) });

  const csv = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/export\.csv$/);
  if (req.method === "GET" && csv) {
    const body = campaignCsv(runtime.db, decodeURIComponent(csv[1]));
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"rabattaktion.csv\"",
      ...securityHeaders(runtime),
    });
    res.end(body);
    return;
  }

  const detail = url.pathname.match(/^\/api\/campaigns\/([^/]+)$/);
  if (req.method === "GET" && detail) return sendJson(runtime, res, 200, getCampaign(runtime.db, decodeURIComponent(detail[1])));

  if (req.method === "POST" && url.pathname === "/api/catalog/sync") {
    const facets = await syncCatalog(runtime);
    return sendJson(runtime, res, 200, facets);
  }
  if (req.method === "POST" && url.pathname === "/api/scheduler/tick") {
    const result = await runTick(runtime);
    return sendJson(runtime, res, 200, { ...result, status: statusPayload(runtime) });
  }
  if (req.method === "POST" && url.pathname === "/api/previews") {
    return sendJson(runtime, res, 200, createPreview(runtime.db, await readJson(req)));
  }
  if (req.method === "POST" && url.pathname === "/api/campaigns") {
    return sendJson(runtime, res, 201, planCampaign(runtime.db, await readJson(req)));
  }
  const end = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/end$/);
  if (req.method === "POST" && end) return sendJson(runtime, res, 200, endEarly(runtime.db, decodeURIComponent(end[1])));
  const keep = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/variants\/(.+)\/keep$/);
  if (req.method === "POST" && keep) {
    return sendJson(runtime, res, 200, keepExternalPrice(runtime.db, decodeURIComponent(keep[1]), decodeURIComponent(keep[2])));
  }
  const align = url.pathname.match(/^\/api\/campaigns\/([^/]+)\/variants\/(.+)\/align$/);
  if (req.method === "POST" && align) {
    await alignVariant(runtime, decodeURIComponent(align[1]), decodeURIComponent(align[2]));
    return sendJson(runtime, res, 200, getCampaign(runtime.db, decodeURIComponent(align[1])));
  }
  return sendJson(runtime, res, 404, { error: "Nicht gefunden." });
}

function authorize(runtime, req) {
  if (runtime.demo) return;
  const config = runtime.shopifyConfig || {};
  if (!config.shop || !config.clientId || !config.clientSecret) {
    throw new AppError("Shopify-Zugangsdaten fehlen in der Serverkonfiguration.", 500, "config");
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  }
  verifyShopifyIdToken(header.slice("Bearer ".length).trim(), {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    shop: config.shop,
  });
}

async function syncCatalog(runtime) {
  if (runtime.demo) {
    seedDemoIfEmpty(runtime.db);
    setSetting(runtime.db, "catalog_synced_at", new Date().toISOString());
    setSetting(runtime.db, "shop_name", "On-Tec Demo");
    setSetting(runtime.db, "shop_currency", "EUR");
    return catalogFacets(runtime.db);
  }
  return withLock(runtime, async () => {
    const shop = shopify(runtime);
    const info = await shop.getShop();
    if (info.currencyCode !== "EUR") throw new AppError("Der Shop muss EUR als Währung verwenden. Es wurden keine Preise geändert.");
    const catalog = await shop.fetchCatalog();
    catalog.shopName = info.name;
    catalog.currency = info.currencyCode;
    const { replaceCatalog } = await import("./catalog.js");
    replaceCatalog(runtime.db, catalog);
    return catalogFacets(runtime.db);
  }, 15 * 60 * 1000);
}

function shopify(runtime) {
  if (runtime.client) return runtime.client;
  const config = runtime.shopifyConfig || {};
  if (!config.shop || (!(config.clientId && config.clientSecret) && !config.accessToken)) {
    throw new AppError("Shopify-Zugangsdaten fehlen in der Serverkonfiguration.");
  }
  runtime.client = createShopifyClient({
    shop: config.shop,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    apiVersion: config.apiVersion || "2026-10",
    accessToken: config.accessToken || "",
    fetch: config.fetch,
  });
  return runtime.client;
}

function statusPayload(runtime) {
  const facets = catalogFacets(runtime.db);
  const counts = runtime.db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END), 0) AS scheduled,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'reverting' THEN 1 ELSE 0 END), 0) AS reverting
    FROM campaigns
  `).get();
  const conflicts = runtime.db.prepare(`
    SELECT COUNT(*) AS count FROM campaign_variants cv
    JOIN campaigns c ON c.id = cv.campaign_id
    WHERE cv.state = 'conflict' AND c.status IN ('scheduled', 'active', 'reverting')
  `).get().count;
  const synced = setting(runtime.db, "catalog_synced_at");
  return {
    mode: runtime.demo ? "demo" : "shopify",
    shopName: setting(runtime.db, "shop_name") || (runtime.demo ? "On-Tec Demo" : "Noch nicht verbunden"),
    currency: setting(runtime.db, "shop_currency") || null,
    productCount: facets.productCount,
    variantCount: facets.variantCount,
    catalogSyncedAt: synced,
    catalogSyncedLabel: synced ? formatBerlin(synced) : null,
    nowBerlin: berlinInputValue(),
    endBerlin: berlinInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    scheduler: {
      status: setting(runtime.db, "last_tick_status") || "ready",
      lastTickAt: setting(runtime.db, "last_tick_at"),
      lastTickLabel: setting(runtime.db, "last_tick_at") ? formatBerlin(setting(runtime.db, "last_tick_at")) : null,
      lastError: setting(runtime.db, "last_tick_error") || null,
    },
    campaigns: {
      scheduled: Number(counts.scheduled),
      active: Number(counts.active),
      reverting: Number(counts.reverting),
      conflicts,
    },
  };
}

function securityHeaders(runtime) {
  const shop = embeddedShop(runtime);
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": [
      "default-src 'self'",
      runtime.demo ? "script-src 'self'" : "script-src 'self' https://cdn.shopify.com",
      "style-src 'self' https://cdn.shopify.com",
      "img-src 'self' data: https://cdn.shopify.com",
      "connect-src 'self' https://cdn.shopify.com https://admin.shopify.com",
      shop ? `frame-ancestors https://${shop} https://admin.shopify.com` : "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "Cache-Control": "no-store",
  };
  if (!shop) headers["X-Frame-Options"] = "DENY";
  return headers;
}

function embeddedShop(runtime) {
  if (runtime.demo) return "";
  const shop = runtime.shopifyConfig?.shop;
  if (!shop) return "";
  try {
    return new URL(`https://${String(shop).replace(/^https?:\/\//, "")}`).hostname;
  } catch {
    return "";
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new AppError("Anfrage ist zu groß.", 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Ungültiges JSON.");
  }
}

function sendJson(runtime, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...securityHeaders(runtime) });
  res.end(payload);
}

function sendError(runtime, res, error) {
  if (res.headersSent) return;
  const status = error instanceof AppError ? error.status : 500;
  const message = error instanceof AppError ? error.message : "Interner Fehler.";
  sendJson(runtime, res, status, { error: message });
}

function sendDocument(runtime, res) {
  const apiKey = runtime.demo ? "" : String(runtime.shopifyConfig?.clientId || "");
  const bridge = apiKey
    ? `<meta name="shopify-api-key" content="${escapeHtml(apiKey)}" />\n  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`
    : "";
  const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8")
    .replace("<!--shopify-->", bridge)
    .replace('data-demo="0"', `data-demo="${runtime.demo ? "1" : "0"}"`);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(runtime) });
  res.end(html);
}

function sendFile(runtime, res, name) {
  const path = normalize(join(PUBLIC_DIR, name));
  if (!path.startsWith(PUBLIC_DIR)) return sendJson(runtime, res, 404, { error: "Nicht gefunden." });
  res.writeHead(200, { "Content-Type": TYPES[extname(name)] || "application/octet-stream", ...securityHeaders(runtime) });
  createReadStream(path).pipe(res);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}
