import { AppError } from "./errors.js";
import { addLog, setting, transaction } from "./db.js";
import { loadCatalogVariants, newId } from "./catalog.js";
import { matchesFilters, normalizeFilters } from "./filters.js";
import { applyDiscount, formatCents, parseEuroToCents, parsePercentToBasisPoints } from "./money.js";
import { hasExistingDiscount, targetCompareCents } from "./pricing.js";
import { berlinLocalToUtc, formatBerlin } from "./time.js";

export const FRESH_MS = 15 * 60 * 1000;

const CAMPAIGN_STATUSES = ["preview", "scheduled", "active", "reverting", "ended", "missed"];

export function createPreview(db, input, now = new Date()) {
  const name = String(input?.name || "").trim();
  if (name.length < 2 || name.length > 120) throw new AppError("Der Aktionsname braucht 2 bis 120 Zeichen.");
  const start = berlinLocalToUtc(input?.startsAt);
  const end = berlinLocalToUtc(input?.endsAt);
  if (!start.ok) throw new AppError(start.error);
  if (!end.ok) throw new AppError(end.error);
  if (start.utc >= end.utc) throw new AppError("Das Ende muss nach dem Start liegen.");
  if (!["amount", "percent"].includes(input?.discountType)) {
    throw new AppError("Rabattart muss Eurobetrag oder Prozent sein.");
  }
  const parsed = input.discountType === "amount"
    ? parseEuroToCents(input.discountValue)
    : parsePercentToBasisPoints(input.discountValue);
  if (!parsed.ok) throw new AppError(parsed.error);
  const discountValue = input.discountType === "amount" ? parsed.cents : parsed.basisPoints;
  if (!["previous_price", "keep_higher"].includes(input?.compareMode)) {
    throw new AppError("Bitte die Vergleichspreis-Regel wählen.");
  }
  const filters = normalizeFilters(input.filters);
  if (!filters.ok) throw new AppError(filters.error);
  assertFreshCatalog(db, now);

  const rows = [];
  for (const variant of loadCatalogVariants(db)) {
    if (!matchesFilters(variant, filters.filters)) continue;
    const base = {
      variantId: variant.variantId,
      productId: variant.productId,
      productTitle: variant.productTitle,
      variantTitle: variant.variantTitle,
      sku: variant.sku,
      originalPrice: variant.priceCents,
      originalCompare: variant.compareCents,
    };
    if (!Number.isInteger(variant.priceCents)) {
      rows.push({ ...base, originalPrice: 0, state: "skipped", skipReason: "Kein Verkaufspreis.", targetPrice: null, targetCompare: null });
      continue;
    }
    if (!input.includeExisting && hasExistingDiscount(variant.priceCents, variant.compareCents)) {
      rows.push({ ...base, state: "skipped", skipReason: "Bestehender Vergleichspreis.", targetPrice: null, targetCompare: null });
      continue;
    }
    const discount = applyDiscount(variant.priceCents, input.discountType, discountValue);
    if (!discount.ok) {
      rows.push({ ...base, state: "skipped", skipReason: discount.reason, targetPrice: null, targetCompare: null });
      continue;
    }
    rows.push({
      ...base,
      state: "pending",
      skipReason: null,
      targetPrice: discount.priceCents,
      targetCompare: targetCompareCents(variant.priceCents, variant.compareCents, input.compareMode),
    });
  }
  if (!rows.some((row) => row.state === "pending")) {
    throw new AppError("Die Filter ergeben keine Variante mit wirksamer Preisänderung.");
  }

  const id = newId();
  const iso = now.toISOString();
  transaction(db, () => {
    db.prepare(`
      INSERT INTO campaigns (
        id, name, starts_at, ends_at, discount_type, discount_value, compare_mode,
        include_existing, status, filter_json, reference_confirmed, ended_early, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preview', ?, 0, 0, ?, ?)
    `).run(
      id,
      name,
      start.utc,
      end.utc,
      input.discountType,
      discountValue,
      input.compareMode,
      input.includeExisting ? 1 : 0,
      JSON.stringify(filters.filters),
      iso,
      iso,
    );
    const insert = db.prepare(`
      INSERT INTO campaign_variants (
        campaign_id, variant_id, product_id, product_title, variant_title, sku,
        original_price_cents, original_compare_cents, target_price_cents, target_compare_cents,
        state, skip_reason, intent, applied, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)
    `);
    for (const row of rows) {
      insert.run(
        id, row.variantId, row.productId, row.productTitle, row.variantTitle, row.sku || "",
        row.originalPrice, row.originalCompare, row.targetPrice, row.targetCompare,
        row.state, row.skipReason, iso,
      );
    }
    addLog(db, {
      campaignId: id,
      message: `Vorschau erstellt: ${rows.filter((row) => row.state === "pending").length} Varianten werden geändert.`,
      createdAt: iso,
    });
  });
  return getPreview(db, id);
}

