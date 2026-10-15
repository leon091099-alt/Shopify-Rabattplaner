import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.js";

const demo = process.argv.includes("--demo");
if (!demo && existsSync(resolve(".env"))) process.loadEnvFile(resolve(".env"));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (demo ? "127.0.0.1" : "0.0.0.0");
const app = await createApp({
  demo,
  host,
  port,
  dataFile: process.env.DATA_FILE || (demo ? resolve("data/demo.sqlite") : resolve("data/on-tec.sqlite")),
  appOrigin: process.env.APP_ORIGIN || `http://localhost:${port}`,
  shopify: demo ? null : {
    shop: process.env.SHOPIFY_SHOP,
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-10",
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || "",
  },
});

console.log(`On-Tec Rabattplaner läuft auf ${app.origin} (${demo ? "Demo" : "Shopify"}).`);

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
