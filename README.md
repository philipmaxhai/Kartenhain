# Kartenhain Preistracker

Preistracker für **Magic: The Gathering** mit Daten von **Cardmarket**. Gedacht fürs Karten-Resellen:

- **Echter Verkaufswert** überall als Hauptzahl: der Durchschnitt der echten Verkäufe der letzten 7 Tage,
  dazu, was nach der Cardmarket-Gebühr ungefähr übrig bleibt
- **Preisbereiche** mit einem Klick: *Alle*, *bis 1 €*, *1–5 €*, *5–20 €*, *20–100 €*, *ab 100 €* oder eigene
  Obergrenze („bis 2 €“). So siehst du auch günstige Karten und nicht nur die teuren
- **Übersicht**: Marktstimmung (wie viele Karten steigen oder fallen), Verteilung der Preisänderungen,
  stärkste Anstiege und Rückgänge und die wertvollsten Karten mit Kartenbild
- **Suche** nach Kartennamen: pro Karte die **günstigste und die teuerste Version**, wie viel teurer die teuerste
  ist, und alle Versionen mit Verkaufswert
- **Trends**: Top 100 der am stärksten gestiegenen ▲ und gefallenen ▼ Karten über 7, 30 oder 90 Tage,
  filterbar nach Edition und Name, als Liste oder **Kacheln mit Kartenbildern**, Export als CSV (Excel)
- **Schnäppchen**: Karten, deren günstigstes Angebot weit unter dem echten Verkaufswert liegt, mit Gewinn nach Gebühr
- **Meine Karten**: Menge und Einkaufspreis eintragen → Gesamtwert, Gewinn/Verlust und Wertverlauf;
  **Preisalarme** (unter/über einem Preis)
- **Kartenansicht** mit den Werten genau wie auf Cardmarket, Graph (Verkaufswert, günstigstes Angebot,
  Preis-Trend), Knopf zu **genau dieser Version** auf Cardmarket und einer Gegenprobe über Scryfall
- **5 günstigste Angebote** einer Karte mit **Verkäuferland** (Flagge + Name), Filter für Zustand und Sprache
- Dunkles und helles Design, funktioniert auch auf dem Handy und im halben Bildschirm

## Starten unter Windows (ohne Vorkenntnisse)

