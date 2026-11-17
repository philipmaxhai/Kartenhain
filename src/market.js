// Marktüberblick, Schnäppchen und Bestand ("Meine Karten").
import { topMovers, getWatchlist, sparkFor, saleSql, saleValue } from './trends.js';

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

/** Preisbereich aus Anfrage-Werten: min immer ≥ 0, max leer = unbegrenzt. */
export function priceBand(minPrice, maxPrice) {
  const min = Math.max(0, Number(minPrice) || 0);
  const max = Number(maxPrice) > 0 ? Number(maxPrice) : null;
  return { min, max, maxSql: max ?? 1e12 };
}

export function dashboard(db, { minPrice = 0.1, maxPrice = null } = {}) {
  const band = priceBand(minPrice, maxPrice);
  // Preisbereich gilt für den Verkaufswert (hier immer Ø 7 Tage, weil er für den Vergleich nötig ist)
  const rows = db.prepare(`
    SELECT p.avg7, p.avg30, p.trend FROM prices p
    WHERE p.avg7 BETWEEN ? AND ? AND p.avg30 > 0 AND p.trend > 0`).all(band.min, band.maxSql);
  // Gleiche Regel wie bei den Trends: Ø 7 Tage gegen Ø 30 Tage, Trendpreis muss mitziehen
  const changes = rows.map((r) => (r.avg7 - r.avg30) / r.avg30);
  let up = 0, down = 0;
  rows.forEach((r, i) => {
    if (changes[i] > 0.02 && r.trend > r.avg30) up++;
    else if (changes[i] < -0.02 && r.trend < r.avg30) down++;
  });

  const top = (direction) => topMovers(db, { direction, minPrice: band.min, maxPrice: band.max, limit: 6 });
  // Wertvollste Karten nach Verkaufswert. Einzelne Ausreißer-Verkäufe (Verkaufswert weit weg
  // vom Preis-Trend) bleiben draußen, damit keine 5-€-Karte wegen eines Fehlkaufs oben steht.
  const sale = saleSql();
  const mostValuable = db.prepare(`
    SELECT pr.id, pr.name, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM prices p JOIN products pr ON pr.id = p.id LEFT JOIN expansions e ON e.id = pr.expansion_id
    WHERE ${sale} BETWEEN ? AND ? AND p.trend > 0 AND ${sale} BETWEEN p.trend / 3 AND p.trend * 3
    ORDER BY ${sale} DESC LIMIT 6`).all(band.min, band.maxSql);
  for (const r of mostValuable) {
    r.watched = Boolean(r.watched);
    r.sale_value = saleValue(r);
    r.spark = sparkFor(db, r);
  }

  return {
    minPrice: band.min,
    maxPrice: band.max,
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
 * Schnäppchen: Karten, deren günstigstes Angebot deutlich unter dem Verkaufswert liegt.
 * Verkaufswert = Ø Verkaufspreis der letzten 7 Tage (echte Verkäufe), notfalls Preis-Trend.
 * Achtung: Das günstigste Angebot kann schlechter Zustand oder eine andere Sprache sein.
 */
export function deals(db, {
  minPrice = 0.5, maxPrice = null, maxRatio = 0.7, setId = null, q = '', limit = 100, sort = 'abs',
} = {}) {
  const band = priceBand(minPrice, maxPrice);
  const value = saleSql();
  const args = [band.min, band.maxSql, Number(maxRatio) || 0.7];
  let extra = '';
  if (Number(setId) > 0) { extra += ' AND pr.expansion_id = ?'; args.push(Number(setId)); }
  const term = String(q ?? '').trim();
  if (term) { extra += " AND pr.name LIKE ? ESCAPE '\\'"; args.push(`%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
  args.push(Math.min(Math.max(Number(limit) || 100, 1), 200));
  const order = sort === 'pct' ? `(p.low / ${value}) ASC` : `(${value} - p.low) DESC`;
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
      ${value} AS sale_value, (${value} - p.low) AS spread, 1 - p.low / ${value} AS discount,
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM prices p JOIN products pr ON pr.id = p.id LEFT JOIN expansions e ON e.id = pr.expansion_id
    WHERE ${value} >= ? AND ${value} <= ? AND p.low > 0 AND p.low / ${value} <= ?
      -- nur Karten mit echtem Umsatz (alle Durchschnitte vorhanden) und Trend, der nicht widerspricht
      AND p.avg1 > 0 AND p.avg7 > 0 AND p.avg30 > 0 AND p.trend > p.low ${extra}
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
    SELECT h.day, SUM(w.qty * (CASE WHEN w.foil = 1 THEN COALESCE(h.avg7_foil, h.trend_foil)
      ELSE COALESCE(h.avg7, h.trend) END)) AS value
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
