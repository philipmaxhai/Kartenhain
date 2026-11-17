# Kartenhain Preistracker

Preistracker für **Magic: The Gathering** mit Daten von **Cardmarket**. Gedacht fürs Karten-Resellen:

- **Suche** nach Kartennamen: pro Karte die **günstigste und die teuerste Version** mit Editionsnamen, wie viel teurer die teuerste ist, und alle Versionen auf einen Blick
- **Graphen** zum Preisverlauf jeder Karte (Trendpreis und Ab-Preis, normal und Foil, 30 Tage bis alles)
- **Trends**: Top 100 der am stärksten gestiegenen ▲ und gefallenen ▼ Karten (Ø-Preis vorher → jetzt, in Prozent), über 7, 30 oder 90 Tage, mit Mindestpreis-Filter
- **5 günstigste Angebote** einer Karte mit **Verkäuferland** (Flagge + Name), Filter für Zustand und Sprache
- **Merkliste** für Karten, die du beobachten willst

## Starten unter Windows (ohne Vorkenntnisse)

1. Einmalig [Node.js](https://nodejs.org/de/download) installieren (Version „LTS“, einfach durchklicken).
2. Im Kartenhain-Ordner **doppelklicken auf `Start.bat`**. Der Browser öffnet sich von selbst.
3. Zum Beenden das schwarze Fenster schließen.

`Demo starten.bat` zeigt das Tool mit erfundenen Preisen, ganz ohne Internet.

Falls Windows beim ersten Doppelklick „Der Computer wurde durch Windows geschützt“ meldet:
auf **Weitere Informationen → Trotzdem ausführen** klicken.

**Neue Version holen:** auf GitHub *Code → Download ZIP*, die ZIP öffnen und den Inhalt **in den bisherigen
Kartenhain-Ordner entpacken** (vorhandene Dateien ersetzen). So bleibt der gespeicherte Preisverlauf im
Unterordner `data` erhalten.

## Schnellstart (Kommandozeile)

Voraussetzung: [Node.js](https://nodejs.org) ab Version 22.13. Es müssen keine Pakete installiert werden.

```bash
npm start        # echte Cardmarket-Daten, öffnet http://localhost:3000
npm run demo     # zum Ausprobieren mit erfundenen Daten
npm test         # Tests
```

Beim ersten Start lädt das Tool den kompletten Cardmarket-Preisguide für Magic (ca. 1 bis 2 Minuten).
Solange der Server läuft, holt er sich einmal am Tag die neuen Preise.

## Woher die Daten kommen

| Funktion | Quelle | Login nötig? |
|---|---|---|
| Suche, aktuelle Preise (Trend, Ab-Preis, Ø 1/7/30 Tage) | Öffentlicher Cardmarket-Preisguide (`price_guide_1.json`) und Produktkatalog, täglich aktualisiert | Nein |
| Preisverlauf / Graphen | Das Tool speichert jeden Tag eine Momentaufnahme in `data/kartenhain.sqlite` | Nein |
| 5 günstigste Angebote mit Land | Offizielle Cardmarket-API v2.0 (`/articles/{idProduct}`) | **Ja** |
| Editionsnamen (Cardmarket-Editions-ID → Name) | MTGJSON `SetList.json` | Nein |
| Kartenbilder | Scryfall (über die Cardmarket-ID) | Nein |

**Wichtig zum Verlauf:** Cardmarket bietet keine langen Preis-Historien zum Download an. Der Graph füllt sich
deshalb ab dem ersten Start Tag für Tag. Bis genug Verlauf da ist, berechnet die Trend-Seite die Gewinner und
Verlierer aus dem Cardmarket-Vergleich *7-Tage-Durchschnitt gegen 30-Tage-Durchschnitt*, das funktioniert
sofort. Damit die Datenbank klein bleibt, wird der Verlauf nur für Karten ab 0,50 € gespeichert
(einstellbar mit `HISTORY_MIN_TREND`). Karten auf der Merkliste werden immer gespeichert.

Am besten lässt du den Server dauerhaft laufen oder richtest einen täglichen Job für `npm run update` ein
(Windows: Aufgabenplanung, macOS/Linux: cron).

## Cardmarket-API für die günstigsten Angebote

Die einzelnen Angebote mit Verkäuferland gibt es nur über die offizielle API. Ohne Zugang zeigt das Tool
den Ab-Preis aus dem Preisguide und einen Link zu den Angeboten auf Cardmarket.

1. Auf Cardmarket einloggen, unter **Konto → API-Einstellungen** eine *Dedicated App* anlegen
   (Cardmarket vergibt API-Zugänge nicht an jedes Konto; ggf. beim Support anfragen).
2. `.env.example` nach `.env` kopieren und die vier Werte eintragen:
   `CARDMARKET_APP_TOKEN`, `CARDMARKET_APP_SECRET`, `CARDMARKET_ACCESS_TOKEN`, `CARDMARKET_ACCESS_SECRET`.
3. `npm start` neu starten.

Angebote werden 10 Minuten zwischengespeichert, um das API-Tageslimit zu schonen.

Bitte die Nutzungsbedingungen von Cardmarket beachten. Das Tool nutzt nur die offiziellen Downloads und die
offizielle API, es liest keine Webseiten aus.

## Aufbau

```
src/server.js      Webserver + API-Routen
src/cardmarket.js  Import Preisguide/Katalog, Cardmarket-API (OAuth 1.0)
src/trends.js      Suche, Trends, Verlauf
src/db.js          SQLite (eingebaut in Node.js)
src/demo.js        Demo-Daten
public/            Oberfläche (HTML/CSS/JS, Graph als SVG)
test/              Tests (node --test)
```
