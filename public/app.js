const root = document.querySelector("#root");
const state = {
  mode: null,
  view: "overview",
  status: null,
  facets: null,
  campaigns: [],
  detail: null,
  preview: null,
  error: "",
  busy: false,
  draft: null,
};

const STATUS = {
  scheduled: "Geplant",
  active: "Aktiv",
  reverting: "Rücksetzung",
  ended: "Beendet",
  missed: "Verpasst",
};
const VARIANT = {
  pending: "Wartet",
  reduced: "Reduziert",
  restored: "Wiederhergestellt",
  skipped: "Übersprungen",
  conflict: "Konflikt",
  deleted: "Gelöscht",
  external_kept: "Extern behalten",
  failed: "Fehler",
};
const FIELDS = [
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
const TEXT_OPS = [["eq", "ist genau"], ["contains", "enthält"], ["starts_with", "beginnt mit"], ["in_list", "in Liste"], ["empty", "ist leer"], ["not_empty", "ist nicht leer"]];
const NUMBER_OPS = [["gte", "mindestens"], ["lte", "höchstens"], ["eq", "ist genau"], ["empty", "ist leer"], ["not_empty", "ist nicht leer"]];

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  captureDraft();
  const action = button.dataset.action;
  try {
    if (action === "nav") { state.view = button.dataset.view; state.error = ""; await show(); }
    else if (action === "sync") { state.busy = true; render(); await api("/api/catalog/sync", { method: "POST" }); await refresh(); }
    else if (action === "tick") { state.busy = true; render(); await api("/api/scheduler/tick", { method: "POST" }); await refresh(); if (state.detail) state.detail = await api(`/api/campaigns/${state.detail.id}`); }
    else if (action === "add-filter") state.draft[button.dataset.side].push({ field: "vendor", op: "eq", value: "" });
    else if (action === "remove-filter") state.draft[button.dataset.side].splice(Number(button.dataset.index), 1);
    else if (action === "preset-brands") state.draft.include.push({ field: "vendor", op: "in_list", value: "Aputure | Hollyland" });
    else if (action === "preset-bware") {
      state.draft.exclude.push({ field: "product_title", op: "contains", value: "B-Ware" });
      state.draft.exclude.push({ field: "tag", op: "eq", value: "B-Ware" });
    }
    else if (action === "open") { state.detail = await api(`/api/campaigns/${button.dataset.id}`); state.view = "detail"; state.error = ""; }
    else if (action === "csv") { await downloadCsv(state.detail.id); }
    else if (action === "end") {
      if (!confirm("Aktion vorzeitig beenden und die Preise zurücksetzen?")) return;
      state.detail = await api(`/api/campaigns/${state.detail.id}/end`, { method: "POST" });
    }
    else if (action === "keep") state.detail = await api(`/api/campaigns/${state.detail.id}/variants/${encodeURIComponent(button.dataset.id)}/keep`, { method: "POST" });
    else if (action === "align") state.detail = await api(`/api/campaigns/${state.detail.id}/variants/${encodeURIComponent(button.dataset.id)}/align`, { method: "POST" });
    else return;
    state.busy = false;
    state.error = "";
    render();
  } catch (error) {
    state.busy = false;
    state.error = error.message;
    render();
  }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  try {
    if (form.dataset.action === "preview") {
      readDraft(form);
      state.busy = true;
      render();
      state.preview = await api("/api/previews", { method: "POST", body: payloadFromDraft() });
    }
    if (form.dataset.action === "plan") {
      if (!state.preview) throw new Error("Bitte zuerst eine Vorschau erstellen.");
      state.busy = true;
      render();
      const campaign = await api("/api/campaigns", { method: "POST", body: { previewId: state.preview.id, confirmReference: true } });
      state.preview = null;
      state.detail = campaign;
      state.view = "detail";
      await refresh();
    }
    state.busy = false;
    state.error = "";
    render();
  } catch (error) {
    state.busy = false;
    state.error = error.message;
    render();
  }
});

