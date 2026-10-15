import { updateSnapshotPrice } from "./catalog.js";
import { updateCampaignStatus } from "./campaigns.js";
import { addLog, isBusyError, setSetting, transaction } from "./db.js";
import { AppError, LockLostError } from "./errors.js";
import { pricesEqual } from "./pricing.js";

export async function runTick(app, now = new Date()) {
  let locked = false;
  try {
    locked = acquireLock(app.db, app.owner, app.lockTtl);
  } catch (error) {
    if (isBusyError(error)) return { ok: true, skipped: "locked" };
    throw error;
  }
  if (!locked) return { ok: true, skipped: "locked" };
  let steps = 0;
  const budget = () => steps >= app.batchSize;
  const spend = () => { steps += 1; };
  try {
    const shop = await app.shop.getShop();
    if (shop.currencyCode !== "EUR") {
      const message = `Shopwährung ist ${shop.currencyCode}. Preise werden nur bei EUR verändert.`;
      rememberTick(app.db, now, "error", message);
      return { ok: false, error: message };
    }
    setSetting(app.db, "shop_name", shop.name);
    setSetting(app.db, "shop_currency", shop.currencyCode);

    const openCampaigns = () => app.db.prepare(`
      SELECT * FROM campaigns
      WHERE status IN ('scheduled', 'active', 'reverting')
      ORDER BY ends_at ASC, starts_at ASC, created_at ASC
    `).all();

    for (const campaign of openCampaigns()) {
      for (const variant of variantsOf(app.db, campaign.id)) {
        if (!variant.intent || budget()) continue;
        await reconcileIntent(app, campaign, variant, now);
        spend();
      }
    }

    for (const campaign of openCampaigns()) {
      if (campaign.ends_at <= now.toISOString()) await finishCampaign(app, campaign, now, budget, spend);
    }

    const iso = now.toISOString();
    const due = app.db.prepare(`
      SELECT * FROM campaigns
      WHERE status IN ('scheduled', 'active') AND starts_at <= ? AND ends_at > ?
      ORDER BY starts_at ASC, created_at ASC
    `).all(iso, iso);
    for (const campaign of due) await applyCampaign(app, campaign, now, budget, spend);

    rememberTick(app.db, now, "ready", "");
    return { ok: true, steps };
  } catch (error) {
    if (error instanceof LockLostError) return { ok: true, skipped: "lock_lost" };
    rememberTick(app.db, now, "error", error.message || "Zeitplanerfehler");
    return { ok: false, error: error.message };
  } finally {
    if (locked) releaseLock(app.db, app.owner);
  }
}

export async function alignVariant(app, campaignId, variantId, now = new Date()) {
  const variant = app.db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? AND variant_id = ?").get(campaignId, variantId);
  if (!variant) throw new AppError("Variante nicht gefunden.", 404, "not_found");
  if (variant.state !== "conflict" || !variant.applied) {
    throw new AppError("Der Aktionspreis kann nur gesetzt werden, wenn die App die ursprüngliche Änderung dokumentiert hat.");
  }
  let locked = false;
  try {
    locked = acquireLock(app.db, app.owner, app.lockTtl);
  } catch (error) {
    if (isBusyError(error)) throw new AppError("Der Zeitplaner schreibt gerade. Bitte kurz erneut versuchen.");
    throw error;
  }
  if (!locked) throw new AppError("Der Zeitplaner schreibt gerade. Bitte kurz erneut versuchen.");
  try {
    assertLock(app);
    setIntent(app.db, variant, "apply", now);
    await app.shop.updateVariant({
      productId: variant.product_id,
      variantId: variant.variant_id,
      priceCents: variant.target_price_cents,
      compareCents: variant.target_compare_cents,
    });
    updateSnapshotPrice(app.db, variant.variant_id, variant.target_price_cents, variant.target_compare_cents);
    markVariant(app.db, variant, { state: "reduced", intent: null, applied: 1, error: null }, now);
    addLog(app.db, {
      campaignId,
      variantId,
      message: "Aktionspreis erneut in Shopify gesetzt. Die Rücksetzung kann beim nächsten Lauf erfolgen.",
      createdAt: now.toISOString(),
    });
    updateCampaignStatus(app.db, campaignId, now);
  } catch (error) {
    if (error instanceof AppError || error instanceof LockLostError) throw error;
    if (error.code === "user_error" || error.userErrors) {
      markVariant(app.db, variant, { state: "conflict", intent: null, error: error.message }, now);
      throw new AppError(error.message || "Shopify hat den Aktionspreis abgelehnt.");
    }
    if (error.sent) {
      app.db.prepare("UPDATE campaign_variants SET last_error = ?, updated_at = ? WHERE campaign_id = ? AND variant_id = ?")
        .run(error.message, now.toISOString(), campaignId, variantId);
      addLog(app.db, { campaignId, variantId, level: "error", message: "Antwort nach dem Setzen des Aktionspreises unklar.", createdAt: now.toISOString() });
      throw new AppError("Die Antwort von Shopify war unklar. Der nächste Lauf prüft den Preis.");
    }
    setIntent(app.db, variant, null, now);
    throw new AppError(error.message || "Shopify hat den Aktionspreis nicht gesetzt.");
  } finally {
    if (locked) releaseLock(app.db, app.owner);
  }
}

