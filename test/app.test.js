import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { importPriceData, importSets, cheapest, oauthHeader, hasApiCredentials } from '../src/cardmarket.js';
import { searchCards, getCard, topMovers, setWatched, getWatchlist, historyChange } from '../src/trends.js';
import { countryInfo } from '../src/countries.js';
import { createApp } from '../src/server.js';
import { seedDemo } from '../src/demo.js';

const catalog = {
  version: 1,
  products: [
    { idProduct: 1, name: 'Lightning Bolt', idExpansion: 10, idMetacard: 100, categoryName: 'Magic Single' },
    { idProduct: 2, name: 'Lightning Bolt', idExpansion: 11, idMetacard: 100, categoryName: 'Magic Single' },
    { idProduct: 3, name: 'The One Ring', idExpansion: 12, idMetacard: 101, categoryName: 'Magic Single' },
    { idProduct: 4, name: 'Cheap Common', idExpansion: 12, idMetacard: 102, categoryName: 'Magic Single' },
  ],
};
const guide = (day, ring, bolt) => ({
  version: 1,
  createdAt: `${day}T02:00:00+0100`,
  priceGuides: [
    { idProduct: 1, avg: 2, low: 1.1, trend: bolt, avg1: 2, avg7: 2.5, avg30: 2, 'trend-foil': 4.5, 'avg7-foil': 4, 'avg30-foil': 5 },
    { idProduct: 2, avg: 1, low: 0.5, trend: 1, avg1: 1, avg7: 1, avg30: 1.25 },
    { idProduct: 3, avg: 60, low: 50, trend: ring, avg1: 60, avg7: ring - 5, avg30: 70 },
    { idProduct: 4, avg: 0.05, low: 0.02, trend: 0.04, avg1: 0.05, avg7: 0.06, avg30: 0.03 },
  ],
});

function freshDb() {
  return openDb(':memory:');
}

test('Import speichert Karten, Preise und Verlauf (ohne Billigkarten)', () => {
  const db = freshDb();
  const r = importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2), day: '2026-11-01' });
  assert.equal(r.products, 4);
  assert.equal(r.prices, 4);
  assert.equal(r.history, 3); // Karte 4 liegt unter 0,10 €
  assert.equal(db.prepare('SELECT trend FROM prices WHERE id = 3').get().trend, 60);
});

test('Merkliste-Karten bekommen immer Verlauf', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2), day: '2026-11-01' });
  setWatched(db, 4, true);
  importPriceData(db, { catalog, priceGuide: guide('2026-11-02', 60, 2), day: '2026-11-02' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM history WHERE id = 4').get().n, 1);
  assert.equal(getWatchlist(db)[0].name, 'Cheap Common');
});

test('Suche findet Namen, exakte Treffer zuerst', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  const groups = searchCards(db, 'bolt');
  assert.equal(groups.length, 1); // eine Karte ...
  assert.equal(groups[0].count, 2); // ... in zwei Versionen
  assert.deepEqual(groups[0].versions.map((v) => v.id), [2, 1]); // günstigste zuerst
  // Verkaufswert = Ø 7 Tage: Bolt 2 = 1 €, Bolt 1 = 2,50 €
  assert.equal(groups[0].minSale, 1);
  assert.equal(groups[0].maxSale, 2.5);
  assert.equal(groups[0].versions[1].sale_value, 2.5);
  assert.equal(groups[0].versions[1].sale_value_foil, 4);
  assert.equal(searchCards(db, 'one ring')[0].versions[0].id, 3);
  assert.deepEqual(searchCards(db, 'x'), []);
  assert.deepEqual(searchCards(db, '%%'), []);
});

test('Trends aus dem Preisguide, solange kein eigener Verlauf da ist', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  const up = topMovers(db, { direction: 'up', minPrice: 1 });
  assert.equal(up.source, 'guide');
  assert.deepEqual(up.rows.map((r) => r.id), [1]); // 2,5 vs 2,0 = +25 %
  assert.ok(Math.abs(up.rows[0].change - 0.25) < 1e-9);
  const down = topMovers(db, { direction: 'down', minPrice: 1 });
  assert.deepEqual(down.rows.map((r) => r.id), [3, 2]); // −21 %, −20 %
  const foil = topMovers(db, { direction: 'down', minPrice: 1, foil: true });
  assert.deepEqual(foil.rows.map((r) => r.id), [1]);
});

