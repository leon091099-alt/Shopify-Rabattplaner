import assert from "node:assert/strict";
import test from "node:test";
import { createPreview, getCampaign, keepExternalPrice, planCampaign } from "../src/campaigns.js";
import { openDatabase } from "../src/db.js";
import { runTick } from "../src/scheduler.js";
import { runtime, scriptedShop, tempDb } from "./support.js";

const VM = "gid://shopify/ProductVariant/2001";
const GM = "gid://shopify/ProductVariant/2002";

function plan(db, extra = {}) {
  const preview = createPreview(db, {
    name: extra.name || "Testaktion",
    startsAt: extra.startsAt || "2026-01-15T10:00",
    endsAt: extra.endsAt || "2026-01-15T12:00",
    discountType: extra.discountType || "amount",
    discountValue: extra.discountValue ?? "1",
    compareMode: extra.compareMode || "previous_price",
    includeExisting: Boolean(extra.includeExisting),
    filters: extra.filters || { include: [{ field: "sku", op: "eq", value: extra.sku || "AP-600D-VM" }] },
  });
  return planCampaign(db, { previewId: preview.id, confirmReference: true });
}

test("kein verfrühter Start und kein verspäteter Rabatt nach verpasstem Fenster", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  const early = plan(db, { name: "früh" });
  await runTick(runtime(db, shop), new Date("2026-01-15T08:00:00Z"));
  assert.equal(shop.calls.length, 0);
  assert.equal(getCampaign(db, early.id).status, "scheduled");

  const missed = plan(db, { name: "spät", startsAt: "2026-06-01T10:00", endsAt: "2026-06-01T12:00", sku: "HL-PYRO7" });
  await runTick(runtime(db, shop), new Date("2026-06-01T12:00:00Z"));
  assert.equal(shop.calls.length, 0);
  assert.equal(getCampaign(db, missed.id).status, "missed");
  db.close();
});

test("überlappende Pläne werden blockiert, angrenzende Fenster laufen nacheinander", async () => {
  const db = tempDb();
  plan(db, { name: "erste" });
  assert.throws(() => plan(db, { name: "doppelt", startsAt: "2026-01-15T11:00", endsAt: "2026-01-15T13:00" }), /belegt/);
  const shop = scriptedShop();
  const second = plan(db, { name: "danach", startsAt: "2026-01-15T12:00", endsAt: "2026-01-15T14:00", discountValue: "2" });
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  assert.equal(shop.price(VM).priceCents, 219800);
  assert.equal(getCampaign(db, second.id).status, "scheduled");
  await runTick(runtime(db, shop), new Date("2026-01-15T11:00:00Z"));
  assert.equal(shop.price(VM).priceCents, 219700);
  assert.equal(shop.price(VM).compareCents, 219900);
  db.close();
});

test("Konflikt vor dem Start und beim Zurücksetzen, kein stilles Überschreiben", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  const campaign = plan(db);
  shop.setPrice(VM, 100, null);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  assert.equal(shop.calls.length, 0);
  let detail = getCampaign(db, campaign.id);
  assert.equal(detail.variants.find((variant) => variant.variantId === VM).state, "conflict");
  keepExternalPrice(db, campaign.id, VM);
  assert.equal(shop.price(VM).priceCents, 100);

  const live = plan(db, { name: "live", startsAt: "2026-02-01T10:00", endsAt: "2026-02-01T12:00" });
  shop.setPrice(VM, 219900, null);
  await runTick(runtime(db, shop), new Date("2026-02-01T10:00:00Z"));
  shop.setPrice(VM, 111, 222);
  await runTick(runtime(db, shop), new Date("2026-02-01T11:00:00Z"));
  detail = getCampaign(db, live.id);
  assert.equal(detail.variants.find((variant) => variant.variantId === VM).state, "conflict");
  assert.equal(shop.price(VM).priceCents, 111);
  db.close();
});

test("Netzwerkfehler vor dem Schreiben wird wiederholt, verlorene Antworten nicht", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  shop.script.push("not_sent");
  const campaign = plan(db);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  assert.equal(shop.calls.length, 1);
  assert.equal(shop.price(VM).priceCents, 219900);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:05:00Z"));
  assert.equal(shop.calls.length, 2);
  assert.equal(shop.price(VM).priceCents, 219800);

  shop.script.push("ambiguous");
  await runTick(runtime(db, shop), new Date("2026-01-15T11:00:00Z"));
  const callsAfterLostRevert = shop.calls.length;
  assert.equal(shop.price(VM).priceCents, 219900);
  assert.equal(shop.price(VM).compareCents, null);
  await runTick(runtime(db, shop), new Date("2026-01-15T11:05:00Z"));
  assert.equal(shop.calls.length, callsAfterLostRevert);
  assert.equal(getCampaign(db, campaign.id).status, "ended");
  db.close();
});