async function finishCampaign(app, campaign, now, budget, spend) {
  const variants = variantsOf(app.db, campaign.id);
  const started = variants.some((variant) => variant.applied || variant.state === "reduced" || variant.state === "conflict" || variant.intent);
  if (!started) {
    const iso = now.toISOString();
    transaction(app.db, () => {
      app.db.prepare(`
        UPDATE campaign_variants
        SET state = 'skipped', skip_reason = 'Zeitfenster verpasst', updated_at = ?
        WHERE campaign_id = ? AND state = 'pending'
      `).run(iso, campaign.id);
      app.db.prepare("UPDATE campaigns SET status = 'missed', updated_at = ? WHERE id = ?").run(iso, campaign.id);
      addLog(app.db, { campaignId: campaign.id, message: "Aktion verpasst. Es wurden keine verspäteten Rabatte gesetzt.", createdAt: iso });
    });
    return;
  }
  for (const variant of variantsOf(app.db, campaign.id)) {
    if (budget()) return;
    if (variant.state === "pending") {
      markVariant(app.db, variant, { state: "skipped", error: null, reason: "Nicht mehr gestartet", intent: null }, now);
      continue;
    }
    if (variant.state === "reduced" || variant.intent === "revert") {
      await revertVariant(app, reload(app.db, variant), now);
      spend();
    }
  }
  updateCampaignStatus(app.db, campaign.id, now);
}

async function applyCampaign(app, campaign, now, budget, spend) {
  for (const variant of variantsOf(app.db, campaign.id)) {
    if (budget()) return;
    if (variant.state !== "pending" || variant.intent) continue;
    const ran = await applyVariant(app, campaign, variant, now);
    if (ran) spend();
  }
  updateCampaignStatus(app.db, campaign.id, now);
}

async function reconcileIntent(app, campaign, variant, now) {
  assertLock(app);
  const live = await app.shop.readVariant(variant.variant_id);
  assertLock(app);
  const ended = campaign.ends_at <= now.toISOString();
  if (!live.exists) {
    markVariant(app.db, variant, { state: "deleted", intent: null, error: "Variante in Shopify gelöscht." }, now);
    addLog(app.db, { campaignId: campaign.id, variantId: variant.variant_id, level: "warn", message: "Variante wurde gelöscht und kann nicht zurückgesetzt werden.", createdAt: now.toISOString() });
    return;
  }
  if (variant.intent === "apply") {
    if (same(live, variant, "target")) {
      updateSnapshotPrice(app.db, variant.variant_id, variant.target_price_cents, variant.target_compare_cents);
      markVariant(app.db, variant, { state: "reduced", intent: null, applied: 1, error: null }, now);
      if (ended) await revertVariant(app, reload(app.db, variant), now);
      return;
    }
    if (same(live, variant, "original")) {
      markVariant(app.db, variant, { state: variant.state === "reduced" ? "reduced" : "pending", intent: null, error: null }, now);
      if (!ended && campaign.starts_at <= now.toISOString()) await applyVariant(app, campaign, reload(app.db, variant), now);
      else if (ended) markVariant(app.db, reload(app.db, variant), { state: "skipped", intent: null, reason: "Schreiben nicht erfolgt und Zeitfenster vorbei" }, now);
      return;
    }
    markVariant(app.db, variant, { state: "conflict", error: "Preis entspricht weder Original noch Aktionspreis." }, now);
    return;
  }
  if (variant.intent === "revert") {
    if (same(live, variant, "original")) {
      updateSnapshotPrice(app.db, variant.variant_id, variant.original_price_cents, variant.original_compare_cents);
      markVariant(app.db, variant, { state: "restored", intent: null, error: null }, now);
      return;
    }
    if (same(live, variant, "target")) {
      await writeOriginal(app, reload(app.db, variant), now);
      return;
    }
    markVariant(app.db, variant, { state: "conflict", error: "Preis wurde außerhalb der App geändert." }, now);
  }
}

