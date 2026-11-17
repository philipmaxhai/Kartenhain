// Trendberechnung, Suche und Abfragen für die Oberfläche.

const pct = (now, before) => (now != null && before ? (now - before) / before : null);

/** Trend aus dem Cardmarket-Preisguide: 7-Tage-Schnitt gegen 30-Tage-Schnitt. */
export function guideTrend(p, foil = false) {
  if (!p) return null;
  const f = foil ? '_foil' : '';
  return {
    change7v30: pct(p['avg7' + f], p['avg30' + f]),
    change1v7: pct(p['avg1' + f], p['avg7' + f]),
  };
}

const PRICE_COLS = `p.trend, p.low, p.avg, p.avg1, p.avg7, p.avg30,
  p.trend_foil, p.low_foil, p.avg_foil, p.avg1_foil, p.avg7_foil, p.avg30_foil, p.updated`;

export function searchCards(db, q, limit = 60) {
  const term = String(q ?? '').trim();
  if (term.length < 2) return [];
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, ${PRICE_COLS},
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM products pr LEFT JOIN prices p ON p.id = pr.id
    WHERE pr.name LIKE ? ESCAPE '\\'
    ORDER BY (pr.name = ? COLLATE NOCASE) DESC, (pr.name LIKE ? ESCAPE '\\') DESC, p.trend DESC NULLS LAST
    LIMIT ?`).all(`%${escapeLike(term)}%`, term, `${escapeLike(term)}%`, limit);
  return rows.map(decorate);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function decorate(r) {
  return { ...r, watched: Boolean(r.watched), guideTrend: guideTrend(r) };
}

export function getCard(db, id) {
  const r = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, pr.date_added, ${PRICE_COLS},
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM products pr LEFT JOIN prices p ON p.id = pr.id WHERE pr.id = ?`).get(Number(id));
  if (!r) return null;
  const card = decorate(r);
  card.guideTrendFoil = guideTrend(r, true);
  card.history = getHistory(db, id);
  card.historyChange = {
    d7: historyChange(card.history, 7),
    d30: historyChange(card.history, 30),
    d90: historyChange(card.history, 90),
  };
  return card;
}

export function getHistory(db, id, days = 3650) {
  return db.prepare(`
    SELECT day, trend, low, avg1, trend_foil FROM history
    WHERE id = ? AND day >= date((SELECT MAX(day) FROM history WHERE id = ?), ?)
    ORDER BY day`).all(Number(id), Number(id), `-${days} days`);
}

/** Veränderung des Trendpreises über die letzten `days` Tage aus der eigenen Historie. */
export function historyChange(history, days, field = 'trend') {
  const pts = history.filter((h) => h[field] != null);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const cutoff = shiftDay(last.day, -days);
  const first = pts.find((h) => h.day >= cutoff);
  if (!first || first === last) return null;
  // nur aussagekräftig, wenn die Historie den Zeitraum größtenteils abdeckt
  if (daysBetween(first.day, last.day) < days * 0.6) return null;
  return pct(last[field], first[field]);
}

export function shiftDay(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/**
 * Größte Gewinner/Verlierer.
 * Wenn die eigene Historie lang genug ist, wird sie für den Zeitraum verwendet,
 * sonst der Cardmarket-Vergleich "7-Tage-Schnitt gegen 30-Tage-Schnitt".
 */
export function topMovers(db, { direction = 'up', minPrice = 2, limit = 25, days = 7, foil = false } = {}) {
  const order = direction === 'down' ? 'ASC' : 'DESC';
  const span = db.prepare('SELECT MIN(day) AS first, MAX(day) AS last FROM history').get();
  const field = foil ? 'trend_foil' : 'trend';
  const limitN = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const minP = Number(minPrice) || 0;

  if (span?.first && daysBetween(span.first, span.last) >= days) {
    const from = db.prepare('SELECT MAX(day) AS d FROM history WHERE day <= ?').get(shiftDay(span.last, -days)).d;
    const rows = db.prepare(`
      SELECT pr.id, pr.name, pr.expansion_id, ${PRICE_COLS},
        h1.${field} AS now_price, h0.${field} AS then_price,
        (h1.${field} - h0.${field}) / h0.${field} AS change,
        (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
      FROM history h1
      JOIN history h0 ON h0.id = h1.id AND h0.day = ?
      JOIN products pr ON pr.id = h1.id
      LEFT JOIN prices p ON p.id = h1.id
      WHERE h1.day = ? AND h0.${field} > 0 AND h1.${field} >= ?
        AND ${direction === 'down' ? 'h1.' + field + ' < h0.' + field : 'h1.' + field + ' > h0.' + field}
      ORDER BY change ${order} LIMIT ?`).all(from, span.last, minP, limitN);
    return { source: 'history', days, from, to: span.last, rows: rows.map(decorate) };
  }

  const f = foil ? '_foil' : '';
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, ${PRICE_COLS},
      p.avg7${f} AS now_price, p.avg30${f} AS then_price,
      (p.avg7${f} - p.avg30${f}) / p.avg30${f} AS change,
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM prices p JOIN products pr ON pr.id = p.id
    WHERE p.avg30${f} > 0 AND p.avg7${f} >= ? AND p.trend${f} >= ?
      AND ${direction === 'down' ? `p.avg7${f} < p.avg30${f}` : `p.avg7${f} > p.avg30${f}`}
    ORDER BY change ${order} LIMIT ?`).all(minP, minP, limitN);
  return { source: 'guide', days: null, rows: rows.map(decorate) };
}

export function getWatchlist(db) {
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, ${PRICE_COLS}, 1 AS watched, w.added
    FROM watchlist w JOIN products pr ON pr.id = w.id LEFT JOIN prices p ON p.id = w.id
    ORDER BY pr.name`).all();
  return rows.map((r) => {
    const card = decorate(r);
    const hist = getHistory(db, r.id, 120);
    card.historyChange = { d7: historyChange(hist, 7), d30: historyChange(hist, 30) };
    card.spark = hist.slice(-60).map((h) => h.trend);
    return card;
  });
}

export function setWatched(db, id, on) {
  if (on) {
    db.prepare('INSERT OR IGNORE INTO watchlist (id, added) VALUES (?, ?)').run(Number(id), new Date().toISOString());
  } else {
    db.prepare('DELETE FROM watchlist WHERE id = ?').run(Number(id));
  }
}