test("verlorene Antwort nach dem Setzen wird ohne zweiten Schreibzugriff übernommen", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  shop.script.push("ambiguous");
  const campaign = plan(db);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  assert.equal(shop.calls.length, 1);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:05:00Z"));
  assert.equal(shop.calls.length, 1);
  assert.equal(getCampaign(db, campaign.id).variants.find((variant) => variant.variantId === VM).state, "reduced");
  db.close();
});

test("Neustart setzt eine gespeicherte Schreibabsicht korrekt um", async () => {
  const db = tempDb();
  const file = db.prepare("PRAGMA database_list").get().file;
  const shop = scriptedShop();
  shop.script.push("ambiguous");
  plan(db);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  db.close();
  const reopened = openDatabase(file);
  await runTick(runtime(reopened, shop, "restart"), new Date("2026-01-15T10:10:00Z"));
  assert.equal(shop.calls.length, 1);
  const row = reopened.prepare("SELECT state, intent FROM campaign_variants WHERE variant_id = ?").get(VM);
  assert.equal(row.state, "reduced");
  assert.equal(row.intent, null);
  reopened.close();
});

test("unterschiedliche Variantenpreise werden unabhängig zurückgesetzt", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  const preview = createPreview(db, {
    name: "beide",
    startsAt: "2026-01-15T10:00",
    endsAt: "2026-01-15T12:00",
    discountType: "percent",
    discountValue: "10",
    compareMode: "keep_higher",
    includeExisting: true,
    filters: { include: [{ field: "product_id", op: "eq", value: "1001" }] },
  });
  const vm = preview.variants.find((variant) => variant.variantId === VM);
  const gm = preview.variants.find((variant) => variant.variantId === GM);
  assert.equal(vm.targetPriceCents, 197910);
  assert.equal(vm.targetCompareCents, 219900);
  assert.equal(gm.targetPriceCents, 206910);
  assert.equal(gm.targetCompareCents, 249900);
  planCampaign(db, { previewId: preview.id, confirmReference: true });
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  await runTick(runtime(db, shop), new Date("2026-01-15T11:00:00Z"));
  assert.equal(shop.price(VM).priceCents, 219900);
  assert.equal(shop.price(VM).compareCents, null);
  assert.equal(shop.price(GM).priceCents, 229900);
  assert.equal(shop.price(GM).compareCents, 249900);
  db.close();
});

test("verlorene Sperre verhindert weitere Schreibzugriffe", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  plan(db);
  shop.readVariant = async function steal(id) {
    db.prepare("UPDATE scheduler_lock SET owner = ?, until_ms = ? WHERE id = 1").run("fremd", Date.now() + 60_000);
    return scriptedShop.prototype && false
      ? null
      : { id, exists: true, productId: "gid://shopify/Product/1001", priceCents: 219900, compareCents: null };
  };
  const result = await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  assert.equal(result.skipped, "lock_lost");
  assert.equal(shop.calls.length, 0);
  assert.equal(shop.price(VM).priceCents, 219900);
  db.close();
});

test("gelöschte Varianten werden nicht wiederhergestellt", async () => {
  const db = tempDb();
  const shop = scriptedShop();
  const campaign = plan(db);
  await runTick(runtime(db, shop), new Date("2026-01-15T10:00:00Z"));
  shop.remove(VM);
  await runTick(runtime(db, shop), new Date("2026-01-15T11:00:00Z"));
  const variant = getCampaign(db, campaign.id).variants.find((item) => item.variantId === VM);
  assert.equal(variant.state, "deleted");
  assert.equal(shop.calls.filter((call) => call.priceCents === 219900).length, 0);
  db.close();
});

test("Nicht-EUR-Shops und userErrors blockieren die Preisänderung", async () => {
  const db = tempDb();
  const foreign = scriptedShop();
  foreign.currency = "USD";
  plan(db, { name: "usd" });
  const blocked = await runTick(runtime(db, foreign), new Date("2026-01-15T10:00:00Z"));
  assert.equal(blocked.ok, false);
  assert.equal(foreign.calls.length, 0);

  const shop = scriptedShop();
  shop.script.push("user_error");
  const campaign = plan(db, { name: "fehler", startsAt: "2026-03-01T10:00", endsAt: "2026-03-01T12:00" });
  await runTick(runtime(db, shop), new Date("2026-03-01T09:30:00Z"));
  assert.equal(getCampaign(db, campaign.id).variants.find((variant) => variant.variantId === VM).state, "failed");
  assert.equal(shop.price(VM).priceCents, 219900);
  db.close();
});
