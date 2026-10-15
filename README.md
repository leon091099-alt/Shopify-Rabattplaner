# On-Tec Rabattplaner

Private Shopify-App für den On-Tec Store. Sie wird im Shopify-Admin geöffnet und hat keine eigene Anmeldeseite. Verkaufspreise und Vergleichspreise werden für einen festgelegten Zeitraum geändert und danach wiederhergestellt.

Der Zeitplaner läuft auf dem Server. Der Admin muss dafür nicht offen bleiben.

## Demo

```bash
npm run demo
```

Öffnen: http://localhost:3000. Es gibt kein Passwort. Die Demo verändert nur fünf fiktive Produkte und ruft Shopify nicht auf.

## Dokumente

- [KONZEPT.md](KONZEPT.md)
- [INSTALLATION.md](INSTALLATION.md)
- [TESTBERICHT.md](TESTBERICHT.md)

## Entwicklung

```bash
npm test
```

Node.js 24 ist die vorgesehene Version. Lokal läuft die App auch mit Node.js 22 und `--experimental-sqlite`. Es gibt keine npm-Abhängigkeiten.
