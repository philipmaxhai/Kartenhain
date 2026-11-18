// Trendberechnung, Suche und Abfragen für die Oberfläche.

const pct = (now, before) => (now != null && before ? (now - before) / before : null);
// Tage ohne Eintrag in history_days stammen von älteren Versionen, die ab 0,50 € gespeichert haben
const LEGACY_FLOOR = 0.5;

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

/**
 * Echter Verkaufswert = Ø Preis der tatsächlichen Verkäufe der letzten 7 Tage
 * (auf Cardmarket: "7-Tages-Durchschnitt"). Gab es in 7 Tagen keinen Verkauf,
 * gilt der Preis-Trend, notfalls der 30-Tages-Durchschnitt.
 * saleSql und saleValue müssen dieselbe Reihenfolge haben.
 */
export function saleSql(foil = false, t = 'p') {
  const f = foil ? '_foil' : '';
  return `COALESCE(NULLIF(${t}.avg7${f}, 0), NULLIF(${t}.trend${f}, 0), NULLIF(${t}.avg30${f}, 0))`;
}

export function saleValue(p, foil = false) {
  const f = foil ? '_foil' : '';
  for (const k of ['avg7', 'trend', 'avg30']) {
    const v = p?.[k + f];
    if (v > 0) return v;
  }
  return null;
}

/**
 * Suche nach Kartennamen. Ergebnis ist nach Karte gruppiert, weil es viele Karten in
 * dutzenden Versionen (Editionen, Promos, Sonderversionen) mit sehr unterschiedlichen Preisen gibt.
 * Versionen sind nach Preis-Trend aufsteigend sortiert, die normale günstige Version steht also oben.
 */
export function searchCards(db, q, maxNames = 30) {
  const term = String(q ?? '').trim();
  if (term.length < 2) return [];
  const like = `%${escapeLike(term)}%`;
  const names = db.prepare(`
    SELECT name FROM products WHERE name LIKE ? ESCAPE '\\'
    GROUP BY name
    ORDER BY (name = ? COLLATE NOCASE) DESC, (name LIKE ? ESCAPE '\\') DESC, length(name), name
    LIMIT ?`).all(like, term, `${escapeLike(term)}%`, maxNames).map((r) => r.name);
  if (!names.length) return [];
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM products pr LEFT JOIN prices p ON p.id = pr.id LEFT JOIN expansions e ON e.id = pr.expansion_id
    WHERE pr.name IN (SELECT value FROM json_each(?))`).all(JSON.stringify(names));
  const groups = new Map(names.map((n) => [n, { name: n, versions: [] }]));
  for (const r of rows) groups.get(r.name)?.versions.push(decorate(r));
  return [...groups.values()].map((g) => {
    // günstigste Version zuerst, Versionen ohne Preis ans Ende
    g.versions.sort((a, b) => (a.price_value ?? Infinity) - (b.price_value ?? Infinity)
      || String(b.release_date ?? '').localeCompare(String(a.release_date ?? '')));
    const prices = g.versions.map((v) => v.price_value).filter((v) => v != null);
    return {
      ...g,
      count: g.versions.length,
      minSale: prices.length ? Math.min(...prices) : null,
      maxSale: prices.length ? Math.max(...prices) : null,
    };
  });
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function decorate(r) {
  const sale = saleValue(r);
  const saleFoil = saleValue(r, true);
  // Reine Foil-Produkte (z. B. viele Promos) haben nur Foil-Preise
  const foilOnly = sale == null && !(r.low > 0) && saleFoil != null;
  return {
    ...r,
    watched: Boolean(r.watched),
    guideTrend: guideTrend(r),
    guideTrendFoil: guideTrend(r, true),
    sale_value: sale,
    sale_value_foil: saleFoil,
    foil_only: foilOnly,
    price_value: foilOnly ? saleFoil : sale,
  };
}

export function getCard(db, id) {
  const r = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, pr.date_added, ${PRICE_COLS},
      (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
    FROM products pr LEFT JOIN prices p ON p.id = pr.id LEFT JOIN expansions e ON e.id = pr.expansion_id WHERE pr.id = ?`).get(Number(id));
  if (!r) return null;
  const card = decorate(r);
  card.own = db.prepare('SELECT qty, buy_price, alert_below, alert_above, foil FROM watchlist WHERE id = ?').get(Number(id)) ?? null;
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
    SELECT day, trend, low, avg1, trend_foil, avg7, avg7_foil FROM history
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
 * Wenn die eigene Historie lang genug ist und den Preisbereich vollständig abdeckt, wird sie für den
 * Zeitraum verwendet, sonst der Cardmarket-Vergleich "7-Tage-Schnitt gegen 30-Tage-Schnitt"
 * (reason sagt dann warum: 'days' = noch zu wenig Tage, 'floor' = günstige Karten noch nicht lange genug gespeichert).
 * Filter: minPrice/maxPrice (€), setId (Cardmarket-Editions-ID), q (Name enthält), sort ('pct' | 'abs').
 */