document.addEventListener("input", (event) => {
  const row = event.target.closest("[data-filter-row]");
  if (!row || !state.draft || event.target.dataset.key !== "value") return;
  state.draft[row.dataset.side][Number(row.dataset.index)].value = event.target.value;
});

document.addEventListener("change", (event) => {
  const row = event.target.closest("[data-filter-row]");
  if (!row || !state.draft) return;
  const condition = state.draft[row.dataset.side][Number(row.dataset.index)];
  condition[event.target.dataset.key] = event.target.value;
  if (event.target.dataset.key === "field" || event.target.dataset.key === "op") {
    captureDraft();
    if (event.target.dataset.key === "field") {
      const ops = opsFor(condition.field);
      if (!ops.some(([value]) => value === condition.op)) condition.op = ops[0][0];
    }
    render();
  }
});

await boot();

async function boot() {
  state.demo = root.dataset.demo === "1";
  if (!state.demo && typeof shopify === "undefined") {
    renderGate();
    return;
  }
  try {
    await refresh();
    render();
  } catch (error) {
    state.error = error.message;
    if (state.demo) render();
    else renderGate(error.message);
  }
}

async function show() {
  if (state.view === "overview" || state.view === "campaigns") await refresh();
  if (state.view === "editor" && !state.draft) resetDraft();
  if (state.view === "editor" && !state.facets) state.facets = await api("/api/facets");
}

async function refresh() {
  state.status = await api("/api/status");
  state.campaigns = (await api("/api/campaigns")).campaigns;
  if (state.view === "editor") state.facets = await api("/api/facets");
}

function resetDraft() {
  state.draft = {
    name: "Aktionspreise",
    startsAt: state.status?.nowBerlin || "",
    endsAt: state.status?.endBerlin || "",
    discountType: "percent",
    discountValue: "10",
    compareMode: "previous_price",
    includeExisting: false,
    includeMode: "and",
    include: [{ field: "product_status", op: "eq", value: "ACTIVE" }],
    exclude: [],
  };
  state.preview = null;
}

function captureDraft() {
  const form = document.querySelector("form[data-action='preview']");
  if (form && state.draft) readDraft(form);
}

function readDraft(form) {
  const data = new FormData(form);
  state.draft.name = String(data.get("name") || "");
  state.draft.startsAt = String(data.get("startsAt") || "");
  state.draft.endsAt = String(data.get("endsAt") || "");
  state.draft.discountType = String(data.get("discountType") || "percent");
  state.draft.discountValue = String(data.get("discountValue") || "");
  state.draft.compareMode = String(data.get("compareMode") || "previous_price");
  state.draft.includeExisting = data.get("includeExisting") === "on";
  state.draft.includeMode = String(data.get("includeMode") || "and");
}

function payloadFromDraft() {
  return {
    name: state.draft.name,
    startsAt: state.draft.startsAt,
    endsAt: state.draft.endsAt,
    discountType: state.draft.discountType,
    discountValue: state.draft.discountValue,
    compareMode: state.draft.compareMode,
    includeExisting: state.draft.includeExisting,
    filters: {
      includeMode: state.draft.includeMode,
      include: state.draft.include,
      exclude: state.draft.exclude,
    },
  };
}

async function api(path, options = {}) {
  const headers = {};
  let body;
  if (options.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { method: options.method || "GET", headers, body });
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }
  if (!response.ok) throw new Error(data.error || "Die Anfrage ist fehlgeschlagen.");
  return data;
}