export function planCampaign(db, input, now = new Date()) {
  if (!input?.confirmReference) throw new AppError("Die Referenzpreise müssen ausdrücklich bestätigt werden.");
  assertFreshCatalog(db, now);
  const campaign = mustCampaign(db, input.previewId);
  if (campaign.status !== "preview") throw new AppError("Diese Vorschau wurde bereits verwendet oder ist ungültig.");
  if (now.getTime() - Date.parse(campaign.created_at) > FRESH_MS) {
    throw new AppError("Die Vorschau ist älter als 15 Minuten. Bitte neu erstellen.");
  }
  const pending = db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? AND state = 'pending'").all(campaign.id);
  for (const variant of pending) {
    const blocker = blockingCampaign(db, variant.variant_id, campaign);
    if (blocker) {
      throw new AppError(`„${variant.product_title}“ ist bereits durch die Aktion „${blocker.name}“ belegt.`);
    }
  }
  const iso = now.toISOString();
  transaction(db, () => {
    db.prepare("UPDATE campaigns SET status = 'scheduled', reference_confirmed = 1, updated_at = ? WHERE id = ? AND status = 'preview'").run(iso, campaign.id);
    addLog(db, { campaignId: campaign.id, message: "Aktion geplant. Die Produktauswahl ist fest gespeichert.", createdAt: iso });
  });
  return getCampaign(db, campaign.id);
}

