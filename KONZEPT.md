# Konzept: On-Tec Rabattplaner

## Ziel

Im Shopify-Admin festlegen, welche Varianten von wann bis wann um einen Eurobetrag oder Prozentsatz reduziert werden. Die App setzt Verkaufspreis und Vergleichspreis und stellt die vorherigen Werte wieder her.

## Zugang

Die Oberfläche ist eine eingebettete Shopify-App. Shopify weist den angemeldeten Händler aus. Es gibt kein zweites Passwort. Wer die Adresse direkt aufruft, sieht nur den Hinweis, die App unter Apps im Admin zu öffnen.

Der Zeitplaner authentifiziert sich serverseitig mit dem Client-Credentials-Grant und braucht dafür keinen offenen Browser.

## Bedienung

1. App im Shopify-Admin unter Apps öffnen.
2. Katalog aktualisieren.
3. Name, Zeitraum und Rabatt eintragen.
4. Produkte einschließen und ausschließen.
5. Vorschau prüfen und Referenzpreise bestätigen.
6. Aktion planen. Die Auswahl bleibt fest.
7. Status und Protokoll verfolgen. Bei Bedarf vorzeitig beenden.

## Funktionen

Rabatt als Eurobetrag oder Prozent, mindestens 0,01 € Verkaufspreis. Zeiten in Europe/Berlin, Prüfung alle 30 Sekunden. Produkt- und Variantenfilter mit Einschluss (UND/ODER) und vorrangigem Ausschluss. Vorschau der ersten 200 Varianten, die gesamte Auswahl wird gespeichert. Rücksetzung stellt auch einen leeren Vergleichspreis wieder her. Bestehende Vergleichspreise werden standardmäßig übersprungen. Konflikte werden nicht still überschrieben.

## Preis und Vergleich

Der Rabatt rechnet auf den in der Vorschau gespeicherten Verkaufspreis. Vor dem ersten Schreiben müssen die aktuellen Shopify-Preise noch zur Vorschau passen.

§ 11 PAngV verlangt bei einer beworbenen Preisermäßigung grundsätzlich den niedrigsten Gesamtpreis der letzten 30 Tage. Diese Version hat keine vollständige Preishistorie. Die Bestätigung in der App ist eine Bedienprüfung, keine Rechtsprüfung.

## Grenzen

Metafields, Margen, einzelne Lagerorte, Shopify-Kategorien und Markets-Preislisten sind keine Filter und werden nicht separat verändert. Die Standardpreise gelten für die Kanäle, die sie verwenden. Das Theme entscheidet, ob Vergleichspreise durchgestrichen angezeigt werden.
