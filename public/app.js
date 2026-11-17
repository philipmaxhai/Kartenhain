// Kartenhain Preistracker – Oberfläche (ohne Frameworks)
const $ = (s, el = document) => el.querySelector(s);
const eur = (v) => (v == null ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const pct = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} %`);
const dir = (v) => (v == null || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down');
const arrow = (v) => ({ up: '▲', down: '▼', flat: '●' })[dir(v)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const state = { status: null, card: null, foil: false, range: 90, scry: new Map() };

// ---------------------------------------------------------------- Status
async function loadStatus() {
  const s = (state.status = await api('/api/status'));
  $('#demo-banner').hidden = !s.demo;
  const el = $('#status');
  if (!s.products) {
    el.innerHTML = s.updating ? 'Lade Cardmarket-Daten …' : 'Noch keine Daten. <button id="upd">Jetzt laden</button>';
  } else {
    const when = s.priceGuideCreatedAt || s.lastUpdate;
    el.innerHTML = `${s.products.toLocaleString('de-DE')} Karten · Preise vom ${when ? new Date(when).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '?'} · ${s.historyDays} Tage Verlauf`
      + (s.demo ? '' : ' <button id="upd">Aktualisieren</button>');
  }
  if (s.lastError && !s.updating) {
    el.innerHTML = `<span class="err">Laden der Cardmarket-Preise fehlgeschlagen: ${esc(s.lastError)}</span> <button id="upd">Nochmal versuchen</button>`;
  }
  $('#upd')?.addEventListener('click', runUpdate);
  if (s.updating) {
    state.wasUpdating = true;
    setTimeout(loadStatus, 4000);
  } else if (state.wasUpdating) {
    // Update gerade fertig: aktuelle Ansicht mit den neuen Preisen neu laden
    state.wasUpdating = false;
    const tab = document.querySelector('.tabs [aria-selected="true"]')?.dataset.tab;
    if (tab) showTab(tab);
  }
}

async function runUpdate() {
  $('#status').textContent = 'Lade Cardmarket-Daten … (kann 1–2 Minuten dauern)';
  try {
    await api('/api/update', { method: 'POST' });
  } catch (e) {
    alertBox(`Update fehlgeschlagen: ${e.message}`);
  }
  loadStatus();
}

function alertBox(msg) {
  $('#status').textContent = msg;
}

// ---------------------------------------------------------------- Tabs
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  if (tab === 'movers') loadMovers();
  if (tab === 'watch') loadWatchlist();
  try { localStorage.setItem('kh-tab', tab); } catch {}
}

// ---------------------------------------------------------------- Listen
function scryImg(id) {
  return state.status?.demo ? null : `https://api.scryfall.com/cards/cardmarket/${id}?format=image&version=small`;
}

function rowHtml(c, { change, changeLabel } = {}) {
  const img = scryImg(c.id);
  const chg = change !== undefined ? change : c.guideTrend?.change7v30;
  return `<div class="row" data-id="${c.id}">
    ${img ? `<img loading="lazy" src="${img}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))">` : '<div class="ph"></div>'}
    <div><div class="name">${esc(c.name)}</div><div class="sub">Cardmarket #${c.id}${c.expansion_id ? ` · Edition ${c.expansion_id}` : ''}</div></div>
    <div class="price">${eur(state.foil && c.trend_foil ? c.trend_foil : c.trend)}<small>ab ${eur(c.low)}</small></div>
    <div class="chg chg-col ${dir(chg)}" title="${esc(changeLabel || '7-Tage-Ø gegen 30-Tage-Ø')}">${arrow(chg)} ${pct(chg)}</div>
    <button class="star ${c.watched ? 'on' : ''}" data-star="${c.id}" aria-label="Merken">${c.watched ? '★' : '☆'}</button>
  </div>`;
}

function bindRows(container) {
  container.querySelectorAll('.row').forEach((r) => r.addEventListener('click', (e) => {
    const star = e.target.closest('[data-star]');
    if (star) {
      e.stopPropagation();
      toggleWatch(Number(star.dataset.star), !star.classList.contains('on')).then(() => {
        star.classList.toggle('on');
        star.textContent = star.classList.contains('on') ? '★' : '☆';
      });
      return;
    }
    openCard(Number(r.dataset.id));
  }));
}

async function toggleWatch(id, on) {
  await api(`/api/watchlist/${id}`, { method: on ? 'POST' : 'DELETE' });
}

