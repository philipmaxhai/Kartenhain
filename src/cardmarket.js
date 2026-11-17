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
export const API_BASE = 'https://api.cardmarket.com/ws/v2.0/output.json';

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

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
  const [catalog, priceGuide] = await Promise.all([fetchJson(CATALOG_URL), fetchJson(PRICE_GUIDE_URL)]);
  return importPriceData(db, { catalog, priceGuide, ...opts });
}

/**
 * Schreibt geparste Cardmarket-Dateien in die Datenbank.
 * - products: alle Magic-Einzelkarten
 * - prices:   aktueller Preisguide
 * - history:  Momentaufnahme für heute (nur Karten ab `historyMinTrend` € oder auf der Merkliste,
 *             damit die Datenbank nicht explodiert)
 */
export function importPriceData(db, { catalog, priceGuide, day = today(), historyMinTrend = 0.5 }) {
  const products = catalog?.products ?? [];
  const guides = priceGuide?.priceGuides ?? [];
  if (!guides.length) throw new Error('Preisguide ist leer oder hat ein unbekanntes Format.');
  const updated = priceGuide.createdAt ?? new Date().toISOString();

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
    INSERT OR REPLACE INTO history (id, day, trend, low, avg1, trend_foil) VALUES (?, ?, ?, ?, ?, ?)`);

  let histCount = 0;
  tx(db, () => {
    for (const p of products) {
      if (p.idProduct == null || !p.name) continue;
      insProduct.run(p.idProduct, p.name, p.idExpansion ?? null, p.idMetacard ?? null,
        p.categoryName ?? null, p.dateAdded ?? null);
    }
    for (const g of guides) {
      if (g.idProduct == null) continue;
      const trend = num(g.trend);
      const trendFoil = num(g['trend-foil']);
      insPrice.run(g.idProduct, num(g.avg), num(g.low), trend, num(g.avg1), num(g.avg7), num(g.avg30),
        num(g['avg-foil']), num(g['low-foil']), trendFoil, num(g['avg1-foil']), num(g['avg7-foil']),
        num(g['avg30-foil']), updated);
      if (watch.has(g.idProduct) || (trend ?? 0) >= historyMinTrend || (trendFoil ?? 0) >= historyMinTrend) {
        insHist.run(g.idProduct, day, trend, num(g.low), num(g.avg1), trendFoil);
        histCount++;
      }
    }
  });
  setMeta(db, 'lastUpdate', new Date().toISOString());
  setMeta(db, 'priceGuideCreatedAt', updated);
  return { products: products.length, prices: guides.length, history: histCount, day };
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
