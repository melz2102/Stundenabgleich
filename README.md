# Stundenabgleich

Handy-App (Web-App/PWA) zum Abgleich von Wochenzetteln (Stundenerfassungsblatt) mit Lohnzetteln.

- Läuft auf iPhone und Android im Browser, kann zum Startbildschirm hinzugefügt werden.
- Alle Zettel werden nur lokal auf dem Gerät gespeichert (IndexedDB), nichts geht an einen Server.
- Wird über GitHub Pages ausgeliefert.

Stand: Upload, Liste, Ansicht. Wochenzettel als Excel (.xls/.xlsx, SheetJS) oder PDF (pdf.js) werden ausgelesen, Lohnzettel (Foto oder PDF) mit Tesseract.js direkt auf dem Handy. Alle Werte lassen sich prüfen und korrigieren. Die Monatsauswertung folgt.

## Rechenregeln der Monatsauswertung

Abgeleitet aus der Abrechnung Oktober 2026, bitte bei Bedarf anpassen (`auswertung.js`):

- Soll: Mo–Do 8,5 Std., Fr 5,0 Std. Feiertage zählen zum Soll.
- Ist = produktive + unproduktive Stunden (Urlaub, krank, Feiertag). Saldo = Mehr- + Minderstunden laut Wochenzettel.
- Stundenlohn (Lohnart 1000) + Urlaubs-, Krank- und Feiertagsstunden + Abbau Arbeitszeitkonto = Monatssoll. Urlaubs- und Krankstunden vom Lohnzettel werden mit den Wochenzetteln verglichen.
- Fehlstunden (Saldo < 0) werden vom Arbeitszeitkonto abgebaut.
- Mehrstunden gehen aufs Arbeitszeitkonto ("sammeln" oder nichts angekreuzt). Ist auf dem Wochenzettel "vergüten" angekreuzt, wird der Saldo dieser Woche als Überstunden ausgezahlt.
- AZK-Std. auf dem Lohnzettel ist der Kontostand ("4,25-" = minus 4,25 Std.). Seine Veränderung zum Vormonat muss dem gesammelten Monatssaldo entsprechen.

Von Kevin bestätigt am 25.11.2026.
