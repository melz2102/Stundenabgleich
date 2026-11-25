# Stundenabgleich

Handy-App (Web-App/PWA) zum Abgleich von Wochenzetteln (Stundenerfassungsblatt) mit Lohnzetteln.

- Läuft auf iPhone und Android im Browser, kann zum Startbildschirm hinzugefügt werden.
- Alle Zettel werden nur lokal auf dem Gerät gespeichert (IndexedDB), nichts geht an einen Server.
- Wird über GitHub Pages ausgeliefert.

Stand: Upload, Liste, Ansicht. Wochenzettel-PDFs werden mit pdf.js ausgelesen, Lohnzettel (Foto oder PDF) mit Tesseract.js direkt auf dem Handy. Alle Werte lassen sich prüfen und korrigieren. Die Monatsauswertung folgt.

## Rechenregeln der Monatsauswertung

Abgeleitet aus der Abrechnung Oktober 2026, bitte bei Bedarf anpassen (`auswertung.js`):

- Soll: Mo–Do 8,5 Std., Fr 5,0 Std. Feiertage zählen zum Soll.
- Ist = produktive + unproduktive Stunden (Urlaub, krank, Feiertag). Saldo = Mehr- + Minderstunden laut Wochenzettel.
- Stundenlohn (Lohnart 1000) + Abbau Arbeitszeitkonto = Monatssoll.
- Fehlstunden (Saldo < 0) werden vom Arbeitszeitkonto abgebaut, gesammelte Mehrstunden nicht ausgezahlt.