test('Ausreißer ohne passenden Trendpreis werden ignoriert', () => {
  const db = freshDb();
  // Karte 1: Ø 7 Tage über Ø 30 Tage, aber Trendpreis (2,0) nicht -> kein echter Anstieg
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  assert.deepEqual(topMovers(db, { direction: 'up', minPrice: 1 }).rows, []);
});

test('Trends aus eigenem Verlauf, sobald genug Tage gespeichert sind', () => {
  const db = freshDb();
  const days = ['2026-11-01', '2026-11-04', '2026-11-08'];
  const ring = [60, 66, 75];
  const bolt = [2, 1.8, 1.5];
  days.forEach((d, i) => importPriceData(db, { catalog, priceGuide: guide(d, ring[i], bolt[i]), day: d }));
  const up = topMovers(db, { direction: 'up', minPrice: 1, days: 7 });
  assert.equal(up.source, 'history');
  assert.equal(up.from, '2026-11-01');
  assert.equal(up.rows[0].id, 3);
  assert.ok(Math.abs(up.rows[0].change - 0.25) < 1e-9);
  const down = topMovers(db, { direction: 'down', minPrice: 1, days: 7 });
  assert.equal(down.rows[0].id, 1);

  const card = getCard(db, 3);
  assert.equal(card.history.length, 3);
  assert.ok(Math.abs(card.historyChange.d7 - 0.25) < 1e-9);
  assert.equal(card.historyChange.d30, null); // Verlauf deckt 30 Tage nicht ab
});

test('Editionsnamen aus MTGJSON werden den Karten zugeordnet', () => {
  const db = freshDb();
  importSets(db, { data: [
    { code: 'M11', name: 'Magic 2011', mcmId: 10, mcmName: 'Magic 2011' },
    { code: 'LEA', name: 'Limited Edition Alpha', mcmId: 11, mcmIdExtras: 99, releaseDate: '1993-08-05' },
  ] });
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  const v = searchCards(db, 'bolt')[0].versions;
  assert.equal(v[0].set_name, 'Limited Edition Alpha');
  assert.equal(v[0].release_date, '1993-08-05');
  assert.equal(v[1].set_name, 'Magic 2011');
  assert.equal(getCard(db, 1).set_code, 'M11');
  assert.equal(db.prepare('SELECT name FROM expansions WHERE id = 99').get().name, 'Limited Edition Alpha: Extras');
});

test('historyChange braucht genug Abdeckung', () => {
  const h = [{ day: '2026-01-01', trend: 10 }, { day: '2026-01-02', trend: 12 }];
  assert.equal(historyChange(h, 30), null);
  assert.ok(Math.abs(historyChange(h, 1) - 0.2) < 1e-9);
});

test('Günstigste 5 Angebote, sortiert, mit Land', () => {
  const articles = [9, 3, 7, 1, 5, 2, 8].map((price, i) => ({
    price, condition: 'NM', language: { languageName: 'English' }, isFoil: false,
    seller: { username: `s${i}`, address: { country: i === 3 ? 'D' : 'FR' } },
  }));
  const best = cheapest(articles, 5);
  assert.deepEqual(best.map((o) => o.price), [1, 2, 3, 5, 7]);
  assert.equal(best[0].country.code, 'DE');
  assert.equal(best[0].country.name, 'Deutschland');
  assert.equal(best[0].country.flag, '🇩🇪');
  assert.equal(countryInfo('FR').name, 'Frankreich');
});

test('OAuth-Header enthält Signatur und realm ohne Query', () => {
  const creds = { appToken: 'app', appSecret: 'appsec', accessToken: 'acc', accessSecret: 'accsec' };
  const url = 'https://api.cardmarket.com/ws/v2.0/output.json/articles/123?start=0&maxResults=100';
  const h1 = oauthHeader('GET', url, creds, { nonce: 'n', timestamp: 1 });
  const h2 = oauthHeader('GET', url, creds, { nonce: 'n', timestamp: 1 });
  const h3 = oauthHeader('GET', url.replace('start=0', 'start=1'), creds, { nonce: 'n', timestamp: 1 });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3); // Query-Parameter fließen in die Signatur ein
  assert.match(h1, /^OAuth realm="https%3A%2F%2Fapi\.cardmarket\.com%2Fws%2Fv2\.0%2Foutput\.json%2Farticles%2F123"/);
  assert.match(h1, /oauth_signature="[^"]+"/);
  assert.equal(hasApiCredentials({}), false);
});

