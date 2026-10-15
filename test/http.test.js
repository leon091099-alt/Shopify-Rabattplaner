import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { signShopifyIdToken } from "../src/shopify-session.js";

test("Demo ohne Anmeldung: Vorschau, CSV und Rücksetzung", async () => {
  const app = await createApp({
    demo: true,
    dataFile: join(mkdtempSync(join(tmpdir(), "ontec-")), "demo.sqlite"),
    host: "127.0.0.1",
    port: 0,
    startScheduler: false,
  });
  try {
    const page = await fetch(`${app.origin}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.equal(html.includes("Passwort"), false);
    assert.match(html, /data-demo="1"/);

    const headers = { "Content-Type": "application/json", Origin: app.origin };
    const previewResponse = await fetch(`${app.origin}/api/previews`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "HTTP-Test",
        startsAt: "2026-01-01T10:00",
        endsAt: "2027-01-01T10:00",
        discountType: "amount",
        discountValue: "1",
        compareMode: "previous_price",
        includeExisting: false,
        filters: { include: [{ field: "sku", op: "eq", value: "AP-600D-VM" }] },
      }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.counts.applicable, 1);

    const planned = await fetch(`${app.origin}/api/campaigns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ previewId: preview.id, confirmReference: true }),
    });
    assert.equal(planned.status, 201);
    const campaign = await planned.json();
    const again = await fetch(`${app.origin}/api/campaigns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ previewId: preview.id, confirmReference: true }),
    });
    assert.equal(again.status, 400);

    await app.tick(new Date());
    const during = app.db.prepare("SELECT price_cents, compare_cents FROM variants WHERE sku = ?").get("AP-600D-VM");
    assert.equal(during.price_cents, 219800);
    assert.equal(during.compare_cents, 219900);

    const csv = await fetch(`${app.origin}/api/campaigns/${campaign.id}/export.csv`);
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /AP-600D-VM/);

    const ended = await fetch(`${app.origin}/api/campaigns/${campaign.id}/end`, { method: "POST", headers });
    assert.equal(ended.status, 200);
    await app.tick(new Date(Date.now() + 60_000));
    const restored = app.db.prepare("SELECT price_cents, compare_cents FROM variants WHERE sku = ?").get("AP-600D-VM");
    assert.equal(restored.price_cents, 219900);
    assert.equal(restored.compare_cents, null);
  } finally {
    await app.close();
  }
});

test("Shopify-Modus akzeptiert nur ein ID-Token aus dem eigenen Shop", async () => {
  const secret = "test-client-secret";
  const app = await createApp({
    demo: false,
    dataFile: join(mkdtempSync(join(tmpdir(), "ontec-")), "live.sqlite"),
    host: "127.0.0.1",
    port: 0,
    startScheduler: false,
    shopify: { shop: "on-tec.myshopify.com", clientId: "client-id", clientSecret: secret },
  });
  try {
    const open = await fetch(`${app.origin}/api/status`);
    assert.equal(open.status, 401);
    const page = await fetch(`${app.origin}/`);
    const html = await page.text();
    assert.match(html, /shopify-api-key/);
    assert.match(html, /app-bridge\.js/);
    assert.equal(html.includes("Passwort"), false);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors https:\/\/on-tec\.myshopify\.com https:\/\/admin\.shopify\.com/);

    const now = Math.floor(Date.now() / 1000);
    const token = signShopifyIdToken({
      iss: "https://on-tec.myshopify.com/admin",
      dest: "https://on-tec.myshopify.com",
      aud: "client-id",
      sub: "1",
      exp: now + 60,
      nbf: now,
      iat: now,
    }, secret);
    const ok = await fetch(`${app.origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);

    const otherShop = signShopifyIdToken({
      iss: "https://fremd.myshopify.com/admin",
      dest: "https://fremd.myshopify.com",
      aud: "client-id",
      sub: "1",
      exp: now + 60,
      nbf: now,
      iat: now,
    }, secret);
    const foreign = await fetch(`${app.origin}/api/status`, { headers: { Authorization: `Bearer ${otherShop}` } });
    assert.equal(foreign.status, 401);

    const expired = signShopifyIdToken({
      iss: "https://on-tec.myshopify.com/admin",
      dest: "https://on-tec.myshopify.com",
      aud: "client-id",
      sub: "1",
      exp: now - 30,
      nbf: now - 60,
      iat: now - 60,
    }, secret);
    const stale = await fetch(`${app.origin}/api/status`, { headers: { Authorization: `Bearer ${expired}` } });
    assert.equal(stale.status, 401);
  } finally {
    await app.close();
  }
});