export function topMovers(db, {
  direction = 'up', minPrice = 0.1, maxPrice = null, limit = 100, days = 7, foil = false,
  setId = null, q = '', sort = 'pct',
} = {}) {
  const down = direction === 'down';
  const order = down ? 'ASC' : 'DESC';
  const span = db.prepare('SELECT MIN(day) AS first, MAX(day) AS last FROM history').get();
  const field = foil ? 'trend_foil' : 'trend';
  const limitN = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const minP = Number(minPrice) || 0;
  const maxP = Number(maxPrice) > 0 ? Number(maxPrice) : 1e12;
  const sortExpr = sort === 'abs' ? '(now_price - then_price)' : 'change';

  const extra = [];
  const extraArgs = [];
  if (Number(setId) > 0) { extra.push('pr.expansion_id = ?'); extraArgs.push(Number(setId)); }
  const term = String(q ?? '').trim();
  if (term) { extra.push("pr.name LIKE ? ESCAPE '\\'"); extraArgs.push(`%${escapeLike(term)}%`); }
  const extraSql = extra.length ? ' AND ' + extra.join(' AND ') : '';

  let result = null;
  let reason = 'days';
  const from = span?.first && daysBetween(span.first, span.last) >= days
    ? db.prepare('SELECT MAX(day) AS d FROM history WHERE day <= ?').get(shiftDay(span.last, -days)).d
    : null;
  // An beiden Tagen müssen alle Karten des Preisbereichs gespeichert sein, sonst fehlen welche
  const floorOf = (d) => db.prepare('SELECT floor FROM history_days WHERE day = ?').get(d)?.floor ?? LEGACY_FLOOR;
  if (from && Math.max(floorOf(from), floorOf(span.last)) > minP + 1e-9) reason = 'floor';
  else if (from) {
    const rows = db.prepare(`
      SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
        h1.${field} AS now_price, h0.${field} AS then_price,
        (h1.${field} - h0.${field}) / h0.${field} AS change,
        (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
      FROM history h1
      JOIN history h0 ON h0.id = h1.id AND h0.day = ?
      JOIN products pr ON pr.id = h1.id
      LEFT JOIN prices p ON p.id = h1.id
      LEFT JOIN expansions e ON e.id = pr.expansion_id
      WHERE h1.day = ? AND h0.${field} > 0 AND h1.${field} > 0
        -- Preisbereich gilt für den Verkaufswert (wie überall in der Oberfläche)
        AND COALESCE(${saleSql(foil)}, h1.${field}) BETWEEN ? AND ?
        AND h1.${field} ${down ? '<' : '>'} h0.${field} ${extraSql}
      ORDER BY ${sortExpr} ${order} LIMIT ?`).all(from, span.last, minP, maxP, ...extraArgs, limitN);
    result = { source: 'history', days, from, to: span.last, rows: rows.map(decorate) };
  }
  if (!result) {
    const f = foil ? '_foil' : '';
    const rows = db.prepare(`
      SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
        p.avg7${f} AS now_price, p.avg30${f} AS then_price,
        (p.avg7${f} - p.avg30${f}) / p.avg30${f} AS change,
        (SELECT 1 FROM watchlist w WHERE w.id = pr.id) AS watched
      FROM prices p JOIN products pr ON pr.id = p.id LEFT JOIN expansions e ON e.id = pr.expansion_id
      WHERE p.avg30${f} > 0 AND p.avg7${f} BETWEEN ? AND ? AND p.trend${f} > 0
        -- Trendpreis muss in dieselbe Richtung zeigen, sonst ist es meist nur ein einzelner Ausreißer-Verkauf
        AND p.avg7${f} ${down ? '<' : '>'} p.avg30${f} AND p.trend${f} ${down ? '<' : '>'} p.avg30${f}
        ${extraSql}
      ORDER BY ${sortExpr} ${order} LIMIT ?`).all(minP, maxP, ...extraArgs, limitN);
    result = { source: 'guide', days: null, reason, rows: rows.map(decorate) };
  }
  for (const r of result.rows) r.spark = sparkFor(db, r, foil);
  return result;
}