async function withServer(app, fn) {
  const srv = http.createServer(app.handler);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

test('HTTP-API: Suche, Karte, Merkliste, Angebote', async () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  const env = { CARDMARKET_APP_TOKEN: 'a', CARDMARKET_APP_SECRET: 'b', CARDMARKET_ACCESS_TOKEN: 'c', CARDMARKET_ACCESS_SECRET: 'd' };
  let calls = 0;
  const fetchOffers = async (id, filters) => {
    calls++;
    return cheapest([{ price: 4, seller: { address: { country: 'IT' } }, isFoil: filters.foil }]);
  };
  await withServer(createApp({ db, env, fetchOffers }), async (base) => {
    const get = (p) => fetch(base + p).then((r) => r.json());
    assert.equal((await get('/api/search?q=ring'))[0].versions[0].id, 3);
    assert.equal((await get('/api/card/3')).name, 'The One Ring');
    assert.equal((await fetch(base + '/api/card/999')).status, 404);
    await fetch(base + '/api/watchlist/3', { method: 'POST' });
    assert.equal((await get('/api/watchlist')).length, 1);
    const o = await get('/api/card/3/offers?minCondition=NM');
    assert.equal(o.source, 'cardmarket');
    assert.equal(o.offers[0].country.name, 'Italien');
    await get('/api/card/3/offers?minCondition=NM');
    assert.equal(calls, 1); // zwischengespeichert
    assert.equal((await get('/api/status')).products, 4);
    const html = await fetch(base + '/').then((r) => r.text());
    assert.match(html, /Kartenhain/);
    assert.equal((await fetch(base + '/../package.json')).status, 404);
  });
});

test('Ohne API-Zugang gibt es einen Hinweis statt Angeboten', async () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  await withServer(createApp({ db, env: {} }), async (base) => {
    const o = await fetch(base + '/api/card/3/offers').then((r) => r.json());
    assert.equal(o.source, 'none');
    assert.match(o.message, /API/);
  });
});

test('Demo-Daten erzeugen Verlauf und Angebote', async () => {
  const db = freshDb();
  const n = seedDemo(db, { days: 60, endDay: '2026-11-17' });
  assert.ok(n >= 30);
  const movers = topMovers(db, { direction: 'up', minPrice: 1, days: 30 });
  assert.equal(movers.source, 'history');
  await withServer(createApp({ db, env: { DEMO: '1' } }), async (base) => {
    const o = await fetch(base + '/api/card/900001/offers').then((r) => r.json());
    assert.equal(o.offers.length, 5);
    assert.ok(o.offers[0].price <= o.offers[4].price);
  });
});

// ---------------------------------------------------------------------------
// Übersicht, Schnäppchen, Bestand, Filter
// ---------------------------------------------------------------------------
import { dashboard, deals, portfolio, histogram, listSets } from '../src/market.js';
import { updateWatch } from '../src/trends.js';

test('Trends filtern nach Preisbereich, Edition, Name und sortieren nach €', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  const down = (o) => topMovers(db, { direction: 'down', minPrice: 1, ...o }).rows.map((r) => r.id);
  assert.deepEqual(down({}), [3, 2]);
  assert.deepEqual(down({ maxPrice: 10 }), [2]);
  assert.deepEqual(down({ setId: 12 }), [3]);
  assert.deepEqual(down({ q: 'bolt' }), [2]);
  // nach € statt %: One Ring fällt um 15 €, Bolt nur um 0,25 €
  assert.deepEqual(down({ sort: 'abs' }), [3, 2]);
  const up = topMovers(db, { direction: 'up', minPrice: 1 });
  assert.deepEqual(up.rows[0].spark, { kind: 'guide', values: [2, 2.5, 2, 2.4] });
});