// ---------------------------------------------------------------- Suche
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  const box = $('#search-results');
  box.innerHTML = '<div class="empty">Suche …</div>';
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}`);
  box.innerHTML = rows.length ? rows.map((c) => rowHtml(c)).join('') : `<div class="empty">Nichts gefunden für „${esc(q)}“.</div>`;
  bindRows(box);
});

// ---------------------------------------------------------------- Trends
const mv = { direction: 'up' };
$('#mv-dir').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mv.direction = b.dataset.v;
  $('#mv-dir').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadMovers();
});
['#mv-days', '#mv-min', '#mv-foil'].forEach((s) => $(s).addEventListener('change', loadMovers));

async function loadMovers() {
  const box = $('#movers');
  box.innerHTML = '<div class="empty">Lade …</div>';
  const days = $('#mv-days').value;
  const params = new URLSearchParams({ direction: mv.direction, days, minPrice: $('#mv-min').value, foil: $('#mv-foil').checked ? '1' : '0' });
  const r = await api(`/api/movers?${params}`);
  const word = mv.direction === 'up' ? 'gestiegen' : 'gefallen';
  $('#mv-source').textContent = r.source === 'history'
    ? `Top ${r.rows.length}: Karten, deren Preis vom ${fmtDay(r.from)} bis ${fmtDay(r.to)} am stärksten ${word} ist.`
    : `Top ${r.rows.length}: Karten, deren Durchschnittspreis der letzten 7 Tage am stärksten gegenüber dem 30-Tage-Durchschnitt ${word} ist (echte Verkaufspreise von Cardmarket).`;
  const labels = r.source === 'history' ? [fmtDay(r.from), fmtDay(r.to)] : ['Ø 30 Tage', 'Ø 7 Tage'];
  box.innerHTML = r.rows.length
    ? r.rows.map((c, i) => moverHtml(c, i + 1, labels)).join('')
    : `<div class="empty">${state.status?.products ? 'Keine Karten für diese Filter.' : 'Noch keine Preise geladen.'}</div>`;
  bindRows(box);
}

function moverHtml(c, rank, [fromLabel, toLabel]) {
  const img = scryImg(c.id);
  return `<div class="row mover" data-id="${c.id}">
    ${img ? `<img loading="lazy" src="${img}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))">` : '<div class="ph"></div>'}
    <div><div class="name"><span class="rank">${rank}.</span> ${esc(c.name)}</div>
      <div class="sub">${fromLabel}: <b>${eur(c.then_price)}</b> → ${toLabel}: <b>${eur(c.now_price)}</b> · Trend ${eur($('#mv-foil').checked ? c.trend_foil : c.trend)}</div></div>
    <div class="chg big ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}</div>
    <button class="star ${c.watched ? 'on' : ''}" data-star="${c.id}" aria-label="Merken">${c.watched ? '★' : '☆'}</button>
  </div>`;
}

// ---------------------------------------------------------------- Merkliste
async function loadWatchlist() {
  const box = $('#watchlist');
  const rows = await api('/api/watchlist');
  box.innerHTML = rows.length
    ? rows.map((c) => rowHtml(c, { change: c.historyChange.d7 ?? c.guideTrend?.change7v30, changeLabel: '7 Tage' })).join('')
    : '<div class="empty">Noch keine Karten gemerkt.</div>';
  bindRows(box);
}

// ---------------------------------------------------------------- Detail
$('#d-close').addEventListener('click', closeCard);
$('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeCard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });
function closeCard() {
  $('#detail').hidden = true;
  document.body.style.overflow = '';
}

segment('#d-foil', (v) => { state.foil = v === '1'; renderCard(); loadOffers(); });
segment('#d-range', (v) => { state.range = Number(v); renderChart(); });
['#o-cond', '#o-lang'].forEach((s) => $(s).addEventListener('change', loadOffers));

function segment(sel, onChange) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $(sel).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onChange(b.dataset.v);
  });
}

async function openCard(id) {
  state.card = await api(`/api/card/${id}`);
  $('#detail').hidden = false;
  document.body.style.overflow = 'hidden';
  renderCard();
  loadOffers();
  loadScryfall(id);
}

async function loadScryfall(id) {
  const img = $('#d-img');
  img.hidden = true;
  $('#d-set').textContent = state.card.expansion_id ? `Edition ${state.card.expansion_id}` : '';
  if (state.status?.demo) return;
  try {
    let s = state.scry.get(id);
    if (!s) {
      const res = await fetch(`https://api.scryfall.com/cards/cardmarket/${id}`);
      if (!res.ok) return;
      s = await res.json();
      state.scry.set(id, s);
    }
    if (state.card?.id !== id) return;
    const uri = s.image_uris?.normal || s.card_faces?.[0]?.image_uris?.normal;
    if (uri) { img.src = uri; img.hidden = false; }
    $('#d-set').textContent = `${s.set_name} (${String(s.set).toUpperCase()}) · #${s.collector_number} · ${s.rarity}`;
  } catch { /* Scryfall nicht erreichbar: ohne Bild weiter */ }
}

