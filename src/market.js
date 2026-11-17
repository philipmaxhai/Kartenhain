// Marktüberblick, Schnäppchen und Bestand ("Meine Karten").
import { topMovers, getWatchlist, sparkFor } from './trends.js';

const PRICE_COLS = `p.trend, p.low, p.avg, p.avg1, p.avg7, p.avg30,
  p.trend_foil, p.low_foil, p.avg_foil, p.avg1_foil, p.avg7_foil, p.avg30_foil, p.updated`;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Verteilung der Preisänderungen in 5-%-Schritten von −50 % bis +50 % (Ränder sammeln alles darüber). */
export function histogram(changes, step = 0.05, limit = 0.5) {
  const n = Math.round((2 * limit) / step);
  const buckets = Array.from({ length: n }, (_, i) => ({
    from: -limit + i * step, to: -limit + (i + 1) * step, count: 0,
  }));
  for (const c of changes) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((c + limit) / step)));
    buckets[i].count++;
  }
  return buckets;
}

export function dashboard(db, { minPrice = 2 } = {}) {
  const minP = Number(minPrice) || 0;
  const rows = db.prepare(`
    SELECT p.avg7, p.avg30, p.trend FROM prices p
    WHERE p.trend >= ? AND p.avg30 > 0 AND p.avg7 > 0`).all(minP);
  // Gleiche Regel wie bei den Trends: Ø 7 Tage gegen Ø 30 Tage, Trendpreis muss mitziehen
  const changes = rows.map((r) => (r.avg7 - r.avg30) / r.avg30);
  let up = 0, down = 0;
  rows.forEach((r, i) => {
    if (changes[i] > 0.02 && r.trend > r.avg30) up++;
    else if (changes[i] < -0.02 && r.trend < r.avg30) down++;
  });

  const top = (direction) => topMovers(db, { direction, minPrice: minP, limit: 6 });
  const mostValuable = db.prepare(`
    SELECT pr.id, pr.name, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS}
    FROM prices p JOIN products pr ON pr.id = p.id LEFT JOIN expansions e ON e.id = pr.expansion_id
    WHERE p.trend IS NOT NULL ORDER BY p.trend DESC LIMIT 6`).all();
  for (const r of mostValuable) r.spark = sparkFor(db, r);

  return {
    minPrice: minP,
    cards: rows.length,
    up,
    down,
    flat: rows.length - up - down,
    medianChange: median(changes),
    histogram: histogram(changes),
    gainers: top('up'),
    losers: top('down'),
    mostValuable,
    portfolio: portfolio(db),
  };
}

/**
 * Schnäppchen: Karten, deren günstigstes Angebot deutlich unter dem Preis-Trend liegt.
 * Achtung: Das günstigste Angebot kann schlechter Zustand oder eine andere Sprache sein.
 */
export function deals(db, { minPrice = 5, maxRatio = 0.7, setId = null, q = '', limit = 100, sort = 'abs' } = {}) {
  const args = [Number(minPrice) || 0, Number(maxRatio) || 0.7];
  let extra = '';
  if (Number(setId) > 0) { extra += ' AND pr.expansion_id = ?'; args.push(Number(setId)); }
  const term = String(q ?? '').trim();
  if (term) { extra += " AND pr.name LIKE ? ESCAPE '\\'"; args.push(`%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
  args.push(Math.min(Math.max(Number(limit) || 100, 1), 200));
  const order = sort === 'pct' ? '(p.low / p.trend) ASC' : '(p.trend - p.low) DESC';
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
      (p.trend - p.low) AS spread, 1 - p.low / p.trend AS discount,
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM prices p JOIN products pr ON pr.id = p.id LEFT JOIN expansions e ON e.id = pr.expansion_id
    WHERE p.trend >= ? AND p.low > 0 AND p.low / p.trend <= ?
      -- nur Karten mit echtem Umsatz (alle Durchschnitte vorhanden)
      AND p.avg1 > 0 AND p.avg7 > 0 AND p.avg30 > 0 ${extra}
    ORDER BY ${order} LIMIT ?`).all(...args);
  return rows.map((r) => ({ ...r, watched: Boolean(r.watched), spark: sparkFor(db, r) }));
}

/** Gesamtwert, Einkaufswert und Gewinn der Karten mit Menge > 0, dazu Wertverlauf und Alarme. */
export function portfolio(db) {
  const cards = getWatchlist(db);
  const owned = cards.filter((c) => c.qty > 0);
  const sum = (k) => owned.reduce((a, c) => a + (c[k] ?? 0), 0);
  const value = sum('value');
  const costKnown = owned.filter((c) => c.cost != null);
  const cost = costKnown.reduce((a, c) => a + c.cost, 0);
  const valueWithCost = costKnown.reduce((a, c) => a + (c.value ?? 0), 0);

  const history = db.prepare(`
    SELECT h.day, SUM(w.qty * (CASE WHEN w.foil = 1 THEN h.trend_foil ELSE h.trend END)) AS value
    FROM watchlist w JOIN history h ON h.id = w.id
    WHERE w.qty > 0
    GROUP BY h.day ORDER BY h.day`).all();

  return {
    watched: cards.length,
    owned: owned.length,
    copies: owned.reduce((a, c) => a + c.qty, 0),
    value,
    cost: costKnown.length ? cost : null,
    profit: costKnown.length ? valueWithCost - cost : null,
    alerts: cards.filter((c) => c.alert).map((c) => ({
      id: c.id, name: c.name, set_name: c.set_name, alert: c.alert, price: c.value_each,
      alert_below: c.alert_below, alert_above: c.alert_above,
    })),
    history,
  };
}

export function listSets(db) {
  return db.prepare(`
    SELECT e.id, e.name, e.code, e.release_date, COUNT(*) AS cards
    FROM expansions e JOIN products pr ON pr.expansion_id = e.id
    GROUP BY e.id ORDER BY e.release_date DESC, e.name`).all();
}