test('Übersicht: Marktstimmung und Verteilung', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  const d = dashboard(db, { minPrice: 1 });
  assert.equal(d.cards, 3);
  assert.equal(dashboard(db, { minPrice: 0, maxPrice: 1 }).cards, 2); // nur günstige Karten
  assert.deepEqual(dashboard(db, { minPrice: 0, maxPrice: 3 }).mostValuable.map((r) => r.id), [1, 2, 4]);
  assert.equal(d.up, 1);
  assert.equal(d.down, 2);
  assert.equal(d.histogram.reduce((a, b) => a + b.count, 0), 3);
  assert.equal(d.gainers.rows[0].id, 1);
  assert.equal(d.mostValuable[0].id, 3);
  const h = histogram([-0.9, 0, 0.049, 0.9]);
  assert.equal(h.length, 20);
  assert.equal(h[0].count, 1);
  assert.equal(h[10].count, 2);
  assert.equal(h[19].count, 1);
});

test('Schnäppchen: günstigstes Angebot weit unter dem Verkaufswert (Ø 7 Tage)', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  // Verkaufswert = Ø 7 Tage. Bolt 1: ab 1,10 bei 2,50 €; Bolt 2: ab 0,50 bei 1 €; One Ring: ab 50 bei 55 €
  const ids = (o) => deals(db, { minPrice: 0.5, ...o }).map((r) => r.id);
  assert.deepEqual(ids({ maxRatio: 0.7 }), [1, 2]);
  assert.deepEqual(ids({ maxRatio: 0.95 }), [3, 1, 2]); // nach € sortiert
  assert.deepEqual(ids({ maxRatio: 0.95, sort: 'pct' }), [1, 2, 3]);
  assert.deepEqual(ids({ maxRatio: 0.95, maxPrice: 2 }), [2]); // Preisbereich bis 2 €
  const d = deals(db, { minPrice: 0.5, maxRatio: 0.7 })[0];
  assert.equal(d.sale_value, 2.5);
  assert.ok(Math.abs(d.spread - 1.4) < 1e-9);
});

test('Meine Karten: Menge, Einkaufspreis, Gewinn, Alarme, Wertverlauf', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2), day: '2026-11-01' });
  updateWatch(db, 3, { qty: 2, buy_price: 50, alert_above: 55 });
  updateWatch(db, 1, { qty: 4, alert_below: '' });
  importPriceData(db, { catalog, priceGuide: guide('2026-11-02', 66, 2), day: '2026-11-02' });
  const p = portfolio(db);
  assert.equal(p.owned, 2);
  assert.equal(p.copies, 6);
  // Wert = echter Verkaufswert (Ø 7 Tage): One Ring 61 €, Bolt 2,50 €
  assert.equal(p.value, 2 * 61 + 4 * 2.5);
  assert.equal(p.cost, 100);
  assert.equal(p.profit, 2 * 61 - 100); // nur Karten mit Einkaufspreis zählen zum Gewinn
  assert.deepEqual(p.alerts.map((a) => [a.id, a.alert]), [[3, 'above']]);
  assert.deepEqual(p.history.map((h) => h.value), [2 * 55 + 4 * 2.5, 2 * 61 + 4 * 2.5]);
  // Feld leeren
  updateWatch(db, 3, { alert_above: '' });
  assert.equal(portfolio(db).alerts.length, 0);
});

test('Editionsliste für Filter', () => {
  const db = freshDb();
  importSets(db, { data: [{ code: 'M11', name: 'Magic 2011', mcmId: 10, releaseDate: '2010-07-16' }] });
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  assert.deepEqual(listSets(db).map((s) => [s.code, s.cards]), [['M11', 1]]);
});

