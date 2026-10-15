# Testbericht

`npm test` prüft Geldbeträge, Vergleichspreise, Filter, Berliner Zeitumstellung, Zeitplan, Konflikte, verlorene Shopify-Antworten, Neustart, Varianten, Datenbanksperre, gelöschte Varianten, Katalogseiten und den Shopify-Adapter.

Die Demo-Oberfläche verlangt kein Passwort. Im Shopify-Modus weist der Server Anfragen ohne gültiges ID-Token ab, ebenso Tokens eines anderen Shops und abgelaufene Tokens. Die HTML-Antwort enthält App Bridge und erlaubt die Einbettung nur für den konfigurierten Shop und `admin.shopify.com`.

Noch nicht gegen den echten On-Tec Store geprüft: Installation, Scopes, Theme-Darstellung und die Laufzeit eines großen Katalogs.
