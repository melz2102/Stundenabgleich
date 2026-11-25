# Stundenabgleich

Handy-App (Web-App/PWA) zum Abgleich von Wochenzetteln (Stundenerfassungsblatt) mit Lohnzetteln.

- Läuft auf iPhone und Android im Browser, kann zum Startbildschirm hinzugefügt werden.
- Alle Zettel werden nur lokal auf dem Gerät gespeichert (IndexedDB), nichts geht an einen Server.
- Wird über GitHub Pages ausgeliefert.

Stand: Wochenzettel als Excel (.xls/.xlsx, SheetJS) oder PDF (pdf.js) werden ausgelesen, handgeschriebene per Foto von Hand eingetragen, Lohnzettel (Foto oder PDF) mit Tesseract.js direkt auf dem Handy. Alle Werte lassen sich prüfen und korrigieren. Monatsauswertung mit Abgleich gegen den Lohnzettel.

## Geldbeträge und Jahresübersicht

- **Geldbeträge** (Karte unter dem Abgleich): Für jede Lohnart mit Stunden wird Stunden × Satz mit dem Betrag verglichen. Ist der Faktor auf dem Foto unleserlich, wird er aus Betrag ÷ Stunden berechnet, wenn das glatt aufgeht. Hinweis, wenn sich der Stundensatz gegenüber dem letzten Lohnzettel ändert oder Urlaub/Krank/AZK mit einem anderen Satz als der Stundenlohn bezahlt werden. Summe aller Beträge zum Vergleich mit dem Gesamt-Brutto. Bei großen Fotos liest `extract.js` die Spalte „Betrag“ gezielt nach (`betraegeNachlesen`).
- **Jahresübersicht** (Tab „Jahr“): Monate mit Ist/Soll/Saldo und Abgleich-Ergebnis, Arbeitszeitkonto Monat für Monat (über fehlende Lohnzettel hinweg verkettet), Urlaub mit noch nicht abgezogenen Tagen, Kranktage, Stundensatz-Verlauf, Baustellen im Jahr.

## Sicherung und Export (`export.js`)

- **Sicherungsdatei** (`Stundenabgleich-Sicherung-JJJJ-MM-TT.json`): alle Zettel samt Fotos/PDFs/Excel (als Base64). Teilen bzw. „In Dateien sichern“ (iCloud Drive, Google Drive). „Sicherung einlesen“ fügt fehlende Zettel hinzu und ersetzt nur ältere Stände. Nach 30 Tagen ohne Sicherung erinnert die Übersicht.
- **Monatsbericht als PDF** (jsPDF 2.5.1, `vendor/jspdf.umd.min.js`): Stunden, Tage, Baustellen, Abgleich und alle Tage des Monats.
- **Alle Stunden als Excel**: Blätter „Tage“ (jeder Eintrag), „Monate“ (Auswertung und Lohnzettel-Werte) und „Lohnzettel“.

## Rechenregeln der Monatsauswertung

Abgeleitet aus der Abrechnung Oktober 2026, bitte bei Bedarf anpassen (`auswertung.js`):

- Soll: Mo–Do 8,5 Std., Fr 5,0 Std. Feiertage zählen zum Soll.
- Ist = produktive + unproduktive Stunden (Urlaub, krank, Feiertag). Saldo = Mehr- + Minderstunden laut Wochenzettel.
- Stundenlohn (Lohnart 1000) + Urlaubs-, Krank- und Feiertagsstunden + Abbau Arbeitszeitkonto = Monatssoll. Urlaubs- und Krankstunden vom Lohnzettel werden mit den Wochenzetteln verglichen.
- Fehlstunden (Saldo < 0) werden vom Arbeitszeitkonto abgebaut.
- Mehrstunden gehen aufs Arbeitszeitkonto ("sammeln" oder nichts angekreuzt). Ist auf dem Wochenzettel "vergüten" angekreuzt, wird der Saldo dieser Woche als Überstunden ausgezahlt.
- AZK-Std. auf dem Lohnzettel ist der Kontostand ("4,25-" = minus 4,25 Std.). Seine Veränderung zum Vormonat muss dem gesammelten Monatssaldo entsprechen.
- Fahrgeld-Std. (Lohnart 1800) = Stunden "Vergütung Fahrtätigkeit" laut Wochenzetteln (mit August 2026 bestätigt).
- Verpflegungsmehraufwand (Lohnarten 2045/2046, 14 € bzw. 28 € pro Tag) = Summe "Auslöse/Verpfl." laut Wochenzetteln.

Von Kevin bestätigt am 25.11.2026.
