# Installation

Die App wird im Shopify-Admin geöffnet. Sie ist kein Theme und wird nicht als ZIP im Admin hochgeladen. Der Server muss dauerhaft laufen, damit Aktionen starten und enden.

## 1. Demo

Node.js 24 installieren, im App-Ordner:

```bash
npm run demo
```

http://localhost:3000 öffnen. Kein Passwort, keine Shopify-Verbindung.

## 2. Shopify-App

1. Mit dem On-Tec-Konto https://dev.shopify.com öffnen.
2. Die Organisation wählen, zu der der Shop gehört. App und Shop müssen derselben Organisation gehören, damit der Zeitplaner den Client-Credentials-Grant nutzen kann.
3. App `On-Tec Rabattplaner` anlegen.
4. Einbettung in den Shopify-Admin aktivieren. Als App-URL die spätere HTTPS-Adresse eintragen, zum Beispiel `https://rabatte.on-tec-store.de`.
5. Scopes: `read_products,write_products`.
6. API-Version `2026-10`, sofern das Feld verlangt wird. Keine Webhooks nötig.
7. Version veröffentlichen und die App im On-Tec Store installieren.
8. Client-ID und Client-Secret nur auf dem Server hinterlegen.
9. Die `myshopify.com`-Domain des Shops verwenden, nicht die öffentliche Domain.

## 3. Server

`.env` aus `.env.example` anlegen und `chmod 600 .env` setzen:

```dotenv
SHOPIFY_SHOP=deine-originale-domain.myshopify.com
SHOPIFY_CLIENT_ID=deine-client-id
SHOPIFY_CLIENT_SECRET=dein-client-secret
SHOPIFY_API_VERSION=2026-10
APP_ORIGIN=https://rabatte.on-tec-store.de
APP_DOMAIN=rabatte.on-tec-store.de
HOST=0.0.0.0
PORT=3000
DATA_FILE=/data/on-tec.sqlite
```

Es gibt kein App-Passwort. Die Anmeldung übernimmt Shopify.

```bash
docker compose up -d --build
```

Danach im Shopify-Admin unter Apps den Rabattplaner öffnen. Angezeigt werden der Shopname, die Variantenzahl und der Status Shopify · Admin.

## 4. Erster Test

Ein Testprodukt per Varianten-ID einschließen, 1 € Rabatt, kurzes Zeitfenster. Vorschau bestätigen, planen und im Shop Preis sowie Vergleichspreis prüfen. Nach dem Ende oder über „Vorzeitig beenden“ müssen die ursprünglichen Werte wieder da sein, auch ein leerer Vergleichspreis.

## 5. Backup

```bash
docker compose stop app
docker compose cp app:/data/on-tec.sqlite ./on-tec-backup.sqlite
docker compose start app
```

Vor dem Entfernen alle Aktionen beenden. Eine Deinstallation in Shopify setzt Preise nicht von selbst zurück.
