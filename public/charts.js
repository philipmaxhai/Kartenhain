// Kleine SVG-Diagramme ohne Bibliotheken: Mini-Verlauf, Verteilung, Wertverlauf.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = (v) => (v == null ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));

/**
 * Mini-Verlauf (Sparkline). Farbe folgt der Richtung: steigend grün, fallend rot.
 * spark = { kind: 'history' | 'guide', values: [...] }
 */
export function sparkline(spark, { w = 96, h = 30 } = {}) {
  const vals = spark?.values?.filter((v) => v != null) ?? [];
  if (vals.length < 2) return '<span class="spark-empty"></span>';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = 3;
  const x = (i) => pad + (i / (vals.length - 1)) * (w - 2 * pad);
  const y = (v) => (hi === lo ? h / 2 : pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad));
  const first = vals[0], last = vals[vals.length - 1];
  const cls = Math.abs(last - first) / (first || 1) < 0.005 ? 'flat' : last > first ? 'up' : 'down';
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${d}L${x(vals.length - 1).toFixed(1)},${h}L${x(0).toFixed(1)},${h}Z`;
  const title = spark.kind === 'guide'
    ? `Ø 30 Tage ${eur(vals[0])} → Ø 7 Tage ${eur(vals[1])} → Ø 1 Tag ${eur(vals[2])} → Preis-Trend ${eur(vals[3])}`
    : `Letzte ${vals.length} Tage: ${eur(first)} → ${eur(last)}`;
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">
    <title>${esc(title)}</title>
    <path class="spark-area" d="${area}"/>
    <path class="spark-line" d="${d}"/>
    <circle class="spark-dot" cx="${x(vals.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.5"/>
  </svg>`;
}

/**
 * Verteilung der Preisänderungen als Balken: links gefallen (rot), rechts gestiegen (grün),
 * um 0 % grau. buckets = [{ from, to, count }]
 */
export function histogramSvg(buckets, { w = 600, h = 220 } = {}) {
  // Breite = echte Breite des Platzes, damit die Schrift auf dem Handy nicht winzig wird
  const W = Math.max(260, Math.round(w)), H = h, m = { l: 8, r: 8, t: 10, b: 30 };
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bw = (W - m.l - m.r) / buckets.length;
  const y = (c) => m.t + (1 - c / max) * (H - m.t - m.b);
  const bars = buckets.map((b, i) => {
    const mid = (b.from + b.to) / 2;
    const cls = Math.abs(mid) < 0.026 ? 'flat' : mid > 0 ? 'up' : 'down';
    const x = m.l + i * bw + 1;
    const top = y(b.count);
    const label = `${pctRange(b, i, buckets.length)}: ${b.count.toLocaleString('de-DE')} Karten`;
    return `<g class="hbar"><title>${esc(label)}</title>
      <rect class="hit" x="${x - 1}" y="${m.t}" width="${bw}" height="${H - m.t - m.b}" fill="transparent"/>
      <rect class="bar ${cls}" x="${x}" y="${top}" width="${Math.max(1, bw - 2)}" height="${Math.max(0, H - m.b - top)}" rx="3"/></g>`;
  }).join('');
  const ticks = (W < 420 ? [-0.5, 0, 0.5] : [-0.5, -0.25, 0, 0.25, 0.5]).map((t) => {
    const x = m.l + ((t + 0.5) / 1) * (W - m.l - m.r);
    const anchor = t === -0.5 ? 'start' : t === 0.5 ? 'end' : 'middle';
    return `<text x="${x}" y="${H - 8}" text-anchor="${anchor}">${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(Math.round(t * 100))} %</text>`;
  }).join('');
  return `<svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verteilung der Preisänderungen">
    <line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>
    ${bars}<g class="axis">${ticks}</g></svg>`;
}

/** Dieselben Zahlen wie im Balkendiagramm, als Tabelle (zum Nachlesen ohne Maus). */
export function histogramTable(buckets) {
  const rows = buckets.map((b, i) => `<tr><td>${pctRange(b, i, buckets.length)}</td><td class="num">${b.count.toLocaleString('de-DE')}</td></tr>`).join('');
  return `<table><thead><tr><th>Veränderung</th><th class="num">Karten</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pctRange(b, i, n) {
  const f = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))} %`;
  if (i === 0) return `${f(b.to)} und weniger`;
  if (i === n - 1) return `${f(b.from)} und mehr`;
  return `${f(b.from)} bis ${f(b.to)}`;
}

/** Einfacher Linienverlauf mit Hover (für den Wert von "Meine Karten"). points = [{ day, value }] */
export function areaChart(el, points, { label = 'Wert', tooltip } = {}) {
  if (points.length < 2) {
    el.innerHTML = '<div class="empty small">Der Wertverlauf erscheint, sobald ein paar Tage Preise gespeichert sind.</div>';
    return;
  }
  const W = Math.max(el.clientWidth || 600, 260), H = 180, m = { l: 56, r: 12, t: 10, b: 24 };
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
  lo = Math.max(0, lo - pad); hi += pad;
  const x = (i) => m.l + (i / (points.length - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const ticks = [lo, (lo + hi) / 2, hi];
  const fd = (s) => new Date(s + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const xt = [0, Math.floor((points.length - 1) / 2), points.length - 1];
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="area" role="img" aria-label="${esc(label)}">
    ${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${eur(t)}</text>`).join('')}
    ${xt.map((i) => `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${fd(points[i].day)}</text>`).join('')}
    <path class="area-fill" d="${d}L${x(points.length - 1)},${H - m.b}L${x(0)},${H - m.b}Z"/>
    <path class="area-line" d="${d}"/>
    <line class="hover-line" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="hover-dot" r="4.5" visibility="hidden"/>
    <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
  </svg>`;
  const svg = el.querySelector('svg');
  const line = svg.querySelector('.hover-line'), dot = svg.querySelector('.hover-dot');
  const hit = svg.querySelector('.hit');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - m.l) / (W - m.l - m.r)) * (points.length - 1));
    const p = points[Math.min(points.length - 1, Math.max(0, i))];
    const xi = x(points.indexOf(p));
    line.setAttribute('x1', xi); line.setAttribute('x2', xi); line.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', xi); dot.setAttribute('cy', y(p.value)); dot.setAttribute('visibility', 'visible');
    tooltip?.show(ev, `<div class="t-day">${fd(p.day)}</div><b>${eur(p.value)}</b>`);
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => {
    line.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip?.hide();
  });
}