/**
 * Mini-Verlauf für Listen: aus der eigenen Historie (letzte 30 Tage), sonst die
 * Cardmarket-Durchschnitte in zeitlicher Reihenfolge (Ø 30 Tage → Ø 7 Tage → Ø 1 Tag → Trend).
 */
export function sparkFor(db, r, foil = false) {
  const field = foil ? 'trend_foil' : 'trend';
  const hist = db.prepare(`SELECT ${field} AS v FROM history WHERE id = ? AND ${field} IS NOT NULL
    ORDER BY day DESC LIMIT 30`).all(r.id).map((h) => h.v).reverse();
  if (hist.length >= 5) return { kind: 'history', values: hist };
  const f = foil ? '_foil' : '';
  const vals = [r['avg30' + f], r['avg7' + f], r['avg1' + f], r['trend' + f]];
  return vals.every((v) => v != null) ? { kind: 'guide', values: vals } : null;
}

export function getWatchlist(db) {
  const rows = db.prepare(`
    SELECT pr.id, pr.name, pr.expansion_id, e.name AS set_name, e.code AS set_code, e.release_date, ${PRICE_COLS},
      1 AS watched, w.added, w.qty, w.buy_price, w.alert_below, w.alert_above, w.foil AS own_foil
    FROM watchlist w JOIN products pr ON pr.id = w.id LEFT JOIN prices p ON p.id = w.id LEFT JOIN expansions e ON e.id = pr.expansion_id
    ORDER BY pr.name`).all();
  return rows.map((r) => {
    const card = decorate(r);
    const foil = Boolean(r.own_foil);
    const hist = getHistory(db, r.id, 120);
    card.foil = foil;
    card.historyChange = { d7: historyChange(hist, 7, foil ? 'trend_foil' : 'trend'), d30: historyChange(hist, 30, foil ? 'trend_foil' : 'trend') };
    card.spark = sparkFor(db, r, foil);
    // Wert pro Stück = echter Verkaufswert (Ø 7 Tage), Preis-Trend nur als Ersatz
    card.value_each = saleValue(r, foil);
    card.trend_each = foil ? r.trend_foil : r.trend;
    const qty = r.qty || 0;
    card.value = card.value_each != null ? card.value_each * qty : null;
    card.cost = r.buy_price != null ? r.buy_price * qty : null;
    card.profit = card.value != null && card.cost != null ? card.value - card.cost : null;
    card.alert = card.value_each == null ? null
      : r.alert_below != null && card.value_each <= r.alert_below ? 'below'
        : r.alert_above != null && card.value_each >= r.alert_above ? 'above' : null;
    return card;
  });
}

/** Bestand/Alarm einer gemerkten Karte setzen. Leere Werte löschen das Feld. */
export function updateWatch(db, id, data = {}) {
  setWatched(db, id, true);
  const numOrNull = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.max(0, Number(v)));
  const cur = db.prepare('SELECT * FROM watchlist WHERE id = ?').get(Number(id));
  const next = {
    qty: 'qty' in data ? Math.round(numOrNull(data.qty) ?? 0) : cur.qty,
    buy_price: 'buy_price' in data ? numOrNull(data.buy_price) : cur.buy_price,
    alert_below: 'alert_below' in data ? numOrNull(data.alert_below) : cur.alert_below,
    alert_above: 'alert_above' in data ? numOrNull(data.alert_above) : cur.alert_above,
    foil: 'foil' in data ? (data.foil ? 1 : 0) : cur.foil,
  };
  db.prepare('UPDATE watchlist SET qty = ?, buy_price = ?, alert_below = ?, alert_above = ?, foil = ? WHERE id = ?')
    .run(next.qty, next.buy_price, next.alert_below, next.alert_above, next.foil, Number(id));
  return next;
}

export function setWatched(db, id, on) {
  if (on) {
    db.prepare('INSERT OR IGNORE INTO watchlist (id, added) VALUES (?, ?)').run(Number(id), new Date().toISOString());
  } else {
    db.prepare('DELETE FROM watchlist WHERE id = ?').run(Number(id));
  }
}