async function downloadCsv(id) {
  const response = await fetch(`/api/campaigns/${encodeURIComponent(id)}/export.csv`);
  if (!response.ok) throw new Error("CSV konnte nicht geladen werden.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "rabattaktion.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function render() {
  if (state.view === "editor" && !state.draft) resetDraft();
  root.innerHTML = shell(viewContent());
}

function renderGate(message = "") {
  root.innerHTML = `
    <main class="login">
      <section class="login-hero">
        <div>
          <div class="brand-kicker">ON-TEC</div>
          <h1>Rabatte, die pünktlich wieder gehen.</h1>
          <p>Verkaufspreis und Vergleichspreis für einen Zeitraum setzen. Danach die vorherigen Werte exakt zurückholen.</p>
        </div>
        <p class="hero-note">Der Zeitplaner läuft auf dem Server. Der Browser muss dafür nicht offen bleiben.</p>
      </section>
      <section class="login-panel">
        <div class="login-card stack">
          <h2>Im Shopify-Admin öffnen</h2>
          <p class="lede">Diese App hat keine eigene Anmeldung. Du öffnest sie in deinem Shop unter Apps.</p>
          ${message ? `<div class="alert" role="alert">${esc(message)}</div>` : ""}
        </div>
      </section>
    </main>`;
}

function shell(content) {
  const status = state.status;
  const mode = status?.mode === "shopify" ? `<span class="pill live">Shopify · Admin</span>` : `<span class="pill demo">Demo · fiktiver Katalog</span>`;
  const scheduler = status?.scheduler?.status === "error"
    ? `<span class="pill">Zeitplaner: Fehler</span>`
    : `<span class="pill">Zeitplaner: Bereit${status?.scheduler?.lastTickLabel ? ` · ${esc(status.scheduler.lastTickLabel)}` : ""}</span>`;
  return `
    <div class="shell">
      <aside class="rail">
        <div>
          <div class="brand-kicker">ON-TEC</div>
          <div class="brand-name">Rabattplaner</div>
        </div>
        <nav class="nav">
          ${nav("overview", "Übersicht")}
          ${nav("editor", "Neue Aktion")}
          ${nav("campaigns", "Aktionen")}
        </nav>
        <div class="rail-foot">
          <button class="btn ghost small" type="button" data-action="sync" ${state.busy ? "disabled" : ""}>Katalog aktualisieren</button>
        </div>
      </aside>
      <main class="main">
        <header class="top">
          <div>
            <div class="crumbs">${esc(status?.shopName || "On-Tec")}</div>
            <h1>${title()}</h1>
          </div>
          <div class="pills">${mode}${scheduler}</div>
        </header>
        ${state.error ? `<div class="alert gap" role="alert">${esc(state.error)}</div>` : ""}
        ${content}
      </main>
    </div>`;
}

function title() {
  if (state.view === "editor") return "Neue Aktion";
  if (state.view === "campaigns") return "Aktionen";
  if (state.view === "detail") return esc(state.detail?.name || "Aktion");
  return "Übersicht";
}

function nav(view, label) {
  return `<button type="button" class="${state.view === view ? "active" : ""}" data-action="nav" data-view="${view}">${label}</button>`;
}

function viewContent() {
  if (state.view === "editor") return editorView();
  if (state.view === "campaigns") return campaignList();
  if (state.view === "detail") return detailView();
  return overview();
}

function overview() {
  const status = state.status || {};
  const upcoming = state.campaigns.filter((campaign) => ["scheduled", "active", "reverting"].includes(campaign.status)).slice(0, 5);
  return `
    <section class="grid">
      ${stat("Produkte", status.productCount ?? "—")}
      ${stat("Varianten", status.variantCount ?? "—")}
      ${stat("Aktive Aktionen", status.campaigns?.active ?? 0)}
      ${stat("Konflikte", status.campaigns?.conflicts ?? 0)}
    </section>
    <section class="section grid overview-grid">
      <article class="panel">
        <div class="section-head">
          <h2>Laufend und geplant</h2>
          <button class="btn small" type="button" data-action="nav" data-view="editor">Neue Aktion</button>
        </div>
        ${upcoming.length ? campaignTable(upcoming) : `<p class="empty">Noch keine geplante Aktion. Der Katalog enthält ${esc(status.variantCount || 0)} Varianten.</p>`}
      </article>
      <article class="panel stack">
        <h2>Zeitplaner</h2>
        <p class="help">Prüfung alle 30 Sekunden. Start ist inklusive, Ende exklusiv, Zeitzone Europe/Berlin.</p>
        <p>Letzter Lauf: <strong>${esc(status.scheduler?.lastTickLabel || "noch keiner")}</strong></p>
        ${status.scheduler?.lastError ? `<div class="alert">${esc(status.scheduler.lastError)}</div>` : ""}
        <p class="help">Katalogstand: ${esc(status.catalogSyncedLabel || "nicht abgeglichen")}</p>
        <button class="btn secondary" type="button" data-action="tick" ${state.busy ? "disabled" : ""}>Jetzt prüfen</button>
        ${status.mode === "demo" ? `<p class="note">Demo ohne Shopify. Es werden nur fünf fiktive Produkte verändert.</p>` : `<p class="note">Änderungen gelten für die Standardpreise des Shops, nicht für separate Markets-Preislisten.</p>`}
      </article>
    </section>`;
}

function stat(label, value) {
  return `<article class="card"><span>${label}</span><strong>${esc(value)}</strong></article>`;
}

function campaignList() {
  return `<section class="panel">${state.campaigns.length ? campaignTable(state.campaigns) : `<p class="empty">Noch keine Aktion geplant.</p>`}</section>`;
}

function campaignTable(campaigns) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Aktion</th><th>Zeitraum</th><th>Rabatt</th><th>Status</th></tr></thead>
    <tbody>
      ${campaigns.map((campaign) => `<tr>
        <td><button class="list-button" type="button" data-action="open" data-id="${esc(campaign.id)}"><strong>${esc(campaign.name)}</strong></button></td>
        <td>${esc(campaign.startsAtLabel)} – ${esc(campaign.endsAtLabel)}</td>
        <td class="money">${esc(campaign.discountLabel)}</td>
        <td>${badge(campaign.status, STATUS[campaign.status] || campaign.status)}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>`;
}

function editorView() {
  const draft = state.draft;
  const facets = state.facets;
  return `
    <div class="editor">
      <div class="stack">
        <form id="campaign-form" data-action="preview" class="stack">
        <section class="panel stack">
          <h2>Zeit und Rabatt</h2>
          <div class="form-grid">
            <div class="span-2"><label for="name">Aktionsname</label><input id="name" name="name" required value="${esc(draft.name)}"></div>
            <div><label for="startsAt">Start, Europe/Berlin</label><input id="startsAt" name="startsAt" type="datetime-local" required value="${esc(draft.startsAt)}"></div>
            <div><label for="endsAt">Ende, Europe/Berlin</label><input id="endsAt" name="endsAt" type="datetime-local" required value="${esc(draft.endsAt)}"></div>
            <div>
              <label>Rabatt</label>
              <div class="choice">
                ${radio("discountType", "percent", "Prozent", draft.discountType)}
                ${radio("discountType", "amount", "Euro", draft.discountType)}
              </div>
            </div>
            <div><label for="discountValue">Wert</label><input id="discountValue" name="discountValue" required value="${esc(draft.discountValue)}" inputmode="decimal"></div>
            <div class="span-2">
              <label>Vergleichspreis während der Aktion</label>
              <div class="choice">
                ${radio("compareMode", "previous_price", "Bisheriger Verkaufspreis", draft.compareMode)}
                ${radio("compareMode", "keep_higher", "Höheren Vergleich behalten", draft.compareMode)}
              </div>
            </div>
            <label class="check span-2"><input type="checkbox" name="includeExisting" ${draft.includeExisting ? "checked" : ""}> Varianten mit bestehendem Vergleichspreis einbeziehen</label>
          </div>
        </section>
        <section class="panel stack">
          <div class="split"><h2>Einschließen</h2>
            <select name="includeMode">
              <option value="and" ${draft.includeMode === "and" ? "selected" : ""}>alle Bedingungen</option>
              <option value="or" ${draft.includeMode === "or" ? "selected" : ""}>eine Bedingung reicht</option>
            </select>
          </div>
          <p class="help">Ohne Einschlussbedingung gilt der ganze Katalog. Die Oberfläche startet mit aktiven Produkten.</p>
          <div class="filters">${draft.include.map((condition, index) => filterRow("include", condition, index)).join("")}</div>
          <div class="actions">
            <button class="btn secondary small" type="button" data-action="add-filter" data-side="include">Bedingung</button>
            <button class="btn secondary small" type="button" data-action="preset-brands">Aputure und Hollyland</button>
          </div>
        </section>
        <section class="panel stack">
          <h2>Ausschließen</h2>
          <p class="help">Jede passende Ausschlussbedingung reicht. Ausschlüsse haben Vorrang. Listen mit dem senkrechten Strich trennen.</p>
          <div class="filters">${draft.exclude.map((condition, index) => filterRow("exclude", condition, index)).join("")}</div>
          <div class="actions">
            <button class="btn secondary small" type="button" data-action="add-filter" data-side="exclude">Bedingung</button>
            <button class="btn secondary small" type="button" data-action="preset-bware">B-Ware ausschließen</button>
          </div>
          ${facetHint(facets)}
        </section>
        </form>
        ${previewBlock()}
      </div>
      <aside class="sticky">
        <section class="panel stack">
          <h2>Prüfen und planen</h2>
          <p class="help">Die Auswahl wird beim Planen fest gespeichert. Neue Produkte kommen nicht automatisch hinzu.</p>
          <button class="btn" type="submit" form="campaign-form" ${state.busy ? "disabled" : ""}>Vorschau erstellen</button>
        </section>
        <section class="panel note">Bei beworbenen Rabatten muss der Referenzpreis passen. Diese App kennt keine vollständige 30-Tage-Historie nach § 11 PAngV und bestätigt keine rechtliche Zulässigkeit.</section>
      </aside>
    </div>`;
}

function previewBlock() {
  if (!state.preview) return "";
  const preview = state.preview;
  return `
    <section class="panel stack">
      <div class="section-head">
        <h2>Vorschau</h2>
        <span class="help">${preview.counts.applicable} werden geändert, ${preview.counts.skipped} übersprungen${preview.truncated ? ", Anzeige auf 200 begrenzt" : ""}</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Produkt</th><th>Bisher</th><th>Aktion</th><th>Vergleich</th><th></th></tr></thead>
        <tbody>
          ${preview.variants.map((variant) => `<tr>
            <td><strong>${esc(variant.productTitle)}</strong><br><span class="help">${esc(variantLabel(variant))}</span></td>
            <td class="money">${euro(variant.originalPriceCents)}</td>
            <td class="money">${variant.targetPriceCents == null ? "—" : euro(variant.targetPriceCents)}</td>
            <td class="money">${euro(variant.targetCompareCents)}</td>
            <td>${badge(variant.state, variant.state === "pending" ? "Änderung" : (VARIANT[variant.state] || variant.state))}<br><span class="help">${esc(variant.skipReason || "")}</span></td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <form data-action="plan" class="stack">
        <label class="check"><input type="checkbox" name="confirmReference" required> Ich habe die Referenzpreise geprüft. Die App setzt nur die hier gezeigten Preise und stellt danach die gespeicherten Ursprungswerte wieder her.</label>
        <button class="btn" type="submit" ${state.busy ? "disabled" : ""}>Aktion planen</button>
      </form>
    </section>`;
}

function detailView() {
  const campaign = state.detail;
  if (!campaign) return `<p class="empty">Aktion nicht gefunden.</p>`;
  const open = ["scheduled", "active", "reverting"].includes(campaign.status);
  return `
    <section class="panel stack">
      <div class="section-head">
        <div>
          ${badge(campaign.status, STATUS[campaign.status] || campaign.status)}
          <p class="help detail-meta">${esc(campaign.startsAtLabel)} – ${esc(campaign.endsAtLabel)} · ${esc(campaign.discountLabel)} · ${campaign.compareMode === "keep_higher" ? "höheren Vergleich behalten" : "bisheriger Verkaufspreis als Vergleich"}</p>
        </div>
        <div class="actions">
          <button class="btn secondary small" type="button" data-action="csv">CSV</button>
          ${open ? `<button class="btn danger small" type="button" data-action="end">Vorzeitig beenden</button>` : ""}
          <button class="btn secondary small" type="button" data-action="tick" ${state.busy ? "disabled" : ""}>Jetzt prüfen</button>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Variante</th><th>Original</th><th>Aktion</th><th>Zustand</th><th></th></tr></thead>
        <tbody>
          ${(campaign.variants || []).map((variant) => `<tr>
            <td><strong>${esc(variant.productTitle)}</strong><br><span class="help">${esc(variantLabel(variant))}</span></td>
            <td class="money">${euro(variant.originalPriceCents)}<br><span class="help">Vgl. ${euro(variant.originalCompareCents)}</span></td>
            <td class="money">${euro(variant.targetPriceCents)}<br><span class="help">Vgl. ${euro(variant.targetCompareCents)}</span></td>
            <td>${badge(variant.state, VARIANT[variant.state] || variant.state)}<br><span class="help">${esc(variant.skipReason || variant.lastError || "")}</span></td>
            <td class="actions">${variant.state === "conflict" ? `<button class="btn secondary small" type="button" data-action="keep" data-id="${esc(variant.variantId)}">Extern behalten</button>` : ""}${variant.state === "conflict" && variant.applied ? `<button class="btn small" type="button" data-action="align" data-id="${esc(variant.variantId)}">Aktionspreis setzen</button>` : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <h3>Protokoll</h3>
      <div class="log">
        ${(campaign.logs || []).map((entry) => `<div><time>${esc(formatTime(entry.createdAt))}</time>${esc(entry.message)}</div>`).join("") || `<p class="help">Noch keine Einträge.</p>`}
      </div>
    </section>`;
}

function filterRow(side, condition, index) {
  const ops = opsFor(condition.field);
  const hideValue = condition.op === "empty" || condition.op === "not_empty";
  return `<div class="filter-row" data-filter-row data-side="${side}" data-index="${index}">
    <select data-key="field" aria-label="Feld">${FIELDS.map(([value, label]) => `<option value="${value}" ${value === condition.field ? "selected" : ""}>${label}</option>`).join("")}</select>
    <select data-key="op" aria-label="Operator">${ops.map(([value, label]) => `<option value="${value}" ${value === condition.op ? "selected" : ""}>${label}</option>`).join("")}</select>
    <input data-key="value" aria-label="Wert" value="${esc(condition.value)}" ${hideValue ? "hidden" : ""} list="facet-${esc(condition.field)}">
    <button class="btn secondary small" type="button" data-action="remove-filter" data-side="${side}" data-index="${index}">Entfernen</button>
  </div>`;
}

function facetHint(facets) {
  if (!facets) return "";
  const lists = [
    ["vendor", facets.vendors],
    ["product_type", facets.types],
    ["tag", facets.tags],
    ["product_status", facets.statuses],
    ["collection", (facets.collections || []).flatMap((collection) => [collection.title, collection.id])],
  ];
  return lists.map(([id, values]) => `<datalist id="facet-${id}">${(values || []).map((value) => `<option value="${esc(value)}"></option>`).join("")}</datalist>`).join("");
}

function opsFor(field) {
  return ["price", "compare_at", "inventory"].includes(field) ? NUMBER_OPS : TEXT_OPS;
}

function radio(name, value, label, current) {
  return `<label><input type="radio" name="${name}" value="${value}" ${current === value ? "checked" : ""}>${label}</label>`;
}

function badge(state, label) {
  return `<span class="state ${esc(state)}">${esc(label)}</span>`;
}

function variantLabel(variant) {
  const title = variant.variantTitle === "Default Title" ? "Standard" : variant.variantTitle;
  return [title, variant.sku].filter(Boolean).join(" · ");
}

function euro(cents) {
  if (cents == null) return "—";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

function formatTime(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}