async function applyVariant(app, campaign, variant, now) {
  if (variant.state !== "pending") return false;
  if (otherOwner(app.db, variant.variant_id, campaign.id)) return false;
  assertLock(app);
  const live = await app.shop.readVariant(variant.variant_id);
  assertLock(app);
  if (!live.exists) {
    markVariant(app.db, variant, { state: "deleted", intent: null, error: "Variante in Shopify gelöscht." }, now);
    return true;
  }
  if (same(live, variant, "target")) {
    updateSnapshotPrice(app.db, variant.variant_id, variant.target_price_cents, variant.target_compare_cents);
    markVariant(app.db, variant, { state: "reduced", intent: null, applied: 1, error: null }, now);
    return true;
  }
  if (!same(live, variant, "original")) {
    markVariant(app.db, variant, { state: "conflict", intent: null, error: "Preis weicht von der Vorschau ab." }, now);
    addLog(app.db, { campaignId: campaign.id, variantId: variant.variant_id, level: "warn", message: "Variante nicht geändert: Preis weicht von der Vorschau ab.", createdAt: now.toISOString() });
    return true;
  }
  setIntent(app.db, variant, "apply", now);
  try {
    await app.shop.updateVariant({
      productId: variant.product_id,
      variantId: variant.variant_id,
      priceCents: variant.target_price_cents,
      compareCents: variant.target_compare_cents,
    });
    updateSnapshotPrice(app.db, variant.variant_id, variant.target_price_cents, variant.target_compare_cents);
    markVariant(app.db, variant, { state: "reduced", intent: null, applied: 1, error: null }, now);
    addLog(app.db, { campaignId: campaign.id, variantId: variant.variant_id, message: "Aktionspreis gesetzt.", createdAt: now.toISOString() });
  } catch (error) {
    handleWriteError(app, variant, error, now, "apply");
  }
  return true;
}

async function revertVariant(app, variant, now) {
  if (!variant || variant.state === "restored" || variant.state === "external_kept" || variant.state === "deleted") return;
  assertLock(app);
  const live = await app.shop.readVariant(variant.variant_id);
  assertLock(app);
  if (!live.exists) {
    markVariant(app.db, variant, { state: "deleted", intent: null, error: "Variante in Shopify gelöscht." }, now);
    addLog(app.db, { campaignId: variant.campaign_id, variantId: variant.variant_id, level: "warn", message: "Gelöschte Variante kann nicht zurückgesetzt werden.", createdAt: now.toISOString() });
    return;
  }
  if (same(live, variant, "original")) {
    updateSnapshotPrice(app.db, variant.variant_id, variant.original_price_cents, variant.original_compare_cents);
    markVariant(app.db, variant, { state: "restored", intent: null, error: null }, now);
    return;
  }
  if (!same(live, variant, "target")) {
    markVariant(app.db, variant, { state: "conflict", error: "Preis wurde außerhalb der App geändert." }, now);
    addLog(app.db, { campaignId: variant.campaign_id, variantId: variant.variant_id, level: "warn", message: "Rücksetzung angehalten: Preis wurde außerhalb der App geändert.", createdAt: now.toISOString() });
    return;
  }
  await writeOriginal(app, variant, now);
}

async function writeOriginal(app, variant, now) {
  assertLock(app);
  setIntent(app.db, variant, "revert", now);
  assertLock(app);
  try {
    await app.shop.updateVariant({
      productId: variant.product_id,
      variantId: variant.variant_id,
      priceCents: variant.original_price_cents,
      compareCents: variant.original_compare_cents,
    });
    updateSnapshotPrice(app.db, variant.variant_id, variant.original_price_cents, variant.original_compare_cents);
    markVariant(app.db, variant, { state: "restored", intent: null, error: null }, now);
    addLog(app.db, { campaignId: variant.campaign_id, variantId: variant.variant_id, message: "Originalpreis wiederhergestellt.", createdAt: now.toISOString() });
  } catch (error) {
    handleWriteError(app, variant, error, now, "revert");
  }
}

