const MAX_CENTS = 100_000_000;

export function parseEuroToCents(input, { allowZero = false } = {}) {
  if (input == null) return { ok: false, error: "Betrag fehlt." };
  let raw = String(input).trim().replace(/\s+/g, "").replace(/€/g, "");
  if (!raw) return { ok: false, error: "Betrag fehlt." };
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else {
    raw = raw.replace(",", ".");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: "Ungültiger Eurobetrag." };
  }
  const [whole, frac = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0 || (!allowZero && cents === 0)) {
    return { ok: false, error: allowZero ? "Ungültiger Eurobetrag." : "Der Rabatt muss größer als 0 € sein." };
  }
  if (cents > MAX_CENTS) return { ok: false, error: "Der Betrag ist zu groß." };
  return { ok: true, cents };
}

export function parsePercentToBasisPoints(input) {
  if (input == null) return { ok: false, error: "Prozentwert fehlt." };
  const raw = String(input).trim().replace(/\s+/g, "").replace(/%/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: "Ungültiger Prozentwert." };
  }
  const [whole, frac = ""] = raw.split(".");
  const basisPoints = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(basisPoints) || basisPoints <= 0 || basisPoints >= 10_000) {
    return { ok: false, error: "Der Prozentwert muss größer als 0 und kleiner als 100 sein." };
  }
  return { ok: true, basisPoints };
}

export function formatCents(cents) {
  if (cents == null) return null;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatCentsDe(cents) {
  if (cents == null) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const grouped = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${grouped},${String(abs % 100).padStart(2, "0")} €`;
}

export function parseShopifyMoney(value) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(/^(-)?(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Ungültiger Shopify-Preis: ${value}`);
  const negative = Boolean(match[1]);
  const whole = Number(match[2]);
  const fraction = (match[3] || "").padEnd(3, "0");
  let cents = whole * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2] || "0") >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw new Error(`Ungültiger Shopify-Preis: ${value}`);
  return negative ? -cents : cents;
}

function roundDivHalfUp(numerator, denominator) {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function applyDiscount(priceCents, type, value) {
  if (!Number.isInteger(priceCents) || priceCents < 1) {
    return { ok: false, reason: "Kein gültiger Verkaufspreis." };
  }
  let next;
  if (type === "amount") {
    if (!Number.isInteger(value) || value <= 0) return { ok: false, reason: "Ungültiger Eurobetrag." };
    next = priceCents - value;
  } else if (type === "percent") {
    if (!Number.isInteger(value) || value <= 0 || value >= 10_000) {
      return { ok: false, reason: "Ungültiger Prozentwert." };
    }
    next = roundDivHalfUp(priceCents * (10_000 - value), 10_000);
  } else {
    return { ok: false, reason: "Unbekannte Rabattart." };
  }
  if (next < 1) return { ok: false, reason: "Rabatt wäre unter 0,01 €." };
  if (next >= priceCents) return { ok: false, reason: "Keine wirksame Preisverringerung." };
  return { ok: true, priceCents: next };
}
