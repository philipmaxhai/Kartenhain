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
    { idProduct: 3, avg: 60, low: 50, trend: ring, avg1: 60, avg7: 55, avg30: 70 },
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
  assert.equal(r.history, 3); // Karte 4 liegt unter 0,50 €
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
  assert.equal(groups[0].minTrend, 1);
  assert.equal(groups[0].maxTrend, 2);
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

test('Schnäppchen: günstigstes Angebot weit unter Preis-Trend', () => {
  const db = freshDb();
  importPriceData(db, { catalog, priceGuide: guide('2026-11-01', 60, 2.4) });
  // One Ring: ab 50 € bei Trend 60 € -> nur 17 % günstiger; Bolt 1: 1,10 bei 2,40 €; Bolt 2: 0,50 bei 1 €
  assert.deepEqual(deals(db, { minPrice: 0.5, maxRatio: 0.7 }).map((r) => r.id), [1, 2]);
  assert.deepEqual(deals(db, { minPrice: 0.5, maxRatio: 0.9 }).map((r) => r.id), [3, 1, 2]); // nach € sortiert
  assert.deepEqual(deals(db, { minPrice: 0.5, maxRatio: 0.9, sort: 'pct' }).map((r) => r.id), [1, 2, 3]);
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
  assert.equal(p.value, 2 * 66 + 4 * 2);
  assert.equal(p.cost, 100);
  assert.equal(p.profit, 2 * 66 - 100); // nur Karten mit Einkaufspreis zählen zum Gewinn
  assert.deepEqual(p.alerts.map((a) => [a.id, a.alert]), [[3, 'above']]);
  assert.deepEqual(p.history.map((h) => h.value), [2 * 60 + 4 * 2, 2 * 66 + 4 * 2]);
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
    assert.equal(w[0].profit, 3 * 60 - 120);
    assert.equal((await fetch(base + '/api/watchlist/3', { method: 'PUT', body: '{kaputt' })).status, 400);
    const mv = await fetch(base + '/api/movers?direction=down&minPrice=1&maxPrice=10').then((r) => r.json());
    assert.deepEqual(mv.rows.map((r) => r.id), [2]);
  });
});
