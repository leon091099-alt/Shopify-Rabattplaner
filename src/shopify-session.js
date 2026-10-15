import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
import { normalizeShop } from "./shopify.js";

export function signShopifyIdToken(claims, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(claims));
  const signature = base64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

export function verifyShopifyIdToken(token, { clientId, clientSecret, shop, now = Date.now() }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  const [headerPart, bodyPart, signaturePart] = parts;
  const expected = createHmac("sha256", clientSecret).update(`${headerPart}.${bodyPart}`).digest();
  const actual = decodeBase64Url(signaturePart);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  }
  let header;
  let claims;
  try {
    header = JSON.parse(decodeBase64Url(headerPart).toString("utf8"));
    claims = JSON.parse(decodeBase64Url(bodyPart).toString("utf8"));
  } catch {
    throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  }
  if (header.alg !== "HS256") throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  const seconds = Math.floor(now / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp < seconds - 5) {
    throw new AppError("Die Shopify-Sitzung ist abgelaufen. Bitte die App im Admin neu öffnen.", 401, "shopify_auth");
  }
  if (Number.isFinite(claims.nbf) && claims.nbf > seconds + 5) {
    throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  }
  if (claims.aud !== clientId) throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  let destination;
  try {
    destination = new URL(claims.dest);
    if (normalizeShop(destination.hostname) !== normalizeShop(shop)) {
      throw new AppError("Diese App ist nur für den konfigurierten On-Tec Shop freigeschaltet.", 401, "shopify_auth");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Diese App wird nur aus dem Shopify-Admin geöffnet.", 401, "shopify_auth");
  }
  return { shop: destination.hostname, userId: claims.sub || null };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}