function handleWriteError(app, variant, error, now, direction) {
  const iso = now.toISOString();
  if (error.code === "user_error" || error.userErrors) {
    const state = direction === "revert" ? "conflict" : "failed";
    markVariant(app.db, variant, { state, intent: null, error: error.message }, now);
    addLog(app.db, { campaignId: variant.campaign_id, variantId: variant.variant_id, level: "error", message: `Shopify hat die Preisänderung abgelehnt: ${error.message}`, createdAt: iso });
    return;
  }
  if (error.sent) {
    app.db.prepare("UPDATE campaign_variants SET last_error = ?, updated_at = ? WHERE campaign_id = ? AND variant_id = ?")
      .run("Antwort nach dem Schreibzugriff unklar.", iso, variant.campaign_id, variant.variant_id);
    addLog(app.db, {
      campaignId: variant.campaign_id,
      variantId: variant.variant_id,
      level: "warn",
      message: direction === "revert"
        ? "Antwort beim Zurücksetzen verloren. Es wird nicht blind erneut geschrieben."
        : "Antwort nach dem Setzen verloren. Es wird nicht blind erneut geschrieben.",
      createdAt: iso,
    });
    return;
  }
  markVariant(app.db, variant, { intent: null, error: "Netzwerkfehler vor dem Schreiben." }, now);
  addLog(app.db, {
    campaignId: variant.campaign_id,
    variantId: variant.variant_id,
    level: "warn",
    message: "Netzwerkfehler vor dem Schreiben. Der nächste Lauf prüft erneut.",
    createdAt: iso,
  });
}

function otherOwner(db, variantId, campaignId) {
  return db.prepare(`
    SELECT c.id FROM campaign_variants cv
    JOIN campaigns c ON c.id = cv.campaign_id
    WHERE cv.variant_id = ? AND c.id != ?
      AND c.status IN ('scheduled', 'active', 'reverting')
      AND (cv.state IN ('reduced', 'conflict') OR cv.intent IS NOT NULL)
  `).get(variantId, campaignId);
}

function same(live, variant, which) {
  if (which === "target") {
    return pricesEqual(live.priceCents, live.compareCents, variant.target_price_cents, variant.target_compare_cents);
  }
  return pricesEqual(live.priceCents, live.compareCents, variant.original_price_cents, variant.original_compare_cents);
}

function variantsOf(db, campaignId) {
  return db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? ORDER BY variant_id").all(campaignId);
}

function reload(db, variant) {
  return db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? AND variant_id = ?").get(variant.campaign_id, variant.variant_id);
}

function setIntent(db, variant, intent, now) {
  db.prepare("UPDATE campaign_variants SET intent = ?, updated_at = ? WHERE campaign_id = ? AND variant_id = ?")
    .run(intent, now.toISOString(), variant.campaign_id, variant.variant_id);
}

function markVariant(db, variant, change, now) {
  const current = reload(db, variant) || variant;
  db.prepare(`
    UPDATE campaign_variants
    SET state = ?, skip_reason = ?, intent = ?, applied = ?, last_error = ?, updated_at = ?
    WHERE campaign_id = ? AND variant_id = ?
  `).run(
    change.state ?? current.state,
    change.reason === undefined ? current.skip_reason : change.reason,
    change.intent === undefined ? current.intent : change.intent,
    change.applied === undefined ? current.applied : change.applied,
    change.error === undefined ? current.last_error : change.error,
    now.toISOString(),
    variant.campaign_id,
    variant.variant_id,
  );
}

function rememberTick(db, now, status, error) {
  setSetting(db, "last_tick_at", now.toISOString());
  setSetting(db, "last_tick_status", status);
  setSetting(db, "last_tick_error", error || "");
}

export async function withLock(app, fn, ttl = app.lockTtl) {
  let locked = false;
  try {
    locked = acquireLock(app.db, app.owner, ttl);
  } catch (error) {
    if (isBusyError(error)) throw new AppError("Der Zeitplaner schreibt gerade. Bitte kurz erneut versuchen.");
    throw error;
  }
  if (!locked) throw new AppError("Der Zeitplaner schreibt gerade. Bitte kurz erneut versuchen.");
  try {
    return await fn();
  } finally {
    releaseLock(app.db, app.owner);
  }
}

function acquireLock(db, owner, ttl) {
  const now = Date.now();
  return transaction(db, () => {
    const row = db.prepare("SELECT owner, until_ms FROM scheduler_lock WHERE id = 1").get();
    if (row?.owner && row.owner !== owner && row.until_ms >= now) return false;
    db.prepare("UPDATE scheduler_lock SET owner = ?, until_ms = ? WHERE id = 1").run(owner, now + ttl);
    return true;
  });
}

function releaseLock(db, owner) {
  db.prepare("UPDATE scheduler_lock SET owner = NULL, until_ms = 0 WHERE id = 1 AND owner = ?").run(owner);
}

function assertLock(app) {
  const row = app.db.prepare("SELECT owner, until_ms FROM scheduler_lock WHERE id = 1").get();
  if (!row || row.owner !== app.owner || row.until_ms < Date.now()) throw new LockLostError();
  app.db.prepare("UPDATE scheduler_lock SET until_ms = ? WHERE id = 1 AND owner = ?").run(Date.now() + app.lockTtl, app.owner);
}