test('HTTP-API: Übersicht, Schnäppchen, Bestand speichern', async () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  await withServer(createApp({ db, env: {} }), async (base) => {
    assert.equal((await fetch(base + '/api/dashboard?minPrice=1').then((r) => r.json())).cards, 3);
    assert.ok(Array.isArray(await fetch(base + '/api/deals').then((r) => r.json())));
    const put = await fetch(base + '/api/watchlist/3', { method: 'PUT', body: JSON.stringify({ qty: 3, buy_price: 40 }) });
    assert.equal(put.status, 200);
    const w = await fetch(base + '/api/watchlist').then((r) => r.json());
    assert.equal(w[0].qty, 3);
    assert.equal(w[0].profit, 3 * 55 - 120); // Verkaufswert 55 €
    assert.equal((await fetch(base + '/api/watchlist/3', { method: 'PUT', body: '{kaputt' })).status, 400);
    const mv = await fetch(base + '/api/movers?direction=down&minPrice=1&maxPrice=10').then((r) => r.json());
    assert.deepEqual(mv.rows.map((r) => r.id), [2]);
  });
});

// ---------------------------------------------------------------------------
// Echter Verkaufswert, fehlende Werte, Version
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saleValue, saleSql } from '../src/trends.js';
import { feePercent, readVersion } from '../src/server.js';

test('0 im Preisguide heißt "kein Wert", reine Foil-Karten werden erkannt', () => {
  const db = freshDb();
  importPriceData(db, {
    catalog: { products: [
      { idProduct: 7, name: 'Foil Promo', idExpansion: 12 },
      { idProduct: 8, name: 'Foil Promo', idExpansion: 11 },
    ] },
    priceGuide: { createdAt: '2026-11-10T01:48:00+0100', priceGuides: [
      // nur Foil: normale Werte stehen auf 0
      { idProduct: 7, avg: 0, low: 0, trend: 0, avg1: 0, avg7: 0, avg30: 0, 'low-foil': 3, 'trend-foil': 4, 'avg7-foil': 4.5, 'avg30-foil': 4 },
      // normale Version ohne Foil und ohne Verkäufe in den letzten 7 Tagen
      { idProduct: 8, avg: 1, low: 0.8, trend: 1.2, avg1: 0, avg7: 0, avg30: 1.1, 'trend-foil': 0, 'avg7-foil': 0 },
    ] },
  });
  const p7 = db.prepare('SELECT * FROM prices WHERE id = 7').get();
  assert.equal(p7.trend, null);
  assert.equal(p7.trend_foil, 4);
  const [g] = searchCards(db, 'foil promo');
  const [v8, v7] = g.versions; // 1,20 € (Trend, weil keine Verkäufe) vor 4,50 € (Foil)
  assert.equal(v8.id, 8);
  assert.equal(v8.sale_value, 1.2);
  assert.equal(v8.sale_value_foil, null);
  assert.equal(v8.foil_only, false);
  assert.equal(v7.foil_only, true);
  assert.equal(v7.price_value, 4.5);
  assert.equal(g.maxSale, 4.5);
  // Verlaufstag = Erstellungstag der Preisliste
  assert.equal(db.prepare('SELECT day FROM history WHERE id = 8').get().day, '2026-11-10');
});

test('Verkaufswert: Ø 7 Tage, sonst Preis-Trend, sonst Ø 30 Tage (JS und SQL gleich)', () => {
  const cases = [
    [{ avg7: 2, trend: 3, avg30: 4 }, 2],
    [{ avg7: null, trend: 3, avg30: 4 }, 3],
    [{ avg7: 0, trend: 0, avg30: 4 }, 4],
    [{ avg7: null, trend: null, avg30: null }, null],
  ];
  const db = freshDb();
  for (const [p, want] of cases) {
    assert.equal(saleValue(p), want);
    const got = db.prepare(`SELECT ${saleSql()} AS v FROM (SELECT ? AS avg7, ? AS trend, ? AS avg30) p`).get(p.avg7, p.trend, p.avg30).v;
    assert.equal(got, want);
  }
  assert.equal(saleValue({ avg7_foil: 9, trend_foil: 8 }, true), 9);
});

