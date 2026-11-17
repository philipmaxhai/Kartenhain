// Alles, was mit Cardmarket spricht:
//  1. Öffentliche Preisguide- und Produktkatalog-Dateien (täglich aktualisiert, kein Login nötig)
//  2. Die offizielle Cardmarket-API v2.0 für die aktuellen Einzelangebote samt Verkäuferland
//     (braucht eigene API-Zugangsdaten, siehe README).
import crypto from 'node:crypto';
import { tx, setMeta } from './db.js';
import { countryInfo } from './countries.js';

// Magic: The Gathering ist bei Cardmarket "Spiel 1".
export const PRICE_GUIDE_URL =
  'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
export const CATALOG_URL =
  'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_1.json';
// MTGJSON verknüpft Cardmarket-Editions-IDs (mcmId) mit Editionsnamen.
export const SETLIST_URL = 'https://mtgjson.com/api/v5/SetList.json';
export const API_BASE = 'https://api.cardmarket.com/ws/v2.0/output.json';

/**
 * Ab diesem Preis (Verkaufswert oder Preis-Trend, normal oder Foil) wird jede Karte täglich im
 * Verlauf gespeichert, gemerkte Karten immer. 0,10 € = die kleinste Preisstufe der Oberfläche,
 * damit die Trends auch für günstige Karten vollständig sind. Ändern mit HISTORY_MIN_TREND.
 */
export const HISTORY_MIN_DEFAULT = 0.1;
/** Die letzten so vielen Tage bleiben Tag für Tag erhalten, ältere werden ausgedünnt. */
export const HISTORY_DAILY_DAYS = 100;

export function historyMin(env = process.env) {
  const raw = String(env.HISTORY_MIN_TREND ?? '').trim().replace(',', '.');
  const v = Number(raw);
  return raw !== '' && Number.isFinite(v) && v >= 0 ? v : HISTORY_MIN_DEFAULT;
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
// Im Preisguide steht 0 für "gibt es nicht" (z. B. keine Foil-Version, keine Verkäufe in 7 Tagen).
// Der kleinste echte Preis auf Cardmarket ist 0,02 €, also ist 0 nie ein Preis.
const price = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };

