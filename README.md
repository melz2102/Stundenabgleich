# Stundenabgleich

Handy-App (Web-App/PWA) zum Abgleich von Wochenzetteln (Stundenerfassungsblatt) mit Lohnzetteln.

- Läuft auf iPhone und Android im Browser, kann zum Startbildschirm hinzugefügt werden.
- Alle Zettel werden nur lokal auf dem Gerät gespeichert (IndexedDB), nichts geht an einen Server.
- Wird über GitHub Pages ausgeliefert.

Stand: Upload, Liste, Ansicht. Wochenzettel-PDFs werden mit pdf.js ausgelesen, Lohnzettel (Foto oder PDF) mit Tesseract.js direkt auf dem Handy. Alle Werte lassen sich prüfen und korrigieren. Die Monatsauswertung folgt.