test('Alte Datenbank: Nullen werden beim Start einmalig zu "kein Wert"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const file = path.join(dir, 'alt.sqlite');
  let db = openDb(file);
  db.exec("INSERT INTO prices (id, trend, trend_foil, low) VALUES (1, 2.5, 0, 0); INSERT INTO history (id, day, trend, trend_foil) VALUES (1, '2026-11-01', 2.5, 0); DELETE FROM meta WHERE key = 'zeroIsMissing';");
  db.close();
  db = openDb(file);
  assert.deepEqual({ ...db.prepare('SELECT trend, trend_foil, low FROM prices WHERE id = 1').get() }, { trend: 2.5, trend_foil: null, low: null });
  assert.equal(db.prepare('SELECT trend_foil FROM history WHERE id = 1').get().trend_foil, null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Trends und Übersicht: Preisbereich gilt für den Verkaufswert', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  // Bolt 1: Verkaufswert (Ø 7 Tage) 2,50 €, Preis-Trend 2,40 €
  const up = (o) => topMovers(db, { direction: 'up', ...o }).rows.map((r) => r.id);
  assert.deepEqual(up({ minPrice: 2.45 }), [1]);
  assert.deepEqual(up({ minPrice: 0.1, maxPrice: 2.45 }), []);
  assert.equal(topMovers(db, { direction: 'up' }).rows[0].sale_value, 2.5);
  // Ausreißer: ein Fehlkauf treibt den Ø 7 Tage auf das 10-Fache des Trends -> nicht "wertvollste Karte"
  db.prepare('UPDATE prices SET avg7 = 900 WHERE id = 4').run();
  assert.ok(!dashboard(db, { minPrice: 0 }).mostValuable.some((r) => r.id === 4));
  assert.equal(dashboard(db, { minPrice: 0 }).mostValuable[0].sale_value, 55);
});