export function listCampaigns(db) {
  return db.prepare("SELECT * FROM campaigns WHERE status != 'preview' ORDER BY starts_at DESC, created_at DESC").all().map((campaign) => {
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS variant_count,
        COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
        COALESCE(SUM(CASE WHEN state = 'reduced' THEN 1 ELSE 0 END), 0) AS reduced_count,
        COALESCE(SUM(CASE WHEN state = 'conflict' THEN 1 ELSE 0 END), 0) AS conflict_count,
        COALESCE(SUM(CASE WHEN state = 'restored' THEN 1 ELSE 0 END), 0) AS restored_count
      FROM campaign_variants WHERE campaign_id = ?
    `).get(campaign.id);
    return presentCampaign({ ...campaign, ...counts });
  });
}

export function getCampaign(db, id) {
  const campaign = mustCampaign(db, id);
  if (campaign.status === "preview") throw new AppError("Vorschau nicht gefunden.", 404, "not_found");
  return {
    ...presentCampaign(campaign),
    filters: JSON.parse(campaign.filter_json),
    variants: db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? ORDER BY product_title, variant_title, variant_id").all(id).map(presentVariant),
    logs: db.prepare("SELECT * FROM logs WHERE campaign_id = ? ORDER BY id DESC LIMIT 200").all(id).map((row) => ({
      id: row.id,
      level: row.level,
      message: row.message,
      variantId: row.variant_id,
      createdAt: row.created_at,
    })),
  };
}

export function getPreview(db, id) {
  const campaign = mustCampaign(db, id);
  const variants = db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? ORDER BY state = 'pending' DESC, product_title, variant_title").all(id).map(presentVariant);
  const applicable = variants.filter((variant) => variant.state === "pending");
  const skipped = variants.filter((variant) => variant.state === "skipped");
  return {
    id: campaign.id,
    name: campaign.name,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
    startsAtLabel: formatBerlin(campaign.starts_at),
    endsAtLabel: formatBerlin(campaign.ends_at),
    discountType: campaign.discount_type,
    discountValue: campaign.discount_value,
    discountLabel: discountLabel(campaign),
    compareMode: campaign.compare_mode,
    includeExisting: Boolean(campaign.include_existing),
    counts: { matched: variants.length, applicable: applicable.length, skipped: skipped.length },
    variants: variants.slice(0, 200),
    truncated: variants.length > 200,
  };
}

export function endEarly(db, id, now = new Date()) {
  const campaign = mustCampaign(db, id);
  if (!["scheduled", "active", "reverting"].includes(campaign.status)) {
    throw new AppError("Nur geplante oder laufende Aktionen können vorzeitig beendet werden.");
  }
  const iso = now.toISOString();
  const endsAt = campaign.ends_at < iso ? campaign.ends_at : iso;
  transaction(db, () => {
    db.prepare("UPDATE campaigns SET ends_at = ?, ended_early = 1, updated_at = ? WHERE id = ?").run(endsAt, iso, id);
    addLog(db, { campaignId: id, message: "Vorzeitiges Ende angefordert. Preise werden geschützt zurückgesetzt.", createdAt: iso });
  });
  return getCampaign(db, id);
}

export function keepExternalPrice(db, campaignId, variantId, now = new Date()) {
  const variant = mustVariant(db, campaignId, variantId);
  if (variant.state !== "conflict") throw new AppError("Nur Konflikte können als externer Preis behalten werden.");
  const iso = now.toISOString();
  transaction(db, () => {
    db.prepare(`
      UPDATE campaign_variants
      SET state = 'external_kept', intent = NULL, last_error = NULL, updated_at = ?
      WHERE campaign_id = ? AND variant_id = ?
    `).run(iso, campaignId, variantId);
    addLog(db, {
      campaignId,
      variantId,
      message: "Externer Preis wird behalten. Die App setzt diese Variante nicht zurück.",
      createdAt: iso,
    });
  });
  updateCampaignStatus(db, campaignId, now);
  return getCampaign(db, campaignId);
}

export function campaignCsv(db, id) {
  mustCampaign(db, id);
  const rows = db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? ORDER BY product_title, variant_title").all(id);
  const header = ["Produkt", "Variante", "SKU", "Varianten-ID", "Originalpreis", "Originalvergleich", "Aktionspreis", "Aktionsvergleich", "Zustand", "Hinweis"];
  const lines = [header.join(";")];
  for (const row of rows) {
    lines.push([
      row.product_title,
      row.variant_title,
      row.sku,
      row.variant_id,
      formatCents(row.original_price_cents),
      row.original_compare_cents == null ? "" : formatCents(row.original_compare_cents),
      row.target_price_cents == null ? "" : formatCents(row.target_price_cents),
      row.target_compare_cents == null ? "" : formatCents(row.target_compare_cents),
      row.state,
      row.skip_reason || row.last_error || "",
    ].map(csvCell).join(";"));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function updateCampaignStatus(db, campaignId, now) {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId);
  if (!campaign || campaign.status === "preview") return;
  const variants = db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ?").all(campaignId);
  const iso = now.toISOString();
  const openPrice = variants.some((variant) => variant.state === "reduced" || variant.state === "conflict" || variant.intent);
  const pending = variants.some((variant) => variant.state === "pending");
  let status;
  if (campaign.starts_at > iso) status = "scheduled";
  else if ((openPrice || pending) && campaign.ends_at > iso) status = "active";
  else if (openPrice || pending) status = "reverting";
  else if (variants.some((variant) => variant.applied || variant.state === "restored" || variant.state === "external_kept")) status = "ended";
  else if (campaign.ends_at <= iso) status = "missed";
  else status = "ended";
  if (status !== campaign.status) {
    db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(status, iso, campaignId);
  }
}

export function blockingCampaign(db, variantId, campaign) {
  const rows = db.prepare(`
    SELECT cv.state, cv.intent, c.id, c.name, c.starts_at, c.ends_at
    FROM campaign_variants cv
    JOIN campaigns c ON c.id = cv.campaign_id
    WHERE cv.variant_id = ?
      AND c.id != ?
      AND c.status IN ('scheduled', 'active', 'reverting')
  `).all(variantId, campaign.id);
  return rows.find((row) => {
    if (row.state === "reduced" || row.state === "conflict" || row.intent) return true;
    if (row.state === "pending") return row.starts_at < campaign.ends_at && campaign.starts_at < row.ends_at;
    return false;
  }) || null;
}

function assertFreshCatalog(db, now) {
  const synced = setting(db, "catalog_synced_at");
  if (!synced) throw new AppError("Bitte zuerst den Katalog aktualisieren.");
  if (now.getTime() - Date.parse(synced) > FRESH_MS) {
    throw new AppError("Der Katalogabgleich ist älter als 15 Minuten. Bitte aktualisieren.");
  }
}

function mustCampaign(db, id) {
  if (!id || !/^[-a-z0-9]+$/i.test(String(id))) throw new AppError("Aktion nicht gefunden.", 404, "not_found");
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  if (!campaign) throw new AppError("Aktion nicht gefunden.", 404, "not_found");
  return campaign;
}

function mustVariant(db, campaignId, variantId) {
  mustCampaign(db, campaignId);
  const variant = db.prepare("SELECT * FROM campaign_variants WHERE campaign_id = ? AND variant_id = ?").get(campaignId, variantId);
  if (!variant) throw new AppError("Variante nicht gefunden.", 404, "not_found");
  return variant;
}

function presentCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    status: CAMPAIGN_STATUSES.includes(row.status) ? row.status : row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    startsAtLabel: formatBerlin(row.starts_at),
    endsAtLabel: formatBerlin(row.ends_at),
    discountType: row.discount_type,
    discountValue: row.discount_value,
    discountLabel: discountLabel(row),
    compareMode: row.compare_mode,
    includeExisting: Boolean(row.include_existing),
    endedEarly: Boolean(row.ended_early),
    referenceConfirmed: Boolean(row.reference_confirmed),
    createdAt: row.created_at,
    counts: {
      variants: numberOrNull(row.variant_count),
      pending: numberOrNull(row.pending_count),
      reduced: numberOrNull(row.reduced_count),
      conflict: numberOrNull(row.conflict_count),
      restored: numberOrNull(row.restored_count),
    },
  };
}

function presentVariant(row) {
  return {
    variantId: row.variant_id,
    productId: row.product_id,
    productTitle: row.product_title,
    variantTitle: row.variant_title,
    sku: row.sku,
    originalPriceCents: row.original_price_cents,
    originalCompareCents: row.original_compare_cents,
    targetPriceCents: row.target_price_cents,
    targetCompareCents: row.target_compare_cents,
    state: row.state,
    skipReason: row.skip_reason,
    intent: row.intent,
    applied: Boolean(row.applied),
    lastError: row.last_error,
  };
}

function discountLabel(row) {
  if (row.discount_type === "percent") return `${(row.discount_value / 100).toLocaleString("de-DE")}%`;
  const euros = Math.floor(row.discount_value / 100);
  const cents = String(row.discount_value % 100).padStart(2, "0");
  return `${euros},${cents} €`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[;"\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}