1. Einmalig [Node.js](https://nodejs.org/de/download) installieren (Version „LTS“, einfach durchklicken).
2. Im Kartenhain-Ordner **doppelklicken auf `Start.bat`**. Der Browser öffnet sich von selbst.
3. Zum Beenden das schwarze Fenster schließen.

`Demo starten.bat` zeigt das Tool mit erfundenen Preisen.

Falls Windows beim ersten Doppelklick „Der Computer wurde durch Windows geschützt“ meldet:
auf **Weitere Informationen → Trotzdem ausführen** klicken.

## Updates kommen von selbst

`Start.bat` schaut bei jedem Start auf GitHub nach einer neuen Version und lädt sie, bevor das Tool startet.
Du musst nichts tun. Läuft das Tool lange am Stück, erscheint oben der Hinweis **„Neue Version da“**:
dann einfach das schwarze Fenster schließen und `Start.bat` neu starten.

- **Deine Daten bleiben immer:** der Ordner `data` (Preise, Verlauf, Meine Karten) und die Datei `.env`
  werden nie angefasst.
- Ohne Internet oder wenn GitHub gerade nicht antwortet, startet das Tool einfach mit der bisherigen Version.
- Neue Dateien werden erst komplett heruntergeladen und geprüft, dann ersetzt. Ein abgebrochener Download
  macht nichts kaputt.
- Unten links auf der Seite steht, welche Version installiert ist.
- Ausschalten: in der Datei `.env` die Zeile `KARTENHAIN_NO_UPDATE=1` eintragen. In einem git-Klon gibt es
  kein automatisches Update (dort `git pull`).

**Von einer älteren Version (ohne Auto-Update) umsteigen:** einmal auf GitHub *Code → Download ZIP*, die ZIP
entpacken und den Ordner **`data`** aus dem alten Kartenhain-Ordner in den neuen kopieren (falls vorhanden
auch die Datei `.env`). Danach `Start.bat` im neuen Ordner starten. Ab dann kommen Updates von selbst.

## Welche Preise zeigt das Tool?

Alle Zahlen stammen aus der täglichen Preisliste von Cardmarket. Die Begriffe sind dieselben wie auf der
Cardmarket-Seite einer Karte:

| Auf Cardmarket | Im Tool | Bedeutung |
|---|---|---|
| 7-Tages-Durchschnittspreis | **Verkaufswert** | Ø der echten Verkäufe der letzten 7 Tage. Das ist der Wert, den Käufer zuletzt wirklich bezahlt haben. Gibt es keine Verkäufe, nimmt das Tool den Preis-Trend. |
| Preis-Trend | Preis-Trend | Von Cardmarket berechneter Richtwert. Reagiert träge und kann deutlich vom Verkaufswert abweichen. |
| ab | günstigstes Angebot | Das billigste Angebot gerade, egal in welchem Zustand und welcher Sprache. |
| 30-/1-Tages-Durchschnittspreis | Ø 30 Tage / Ø 1 Tag | Wie der 7-Tages-Wert, nur über 30 Tage bzw. einen Tag. |

**Nach Gebühr:** Verkaufswert minus ca. 5 % Cardmarket-Provision (ohne Versand). Den Prozentsatz kannst du mit
`CARDMARKET_FEE_PERCENT` ändern.

**Warum weicht ein Wert manchmal von Cardmarket ab?**

- Cardmarket erstellt die Preisliste einmal am Tag (nachts). Die Webseite rechnet über den Tag weiter.
  In der Kartenansicht steht, von wann die Preise sind.
- Viele Karten gibt es in mehreren Versionen (Editionen, Showcase, randlos, Promo, Foil). Der Knopf
  **„Genau diese Version auf Cardmarket“** öffnet exakt das Produkt mit derselben Foil-Einstellung.
  Unter dem Kartennamen stehen Edition, Nummer und Rahmen (von Scryfall), damit du die Version auf
  Cardmarket sicher wiedererkennst.
- Eigene Filter auf Cardmarket (Sprache, Zustand, Land) verändern den „ab“-Preis.
- „Stimmt der Preis?“ vergleicht den Preis-Trend zusätzlich mit Scryfall, das die Cardmarket-Werte
  ebenfalls einmal am Tag übernimmt.

## Schnellstart (Kommandozeile)

Voraussetzung: [Node.js](https://nodejs.org) ab Version 22.13. Es müssen keine Pakete installiert werden.

```bash
npm start        # echte Cardmarket-Daten, öffnet http://localhost:3000
npm run demo     # zum Ausprobieren mit erfundenen Daten
npm test         # Tests
node tools/update.js   # auf die neueste Version bringen (macht Start.bat automatisch)
```

Beim ersten Start lädt das Tool den kompletten Cardmarket-Preisguide für Magic (ca. 1 bis 2 Minuten).
Solange der Server läuft, holt er sich einmal am Tag die neuen Preise.

## Woher die Daten kommen

| Funktion | Quelle | Login nötig? |
|---|---|---|
| Suche, aktuelle Preise (Verkaufswert, Preis-Trend, ab, Ø 1/7/30 Tage) | Öffentlicher Cardmarket-Preisguide (`price_guide_1.json`) und Produktkatalog, täglich aktualisiert | Nein |
| Preisverlauf / Graphen | Das Tool speichert jeden Tag eine Momentaufnahme in `data/kartenhain.sqlite` | Nein |
| 5 günstigste Angebote mit Land | Offizielle Cardmarket-API v2.0 (`/articles/{idProduct}`) | **Ja** |
| Editionsnamen (Cardmarket-Editions-ID → Name) | MTGJSON `SetList.json` | Nein |
| Kartenbilder, Edition/Nummer/Rahmen, Gegenprobe | Scryfall (über die Cardmarket-ID) | Nein |

Kartenbilder fragt der Server bei Scryfall nur einmal pro Karte an, langsam nacheinander, und merkt sich das
Ergebnis. So bleibt das Tool unter dem Scryfall-Limit, auch wenn viele Bilder auf einmal zu sehen sind.
Die Schriften (Cinzel, Inter, OFL-Lizenz) liegen im Ordner `public/fonts` und werden nicht aus dem Internet
geladen.

## Verlauf und Speicherplatz

Cardmarket bietet keine langen Preis-Historien zum Download an. Der Verlauf füllt sich deshalb ab dem ersten
Start Tag für Tag. Bis genug Verlauf da ist, berechnet die Trend-Seite Gewinner und Verlierer aus dem
Cardmarket-Vergleich *7-Tage-Durchschnitt gegen 30-Tage-Durchschnitt*, das funktioniert sofort.

- Gespeichert wird jede Karte ab **0,10 €** (Verkaufswert oder Preis-Trend, normal oder Foil), Karten auf der
  Merkliste immer. Ändern mit `HISTORY_MIN_TREND`, z. B. `0.5` für eine kleinere Datenbank.
- Die letzten 100 Tage bleiben Tag für Tag erhalten, ältere Tage werden auf einen pro Woche ausgedünnt
  (gemerkte Karten behalten alles). Die Datenbank wächst in den ersten Monaten auf einige hundert MB und
  danach nur noch langsam.
- Die Trends nehmen den eigenen Verlauf nur, wenn er den gewählten Preisbereich vollständig enthält.
  Sonst steht über der Liste, dass der Cardmarket-Vergleich verwendet wird.

Am besten lässt du den Server dauerhaft laufen oder richtest einen täglichen Job für `npm run update` ein
(Windows: Aufgabenplanung, macOS/Linux: cron).

## Cardmarket-API für die günstigsten Angebote

Die einzelnen Angebote mit Verkäuferland gibt es nur über die offizielle API. Ohne Zugang zeigt das Tool
den Ab-Preis aus dem Preisguide und einen Link zu den Angeboten auf Cardmarket.

1. Auf Cardmarket einloggen, unter **Konto → API-Einstellungen** eine *Dedicated App* anlegen
   (Cardmarket vergibt API-Zugänge nicht an jedes Konto; ggf. beim Support anfragen).
2. `.env.example` nach `.env` kopieren und die vier Werte eintragen:
   `CARDMARKET_APP_TOKEN`, `CARDMARKET_APP_SECRET`, `CARDMARKET_ACCESS_TOKEN`, `CARDMARKET_ACCESS_SECRET`.
3. Das Tool neu starten.

Angebote werden 10 Minuten zwischengespeichert, um das API-Tageslimit zu schonen.

Bitte die Nutzungsbedingungen von Cardmarket beachten. Das Tool nutzt nur die offiziellen Downloads und die
offizielle API, es liest keine Webseiten aus.

## Einstellungen (`.env`)

| Name | Standard | Wofür |
|---|---|---|
| `PORT` | `3000` | Adresse im Browser: `http://localhost:PORT` |
| `CARDMARKET_FEE_PERCENT` | `5` | Cardmarket-Provision in Prozent für „nach Gebühr“ |
| `HISTORY_MIN_TREND` | `0.1` | Verlauf nur für Karten ab diesem Preis (Euro) speichern |
| `KARTENHAIN_NO_UPDATE` | leer | `1` = kein automatisches Update beim Start |
| `CARDMARKET_APP_TOKEN` usw. | leer | Zugang zur Cardmarket-API (siehe oben) |

## Aufbau

```
Start.bat            Startet das Tool, holt vorher Updates (bleibt selbst immer gleich)
tools/start.cmd      Prüft Node.js und startet den Server
tools/update.js      Automatisches Update von GitHub
src/server.js        Webserver + API-Routen
src/cardmarket.js    Import Preisguide/Katalog, Verlauf, Cardmarket-API (OAuth 1.0)
src/trends.js        Suche, Trends, Verkaufswert
src/market.js        Übersicht, Schnäppchen, Meine Karten
src/scryfall.js      Kartenbilder und Gegenprobe (gedrosselt, zwischengespeichert)
src/selfupdate.js    Update: GitHub fragen, Download prüfen, Dateien ersetzen
src/db.js            SQLite (eingebaut in Node.js)
src/demo.js          Demo-Daten
public/              Oberfläche (HTML/CSS/JS, Graphen als SVG, Schriften)
test/                Tests (node --test)
```