test('Gebühr und Version', () => {
  assert.equal(feePercent({}), 5);
  assert.equal(feePercent({ CARDMARKET_FEE_PERCENT: '' }), 5);
  assert.equal(feePercent({ CARDMARKET_FEE_PERCENT: '6,5' }), 6.5);
  assert.equal(feePercent({ CARDMARKET_FEE_PERCENT: '0' }), 0);
  assert.equal(feePercent({ CARDMARKET_FEE_PERCENT: 'abc' }), 5);
  assert.equal(feePercent({ CARDMARKET_FEE_PERCENT: '150' }), 5);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  assert.equal(readVersion(dir), null); // manuell installiert
  fs.writeFileSync(path.join(dir, 'version.txt'), '﻿0123456789abcdef0123456789abcdef01234567\r\n2026-11-17T20:15:00Z\r\n');
  assert.deepEqual(readVersion(dir), { sha: '0123456', date: '2026-11-17T20:15:00Z' });
  fs.writeFileSync(path.join(dir, 'version.txt'), 'kaputt');
  assert.equal(readVersion(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Status meldet Gebühr und Version', async () => {
  const db = freshDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  fs.writeFileSync(path.join(dir, 'version.txt'), 'abcdef1234567\n2026-11-17T20:15:00Z\n');
  await withServer(createApp({ db, env: { CARDMARKET_FEE_PERCENT: '4' }, root: dir }), async (base) => {
    const s = await fetch(base + '/api/status').then((r) => r.json());
    assert.equal(s.feePercent, 4);
    assert.deepEqual(s.version, { sha: 'abcdef1', date: '2026-11-17T20:15:00Z' });
    assert.equal(s.update, null);
  });
  await withServer(createApp({ db, root: dir, updateInfo: () => ({ available: true, date: '2026-11-18T09:00:00Z' }) }), async (base) => {
    const s = await fetch(base + '/api/status').then((r) => r.json());
    assert.deepEqual(s.update, { available: true, date: '2026-11-18T09:00:00Z' });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scryfall: Bilder und Gegenprobe, gedrosselt und zwischengespeichert
// ---------------------------------------------------------------------------
import { createScryfall, pickCard } from '../src/scryfall.js';

const scryCard = {
  set_name: 'Magic 2010', set: 'm10', collector_number: '146', rarity: 'common', lang: 'en',
  border_color: 'black', frame_effects: ['showcase'],
  image_uris: { small: 'https://cards.scryfall.io/small/bolt.jpg', normal: 'https://cards.scryfall.io/normal/bolt.jpg' },
  prices: { eur: '2.41', eur_foil: null },
  purchase_uris: { cardmarket: 'https://www.cardmarket.com/en/Magic/Products?idProduct=1&referrer=scryfall' },
};

function fakeFetch(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const id = Number(url.split('/').pop());
    const v = map[id];
    if (v instanceof Error) throw v;
    if (typeof v === 'number') return { ok: false, status: v, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => v };
  };
  fn.calls = calls;
  return fn;
}

test('Scryfall-Daten: Bild, Sammlernummer, Preis, doppelseitige Karten', () => {
  const p = pickCard(scryCard);
  assert.equal(p.small, 'https://cards.scryfall.io/small/bolt.jpg');
  assert.equal(p.set_code, 'M10');
  assert.equal(p.eur, 2.41);
  assert.equal(p.eur_foil, null);
  assert.equal(p.frame, 'Showcase');
  const dfc = pickCard({ card_faces: [{ image_uris: { small: 'vorne.jpg', normal: 'vorne-gross.jpg' } }, { image_uris: { small: 'hinten.jpg' } }] });
  assert.equal(dfc.small, 'vorne.jpg');
  assert.equal(pickCard(null).small, null);
});

test('Scryfall wird pro Karte nur einmal gefragt, Fehler werden nicht wiederholt', async () => {
  const db = freshDb();
  const f = fakeFetch({ 1: scryCard, 2: 404, 3: new Error('offline') });
  const s = createScryfall(db, { fetchImpl: f, gapMs: 0 });
  const [a, b] = await Promise.all([s.info(1), s.info(1)]); // gleichzeitig: eine Anfrage
  assert.equal(a.status, 200);
  assert.equal(b.small, scryCard.image_uris.small);
  await s.info(1);
  assert.equal(f.calls.length, 1); // aus dem Speicher
  assert.equal((await s.info(2)).status, 404);
  await s.info(2);
  assert.equal(f.calls.length, 2); // unbekannte Karte wird nicht ständig neu gefragt
  assert.equal((await s.info(3)).status, 0);
  await s.info(3);
  assert.equal(f.calls.length, 3); // nach einem Verbindungsfehler erst später wieder
  // Preise dürfen höchstens 12 Stunden alt sein: dann wird neu gefragt
  db.prepare("UPDATE scryfall SET fetched = '2000-01-01T00:00:00Z' WHERE id = 1").run();
  await s.info(1, { maxAgeMs: 12 * 3600 * 1000 });
  assert.equal(f.calls.length, 4);
});

test('Bilder: Weiterleitung auf Scryfall, im Demo-Modus Platzhalter', async () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2) });
  const scryfall = createScryfall(db, { fetchImpl: fakeFetch({ 1: scryCard, 2: 404 }), gapMs: 0 });
  await withServer(createApp({ db, env: {}, scryfall }), async (base) => {
    const r = await fetch(base + '/img/1?v=normal', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), scryCard.image_uris.normal);
    assert.equal((await fetch(base + '/img/1', { redirect: 'manual' })).headers.get('location'), scryCard.image_uris.small);
    assert.equal((await fetch(base + '/img/2', { redirect: 'manual' })).status, 404);
    const info = await fetch(base + '/api/card/1/scryfall').then((x) => x.json());
    assert.equal(info.found, true);
    assert.equal(info.eur, 2.41);
    assert.equal(info.number, '146');
  });
  await withServer(createApp({ db, env: { DEMO: '1' }, scryfall }), async (base) => {
    assert.equal((await fetch(base + '/img/1', { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(base + '/api/card/1/scryfall').then((x) => x.json())).found, false);
  });
});

// ---------------------------------------------------------------------------
// Verlauf: auch günstige Karten, ausgedünnt, Trends nur aus vollständigem Verlauf
// ---------------------------------------------------------------------------
import { historyMin, thinHistory } from '../src/cardmarket.js';

const cheapGuide = (day, cheap, trend = 0.08) => ({
  version: 1,
  createdAt: `${day}T02:00:00+0100`,
  priceGuides: [
    { idProduct: 1, avg: 2, low: 1.1, trend: 2, avg1: 2, avg7: 2, avg30: 2 },
    { idProduct: 2, avg: 1, low: 0.5, trend: 1, avg1: 1, avg7: 1, avg30: 1 },
    { idProduct: 3, avg: 60, low: 50, trend: 60, avg1: 60, avg7: 60, avg30: 60 },
    // Preis-Trend unter 0,10 €, aber echte Verkäufe darüber: wird gespeichert
    { idProduct: 4, avg: cheap, low: 0.02, trend, avg1: cheap, avg7: cheap, avg30: 0.1 },
  ],
});

test('Verlauf ab 0,10 € (nach Verkaufswert), Untergrenze pro Tag gemerkt', () => {
  assert.equal(historyMin({}), 0.1);
  assert.equal(historyMin({ HISTORY_MIN_TREND: '0,3' }), 0.3);
  assert.equal(historyMin({ HISTORY_MIN_TREND: '0' }), 0);
  assert.equal(historyMin({ HISTORY_MIN_TREND: 'abc' }), 0.1);
  const db = freshDb();
  const r = importPriceData(db, { catalog, priceGuide: cheapGuide('2026-11-01', 0.12), day: '2026-11-01' });
  assert.equal(r.history, 4);
  assert.equal(db.prepare('SELECT floor FROM history_days WHERE day = ?').get('2026-11-01').floor, 0.1);
  const r2 = importPriceData(db, { catalog, priceGuide: cheapGuide('2026-11-02', 0.05), day: '2026-11-02', historyMinTrend: 0.5 });
  assert.equal(r2.history, 3);
  assert.equal(db.prepare('SELECT floor FROM history_days WHERE day = ?').get('2026-11-02').floor, 0.5);
});

test('Trends nehmen den eigenen Verlauf nur, wenn er den Preisbereich ganz abdeckt', () => {
  const db = freshDb();
  for (let d = 1; d <= 9; d++) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    importPriceData(db, { catalog, priceGuide: cheapGuide(day, 0.12 + d * 0.02, 0.1 + d * 0.02), day });
  }
  // alles ab 0,10 € gespeichert: Verlauf wird genutzt, die günstige Karte ist dabei
  const all = topMovers(db, { direction: 'up', minPrice: 0.1, days: 7 });
  assert.equal(all.source, 'history');
  assert.deepEqual(all.rows.map((r) => r.id), [4]);
  // Bereich unter der Speichergrenze: Vergleich aus der Preisliste, damit keine Karte fehlt
  const tiny = topMovers(db, { direction: 'up', minPrice: 0.02, days: 7 });
  assert.equal(tiny.source, 'guide');
  assert.equal(tiny.reason, 'floor');
  // Tage einer älteren Version (ohne Eintrag): galten ab 0,50 €
  db.exec('DELETE FROM history_days');
  assert.equal(topMovers(db, { minPrice: 0.1, days: 7 }).reason, 'floor');
  assert.equal(topMovers(db, { minPrice: 1, days: 7 }).source, 'history');
  // zu wenig Tage
  const longer = topMovers(db, { minPrice: 1, days: 30 });
  assert.equal(longer.source, 'guide');
  assert.equal(longer.reason, 'days');
});

test('Alter Verlauf wird auf einen Tag pro Woche ausgedünnt, gemerkte Karten behalten alles', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO history (id, day, trend) VALUES (?, ?, ?)');
  const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  for (let i = 0; i < 200; i++) for (const id of [1, 2]) ins.run(id, day(i), 1 + i / 100);
  setWatched(db, 2, true);
  const today = day(199);
  const removed = thinHistory(db, today);
  assert.ok(removed > 0);
  const days1 = db.prepare('SELECT day FROM history WHERE id = 1 ORDER BY day').all().map((r) => r.day);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 100 * 86400000).toISOString().slice(0, 10);
  const recent = days1.filter((d) => d >= cutoff);
  const old = days1.filter((d) => d < cutoff);
  assert.equal(recent.length, 101); // die letzten 100 Tage + heute: Tag für Tag
  // ältere Tage: höchstens einer pro Woche (Montag bis Sonntag)
  const weeks = old.map((d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); });
  assert.equal(new Set(weeks).size, weeks.length);
  assert.ok(old.length >= 13 && old.length <= 16);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history WHERE id = 2').get().n, 200); // gemerkt: alles
  assert.equal(thinHistory(db, today), 0); // zweimal ausdünnen ändert nichts
});