export function today() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Kartenhain-Preistracker/1.0' } });
  } catch (e) {
    throw new Error(`Keine Verbindung zu Cardmarket (${e.cause?.code || e.message}). Bitte Internetverbindung prüfen.`);
  }
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}) für ${url}`);
  return res.json();
}

/** Lädt Katalog + Preisguide von Cardmarket und speichert sie. */
export async function downloadAndImport(db, opts = {}) {
  const [catalog, priceGuide, setList] = await Promise.all([
    fetchJson(CATALOG_URL),
    fetchJson(PRICE_GUIDE_URL),
    // Editionsnamen sind nur Komfort: wenn MTGJSON nicht erreichbar ist, trotzdem weitermachen
    fetchJson(SETLIST_URL).catch((e) => { console.warn('Editionsnamen nicht geladen:', e.message); return null; }),
  ]);
  if (setList) importSets(db, setList);
  return importPriceData(db, { catalog, priceGuide, ...opts });
}

/** Speichert Editionsnamen aus MTGJSON SetList.json (data[].mcmId / mcmIdExtras). */
export function importSets(db, setList) {
  const sets = setList?.data ?? [];
  const ins = db.prepare('INSERT OR REPLACE INTO expansions (id, name, code, release_date) VALUES (?, ?, ?, ?)');
  let n = 0;
  tx(db, () => {
    for (const s of sets) {
      if (s.mcmId) { ins.run(Number(s.mcmId), s.mcmName || s.name, s.code ?? null, s.releaseDate ?? null); n++; }
      if (s.mcmIdExtras) { ins.run(Number(s.mcmIdExtras), `${s.mcmName || s.name}: Extras`, s.code ?? null, s.releaseDate ?? null); n++; }
    }
  });
  return n;
}

/**
 * Schreibt geparste Cardmarket-Dateien in die Datenbank.
 * - products: alle Magic-Einzelkarten
 * - prices:   aktueller Preisguide
 * - history:  Momentaufnahme für heute (nur Karten ab `historyMinTrend` € oder auf der Merkliste,
 *             damit die Datenbank nicht explodiert); ältere Tage werden danach ausgedünnt
 */
export function importPriceData(db, { catalog, priceGuide, day, historyMinTrend = HISTORY_MIN_DEFAULT }) {
  const products = catalog?.products ?? [];
  const guides = priceGuide?.priceGuides ?? [];
  if (!guides.length) throw new Error('Preisguide ist leer oder hat ein unbekanntes Format.');
  const updated = priceGuide.createdAt ?? new Date().toISOString();
  // Verlaufstag = Tag, an dem Cardmarket die Preisliste erstellt hat (nicht der Tag des Downloads)
  day ??= /^\d{4}-\d{2}-\d{2}/.test(priceGuide.createdAt ?? '') ? priceGuide.createdAt.slice(0, 10) : today();

  const watch = new Set(db.prepare('SELECT id FROM watchlist').all().map((r) => r.id));

  const insProduct = db.prepare(`
    INSERT INTO products (id, name, expansion_id, metacard_id, category, date_added)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, expansion_id = excluded.expansion_id,
      metacard_id = excluded.metacard_id, category = excluded.category, date_added = excluded.date_added`);
  const insPrice = db.prepare(`
    INSERT OR REPLACE INTO prices (id, avg, low, trend, avg1, avg7, avg30,
      avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insHist = db.prepare(`
    INSERT OR REPLACE INTO history (id, day, trend, low, avg1, trend_foil, avg7, avg7_foil) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  let histCount = 0;
  tx(db, () => {
    for (const p of products) {
      if (p.idProduct == null || !p.name) continue;
      insProduct.run(p.idProduct, p.name, p.idExpansion ?? null, p.idMetacard ?? null,
        p.categoryName ?? null, p.dateAdded ?? null);
    }
    for (const g of guides) {
      if (g.idProduct == null) continue;
      const trend = price(g.trend);
      const trendFoil = price(g['trend-foil']);
      const avg7 = price(g.avg7);
      const avg7Foil = price(g['avg7-foil']);
      insPrice.run(g.idProduct, price(g.avg), price(g.low), trend, price(g.avg1), avg7, price(g.avg30),
        price(g['avg-foil']), price(g['low-foil']), trendFoil, price(g['avg1-foil']), avg7Foil,
        price(g['avg30-foil']), updated);
      // Höchster der Werte, nach denen die Oberfläche filtert (Verkaufswert, notfalls Preis-Trend)
      const top = Math.max(trend ?? 0, avg7 ?? 0, trendFoil ?? 0, avg7Foil ?? 0);
      if (watch.has(g.idProduct) || top >= historyMinTrend) {
        insHist.run(g.idProduct, day, trend, price(g.low), price(g.avg1), trendFoil, avg7, avg7Foil);
        histCount++;
      }
    }
    db.prepare('INSERT OR REPLACE INTO history_days (day, floor) VALUES (?, ?)').run(day, historyMinTrend);
  });
  thinHistory(db, day);
  setMeta(db, 'lastUpdate', new Date().toISOString());
  setMeta(db, 'priceGuideCreatedAt', updated);
  return { products: products.length, prices: guides.length, history: histCount, day };
}

/**
 * Hält die Datenbank klein: Die letzten HISTORY_DAILY_DAYS Tage bleiben Tag für Tag (genug für
 * Trends über 7, 30 und 90 Tage), ältere Tage werden auf einen pro Woche ausgedünnt.
 * Gemerkte Karten behalten ihren ganzen Verlauf. Gibt die Zahl der gelöschten Einträge zurück.
 */
export function thinHistory(db, today, { dailyDays = HISTORY_DAILY_DAYS } = {}) {
  const cutoff = addDays(today, -dailyDays);
  const days = db.prepare('SELECT DISTINCT day FROM history WHERE day < ? ORDER BY day').all(cutoff).map((r) => r.day);
  const seen = new Set();
  const drop = days.filter((d) => {
    const week = addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7)); // Montag der Woche
    if (seen.has(week)) return true;
    seen.add(week);
    return false; // erster Tag der Woche bleibt
  });
  if (!drop.length) return 0;
  const del = db.prepare('DELETE FROM history WHERE day = ? AND id NOT IN (SELECT id FROM watchlist)');
  let n = 0;
  tx(db, () => { for (const d of drop) n += Number(del.run(d).changes); });
  return n;
}

function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cardmarket-API v2.0 (OAuth 1.0, HMAC-SHA1) für Einzelangebote
// ---------------------------------------------------------------------------

export function hasApiCredentials(env = process.env) {
  return Boolean(env.CARDMARKET_APP_TOKEN && env.CARDMARKET_APP_SECRET
    && env.CARDMARKET_ACCESS_TOKEN && env.CARDMARKET_ACCESS_SECRET);
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Baut den OAuth-Header so, wie Cardmarket ihn erwartet. */
export function oauthHeader(method, url, creds, { nonce, timestamp } = {}) {
  const u = new URL(url);
  const baseUrl = `${u.origin}${u.pathname}`;
  const oauth = {
    oauth_consumer_key: creds.appToken,
    oauth_token: creds.accessToken,
    oauth_nonce: nonce ?? crypto.randomBytes(12).toString('hex'),
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0',
  };
  const params = { ...oauth };
  for (const [k, v] of u.searchParams) params[k] = v;
  const paramStr = Object.keys(params).sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const base = `${method.toUpperCase()}&${enc(baseUrl)}&${enc(paramStr)}`;
  const key = `${enc(creds.appSecret)}&${enc(creds.accessSecret)}`;
  const signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  const parts = { realm: baseUrl, ...oauth, oauth_signature: signature };
  return 'OAuth ' + Object.entries(parts).map(([k, v]) => `${k}="${enc(v)}"`).join(', ');
}

const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

/** Bringt einen Cardmarket-Artikel in ein schlankes Format. */
export function mapArticle(a) {
  const country = countryInfo(a?.seller?.address?.country);
  return {
    price: num(a.price),
    condition: a.condition ?? null,
    language: a.language?.languageName ?? null,
    foil: Boolean(a.isFoil),
    count: a.count ?? 1,
    seller: a.seller?.username ?? null,
    country,
    comments: a.comments || '',
  };
}

/** Wählt die N günstigsten Angebote aus einer Artikelliste. */
export function cheapest(articles, n = 5) {
  return articles.map(mapArticle)
    .filter((a) => a.price != null)
    .sort((a, b) => a.price - b.price)
    .slice(0, n);
}

/**
 * Holt die aktuellen Angebote einer Karte über die Cardmarket-API und gibt die 5 günstigsten zurück.
 * filters: { foil: boolean, minCondition: 'NM' | ..., language: idLanguage (1 = Englisch, 3 = Deutsch) }
 */
export async function fetchCheapestOffers(idProduct, filters = {}, env = process.env, n = 5) {
  const creds = {
    appToken: env.CARDMARKET_APP_TOKEN,
    appSecret: env.CARDMARKET_APP_SECRET,
    accessToken: env.CARDMARKET_ACCESS_TOKEN,
    accessSecret: env.CARDMARKET_ACCESS_SECRET,
  };
  const url = new URL(`${API_BASE}/articles/${Number(idProduct)}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('maxResults', '100');
  if (filters.foil !== undefined) url.searchParams.set('isFoil', filters.foil ? 'true' : 'false');
  if (CONDITIONS.includes(filters.minCondition)) url.searchParams.set('minCondition', filters.minCondition);
  if (filters.language) url.searchParams.set('idLanguage', String(Number(filters.language)));

  const res = await fetch(url, { headers: { Authorization: oauthHeader('GET', url.toString(), creds) } });
  if (res.status === 204) return [];
  if (!res.ok && res.status !== 206) {
    throw new Error(`Cardmarket-API antwortet mit ${res.status}. Zugangsdaten prüfen.`);
  }
  const body = await res.json();
  return cheapest(body.article ?? [], n);
}