function renderCard() {
  const c = state.card;
  if (!c) return;
  const f = state.foil ? '_foil' : '';
  $('#d-name').textContent = c.name;
  $('#d-cm').href = `https://www.cardmarket.com/de/Magic/Products/Search?searchString=${encodeURIComponent(c.name)}`;
  const w = $('#d-watch');
  w.textContent = c.watched ? '★ Gemerkt' : '☆ Merken';
  w.onclick = async () => { await toggleWatch(c.id, !c.watched); c.watched = !c.watched; renderCard(); };

  const g = state.foil ? c.guideTrendFoil : c.guideTrend;
  const hc = state.foil ? null : c.historyChange;
  const tile = (label, value, delta, deltaLabel) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>`
    + (delta !== undefined ? `<div class="delta ${dir(delta)}">${arrow(delta)} ${pct(delta)} <span class="muted">${deltaLabel}</span></div>` : '') + '</div>';
  $('#d-tiles').innerHTML = [
    tile('Trendpreis', eur(c['trend' + f]), g?.change7v30, '7T-Ø vs. 30T-Ø'),
    tile('Ab-Preis (günstigster)', eur(c['low' + f])),
    tile('Ø 1 Tag', eur(c['avg1' + f]), g?.change1v7, 'vs. 7T-Ø'),
    tile('Ø 7 Tage', eur(c['avg7' + f])),
    tile('Ø 30 Tage', eur(c['avg30' + f])),
    hc?.d30 != null ? tile('Eigener Verlauf 30 T', pct(hc.d30)) : '',
  ].join('');
  renderChart();
}

// ---------------------------------------------------------------- Graph (SVG)
function renderChart() {
  const c = state.card;
  const box = $('#d-chart');
  let hist = c.history;
  if (state.range) {
    const last = hist[hist.length - 1]?.day;
    if (last) {
      const d = new Date(last + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - state.range);
      const cut = d.toISOString().slice(0, 10);
      hist = hist.filter((h) => h.day >= cut);
    }
  }
  const series = state.foil
    ? [{ key: 'trend_foil', name: 'Trendpreis Foil', color: 'var(--series-1)' }]
    : [{ key: 'trend', name: 'Trendpreis', color: 'var(--series-1)' }, { key: 'low', name: 'Ab-Preis', color: 'var(--series-2)' }];
  const usable = series.filter((s) => hist.some((h) => h[s.key] != null));

  $('#d-legend').innerHTML = usable.length > 1 ? usable.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('') : '';
  $('#d-table').innerHTML = `<table><thead><tr><th>Tag</th>${usable.map((s) => `<th class="num">${s.name}</th>`).join('')}</tr></thead><tbody>`
    + hist.slice().reverse().map((h) => `<tr><td>${fmtDay(h.day)}</td>${usable.map((s) => `<td class="num">${eur(h[s.key])}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';

  if (hist.length < 2 || !usable.length) {
    box.innerHTML = `<div class="empty">${hist.length ? 'Erst ein Tag Verlauf gespeichert.' : 'Noch kein Verlauf gespeichert.'}
      Der Preis wird ab jetzt täglich aufgezeichnet${c.watched ? '' : ' (Tipp: Karte merken, dann auf jeden Fall)'}.
      Bis dahin zeigen die Kacheln oben den Trend aus den Cardmarket-Durchschnitten.</div>`;
    return;
  }

  const W = Math.max(box.clientWidth || 600, 280), H = 260;
  const m = { l: 52, r: usable.length > 1 ? 70 : 16, t: 12, b: 26 };
  const t0 = Date.parse(hist[0].day), t1 = Date.parse(hist[hist.length - 1].day);
  const vals = hist.flatMap((h) => usable.map((s) => h[s.key])).filter((v) => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.1 || hi * 0.1 || 1;
  lo = Math.max(0, lo - pad); hi += pad;
  const ticks = niceTicks(lo, hi, 5);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (day) => m.l + ((Date.parse(day) - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const xt = [];
  const n = Math.min(W < 500 ? 4 : 6, hist.length);
  for (let i = 0; i < n; i++) xt.push(hist[Math.round((i * (hist.length - 1)) / (n - 1 || 1))]);

  const paths = usable.map((s) => {
    let d = '', pen = false;
    for (const h of hist) {
      if (h[s.key] == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(h.day).toFixed(1)},${y(h[s.key]).toFixed(1)}`;
      pen = true;
    }
    const lastPt = [...hist].reverse().find((h) => h[s.key] != null);
    return { s, d, lastPt };
  });

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Preisverlauf ${esc(c.name)}">
    <g class="axis">
      ${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${eur(t)}</text>`).join('')}
      ${xt.map((h) => `<text x="${x(h.day)}" y="${H - 6}" text-anchor="middle">${fmtDay(h.day).slice(0, 5)}</text>`).join('')}
    </g>
    ${paths.map((p) => `<path d="${p.d}" fill="none" stroke="${p.s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
    ${usable.length > 1 ? paths.map((p) => p.lastPt ? `<text x="${x(p.lastPt.day) + 6}" y="${y(p.lastPt[p.s.key]) + 4}" font-size="11" fill="var(--text-2)">${p.s.name}</text>` : '').join('') : ''}
    <line class="hover-line" id="hv-line" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    ${usable.map((s, i) => `<circle id="hv-dot-${i}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`).join('')}
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="hv-hit"/>
  </svg>`;

  const svg = box.querySelector('svg');
  const tip = $('#tooltip');
  const hit = $('#hv-hit', svg);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = hist[0], bd = Infinity;
    for (const h of hist) { const dd = Math.abs(x(h.day) - px); if (dd < bd) { bd = dd; best = h; } }
    const line = $('#hv-line', svg);
    line.setAttribute('x1', x(best.day)); line.setAttribute('x2', x(best.day)); line.setAttribute('visibility', 'visible');
    usable.forEach((s, i) => {
      const dot = $(`#hv-dot-${i}`, svg);
      if (best[s.key] == null) return dot.setAttribute('visibility', 'hidden');
      dot.setAttribute('cx', x(best.day)); dot.setAttribute('cy', y(best[s.key])); dot.setAttribute('visibility', 'visible');
    });
    tip.innerHTML = `<div class="t-day">${fmtDay(best.day)}</div>` + usable.map((s) => `<div><i style="background:${s.color}"></i>${s.name}: <b>${eur(best[s.key])}</b></div>`).join('');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tw - 8)}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  };
  const leave = () => {
    tip.hidden = true;
    $('#hv-line', svg).setAttribute('visibility', 'hidden');
    usable.forEach((s, i) => $(`#hv-dot-${i}`, svg).setAttribute('visibility', 'hidden'));
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

function niceTicks(lo, hi, count) {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) || 10 * mag;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

window.addEventListener('resize', () => { if (!$('#detail').hidden) renderChart(); });

// ---------------------------------------------------------------- Angebote
async function loadOffers() {
  const c = state.card;
  const box = $('#d-offers');
  box.innerHTML = '<div class="empty">Lade Angebote …</div>';
  const params = new URLSearchParams({ foil: state.foil ? '1' : '0', minCondition: $('#o-cond').value, language: $('#o-lang').value });
  try {
    const r = await api(`/api/card/${c.id}/offers?${params}`);
    if (state.card?.id !== c.id) return;
    if (r.source === 'none') {
      box.innerHTML = `<p class="hint">${esc(r.message)}</p>
        <p>Günstigster Preis laut Cardmarket-Preisguide: <b>${eur(state.foil ? c.low_foil : c.low)}</b> ·
        <a href="https://www.cardmarket.com/de/Magic/Products/Search?searchString=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">Angebote auf Cardmarket ansehen ↗</a></p>`;
      return;
    }
    if (!r.offers.length) { box.innerHTML = '<div class="empty">Keine Angebote für diese Filter.</div>'; return; }
    box.innerHTML = `<table><thead><tr><th>#</th><th class="num">Preis</th><th>Land</th><th>Zustand</th><th>Sprache</th><th>Verkäufer</th></tr></thead><tbody>
      ${r.offers.map((o, i) => `<tr><td>${i + 1}</td><td class="num"><b>${eur(o.price)}</b></td>
        <td><span class="flag">${o.country.flag}</span>${esc(o.country.name)}</td>
        <td>${esc(o.condition ?? '')}</td><td>${esc(o.language ?? '')}</td><td>${esc(o.seller ?? '')}</td></tr>`).join('')}
    </tbody></table>${r.source === 'demo' ? '<p class="hint">Demo-Angebote, erfunden.</p>' : ''}`;
  } catch (e) {
    box.innerHTML = `<p class="hint">Angebote konnten nicht geladen werden: ${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- Start
await loadStatus();
let startTab = 'search';
try { startTab = localStorage.getItem('kh-tab') || 'search'; } catch {}
showTab(startTab);
