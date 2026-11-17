// Kartenhain Preistracker: kleiner Webserver ohne Zusatzpakete.
// Start: npm start  →  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getMeta } from './db.js';
import { downloadAndImport, fetchCheapestOffers, hasApiCredentials, cheapest } from './cardmarket.js';
import { searchCards, getCard, topMovers, getWatchlist, setWatched } from './trends.js';
import { seedDemo, demoArticles } from './demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ db, env = process.env, fetchOffers = fetchCheapestOffers, download = downloadAndImport } = {}) {
  const demo = () => env.DEMO === '1' || getMeta(db, 'demo') === '1';
  const offerCache = new Map(); // idProduct+Filter → { at, data }
  let updating = null;

  async function runUpdate() {
    if (demo()) return { skipped: 'Demo-Modus: keine echten Daten geladen.' };
    if (!updating) {
      updating = download(db, { historyMinTrend: Number(env.HISTORY_MIN_TREND ?? 0.5) })
        .finally(() => { updating = null; });
    }
    return updating;
  }

  const routes = [
    ['GET', /^\/api\/status$/, () => ({
      demo: demo(),
      lastUpdate: getMeta(db, 'lastUpdate'),
      priceGuideCreatedAt: getMeta(db, 'priceGuideCreatedAt'),
      offersAvailable: demo() || hasApiCredentials(env),
      products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
      historyDays: db.prepare('SELECT COUNT(DISTINCT day) AS n FROM history').get().n,
      updating: Boolean(updating),
    })],
    ['GET', /^\/api\/search$/, (m, q) => searchCards(db, q.get('q'))],
    ['GET', /^\/api\/card\/(\d+)$/, (m) => getCard(db, m[1]) ?? httpError(404, 'Karte nicht gefunden')],
    ['GET', /^\/api\/card\/(\d+)\/offers$/, async (m, q) => {
      const id = Number(m[1]);
      const filters = {
        foil: q.get('foil') === '1',
        minCondition: q.get('minCondition') || undefined,
        language: q.get('language') || undefined,
      };
      if (demo()) {
        const low = db.prepare('SELECT low FROM prices WHERE id = ?').get(id)?.low;
        return { source: 'demo', offers: cheapest(demoArticles(id, low, filters), 5) };
      }
      if (!hasApiCredentials(env)) {
        return { source: 'none', offers: [], message: 'Für die 5 günstigsten Angebote mit Verkäuferland werden Cardmarket-API-Zugangsdaten benötigt (siehe README).' };
      }
      const key = JSON.stringify([id, filters]);
      const hit = offerCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
      const data = { source: 'cardmarket', offers: await fetchOffers(id, filters, env, 5), fetchedAt: new Date().toISOString() };
      offerCache.set(key, { at: Date.now(), data });
      return data;
    }],
    ['GET', /^\/api\/movers$/, (m, q) => topMovers(db, {
      direction: q.get('direction') === 'down' ? 'down' : 'up',
      minPrice: Number(q.get('minPrice') ?? 2),
      days: Number(q.get('days') ?? 7),
      foil: q.get('foil') === '1',
      limit: Number(q.get('limit') ?? 25),
    })],
    ['GET', /^\/api\/watchlist$/, () => getWatchlist(db)],
    ['POST', /^\/api\/watchlist\/(\d+)$/, (m) => { setWatched(db, m[1], true); return { ok: true }; }],
    ['DELETE', /^\/api\/watchlist\/(\d+)$/, (m) => { setWatched(db, m[1], false); return { ok: true }; }],
    ['POST', /^\/api\/update$/, async () => runUpdate()],
  ];

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, re, fn] of routes) {
          const m = url.pathname.match(re);
          if (m && req.method === method) return sendJson(res, 200, await fn(m, url.searchParams));
        }
        return sendJson(res, 404, { error: 'Unbekannte Adresse' });
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      sendJson(res, e.status ?? 500, { error: e.message });
    }
  }

  return { handler, runUpdate };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Nicht gefunden');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Direktstart
// ---------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  if (process.argv.includes('--demo')) env.DEMO = '1';
  const dbFile = env.DB_FILE ?? path.join(ROOT, 'data', env.DEMO === '1' ? 'demo.sqlite' : 'kartenhain.sqlite');
  const db = openDb(dbFile);
  if (env.DEMO === '1' && db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
    console.log(`Demo-Daten erzeugt (${seedDemo(db)} Karten).`);
  }
  const app = createApp({ db, env });
  const port = Number(env.PORT ?? 3000);
  http.createServer(app.handler).listen(port, () => {
    console.log(`Kartenhain Preistracker läuft auf http://localhost:${port}${env.DEMO === '1' ? '  (DEMO-Daten)' : ''}`);
  });

  // Täglich neue Cardmarket-Preise holen (der Preisguide wird einmal am Tag erneuert).
  const maybeUpdate = async () => {
    const last = getMeta(db, 'lastUpdate');
    if (last && Date.now() - new Date(last).getTime() < 20 * 3600 * 1000) return;
    try {
      console.log('Lade aktuelle Cardmarket-Preise …');
      const r = await app.runUpdate();
      if (r?.prices) console.log(`Fertig: ${r.prices} Preise, ${r.history} Verlaufspunkte für ${r.day}.`);
    } catch (e) {
      console.error('Update fehlgeschlagen:', e.message);
    }
  };
  if (env.DEMO !== '1') {
    maybeUpdate();
    setInterval(maybeUpdate, 60 * 60 * 1000);
  }
}
