import { ShopifyError } from "./errors.js";
import { formatCents, parseShopifyMoney } from "./money.js";

const VARIANT_FIELDS = `
  id
  title
  sku
  barcode
  price
  compareAtPrice
  inventoryQuantity
  selectedOptions { name value }
`;

const PRODUCTS_QUERY = `
  query Catalog($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        productType
        vendor
        status
        tags
        collections(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { id title }
        }
        variants(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { ${VARIANT_FIELDS} }
        }
      }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation UpdatePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message }
    }
  }
`;

export function normalizeShop(input) {
  let shop = String(input || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!shop) throw new ShopifyError("SHOPIFY_SHOP fehlt.", { code: "config" });
  if (!shop.includes(".")) shop = `${shop}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new ShopifyError("SHOPIFY_SHOP muss die myshopify.com-Domain sein, nicht die öffentliche Shop-Domain.", { code: "config" });
  }
  return shop;
}

export function createShopifyClient(options) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const shop = normalizeShop(options.shop);
  const apiVersion = options.apiVersion || "2026-10";
  const staticToken = options.accessToken || "";
  let token = null;
  let tokenExpiresAt = 0;
  let shopCache = null;
  let shopCachedAt = 0;

  async function getToken() {
    if (staticToken) return staticToken;
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    let response;
    try {
      response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: options.clientId,
          client_secret: options.clientSecret,
        }),
      });
    } catch (error) {
      throw new ShopifyError(error.message || "Token-Anfrage nicht erreichbar.", { sent: false, code: "network" });
    }
    const bodyText = await response.text();
    if (!response.ok) {
      if (bodyText.includes("shop_not_permitted")) {
        throw new ShopifyError("shop_not_permitted: App und Shop gehören nicht zur selben Shopify-Organisation.", {
          sent: false,
          code: "shop_not_permitted",
          status: response.status,
        });
      }
      throw new ShopifyError(`Shopify-Anmeldung fehlgeschlagen (${response.status}).`, { sent: false, code: "auth", status: response.status });
    }
    const payload = JSON.parse(bodyText);
    if (!payload.access_token) throw new ShopifyError("Shopify hat kein Zugriffstoken geliefert.", { code: "auth" });
    token = payload.access_token;
    tokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return token;
  }

  async function graphql(query, variables = {}, { mutation = false } = {}) {
    const accessToken = await getToken();
    let response;
    try {
      response = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      const explicit = error && Object.prototype.hasOwnProperty.call(error, "sent");
      throw new ShopifyError(error.message || "Shopify-Netzwerkfehler.", {
        sent: explicit ? Boolean(error.sent) : mutation,
        code: "network",
      });
    }
    if (response.status === 429) throw new ShopifyError("Shopify-Limit erreicht. Der nächste Lauf versucht es erneut.", { sent: false, code: "throttle", status: 429 });
    if (response.status >= 500) {
      throw new ShopifyError(`Shopify-Antwort ${response.status}.`, { sent: mutation, code: "http", status: response.status });
    }
    if (!response.ok) throw new ShopifyError(`Shopify-Antwort ${response.status}.`, { sent: false, code: "http", status: response.status });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ShopifyError("Shopify-Antwort konnte nicht gelesen werden.", { sent: mutation, code: "parse" });
    }
    if (payload.errors?.length && !payload.data) {
      const message = payload.errors.map((error) => error.message).join("; ");
      throw new ShopifyError(message, { sent: false, code: /access denied|access scope/i.test(message) ? "scope" : "graphql" });
    }
    return payload.data;
  }

  return {
    mode: "shopify",
    shop,
    apiVersion,
    async getToken() {
      return getToken();
    },
    async getShop() {
      if (shopCache && Date.now() - shopCachedAt < 300_000) return shopCache;
      const data = await graphql("{ shop { name currencyCode } }");
      shopCache = { name: data.shop.name, currencyCode: data.shop.currencyCode };
      shopCachedAt = Date.now();
      return shopCache;
    },
    async readVariant(id) {
      const data = await graphql(`
        query ReadVariant($id: ID!) {
          node(id: $id) {
            ... on ProductVariant { id price compareAtPrice product { id } }
          }
        }
      `, { id });
      const node = data?.node;
      if (!node?.id) return { id, exists: false };
      return {
        id: node.id,
        exists: true,
        productId: node.product?.id || null,
        priceCents: parseShopifyMoney(node.price),
        compareCents: parseShopifyMoney(node.compareAtPrice),
      };
    },
    async updateVariant({ productId, variantId, priceCents, compareCents }) {
      const variables = {
        productId,
        variants: [{
          id: variantId,
          price: formatCents(priceCents),
          compareAtPrice: compareCents == null ? null : formatCents(compareCents),
        }],
      };
      const data = await graphql(UPDATE_MUTATION, variables, { mutation: true });
      const result = data?.productVariantsBulkUpdate;
      const userErrors = result?.userErrors || [];
      if (userErrors.length) {
        throw new ShopifyError(userErrors.map((error) => error.message).join("; "), {
          sent: true,
          applied: false,
          userErrors,
          code: "user_error",
        });
      }
      if (!result) throw new ShopifyError("Leere Shopify-Antwort nach dem Schreibzugriff.", { sent: true, code: "empty" });
      return { ok: true };
    },
    async fetchCatalog() {
      const products = [];
      const variants = [];
      const collections = new Map();
      const links = [];
      let cursor = null;
      for (;;) {
        const data = await graphql(PRODUCTS_QUERY, { cursor });
        const connection = data.products;
        for (const product of connection.nodes) {
          products.push({
            id: product.id,
            title: product.title,
            productType: product.productType || "",
            vendor: product.vendor || "",
            status: product.status || "",
            tags: product.tags || [],
          });
          let collectionNodes = product.collections.nodes;
          let collectionPage = product.collections.pageInfo;
          while (collectionPage.hasNextPage) {
            const more = await graphql(`
              query MoreCollections($id: ID!, $cursor: String) {
                product(id: $id) {
                  collections(first: 100, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes { id title }
                  }
                }
              }
            `, { id: product.id, cursor: collectionPage.endCursor });
            collectionNodes = collectionNodes.concat(more.product.collections.nodes);
            collectionPage = more.product.collections.pageInfo;
          }
          for (const collection of collectionNodes) {
            collections.set(collection.id, { id: collection.id, title: collection.title });
            links.push({ productId: product.id, collectionId: collection.id });
          }
          let variantNodes = product.variants.nodes;
          let variantPage = product.variants.pageInfo;
          while (variantPage.hasNextPage) {
            const more = await graphql(`
              query MoreVariants($id: ID!, $cursor: String) {
                product(id: $id) {
                  variants(first: 100, after: $cursor) {
                    pageInfo { hasNextPage endCursor }
                    nodes { ${VARIANT_FIELDS} }
                  }
                }
              }
            `, { id: product.id, cursor: variantPage.endCursor });
            variantNodes = variantNodes.concat(more.product.variants.nodes);
            variantPage = more.product.variants.pageInfo;
          }
          for (const variant of variantNodes) variants.push(mapVariant(product.id, variant));
        }
        if (!connection.pageInfo.hasNextPage) break;
        cursor = connection.pageInfo.endCursor;
      }
      return { products, variants, collections: [...collections.values()], links };
    },
  };
}

function mapVariant(productId, variant) {
  return {
    id: variant.id,
    productId,
    title: variant.title || "",
    sku: variant.sku || "",
    barcode: variant.barcode || "",
    priceCents: parseShopifyMoney(variant.price),
    compareCents: parseShopifyMoney(variant.compareAtPrice),
    inventory: Number.isInteger(variant.inventoryQuantity) ? variant.inventoryQuantity : null,
    options: (variant.selectedOptions || []).map((option) => ({ name: option.name, value: option.value })),
  };
}
