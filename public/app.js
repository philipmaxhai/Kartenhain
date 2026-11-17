// Kartenhain Preistracker – Oberfläche (ohne Frameworks)
import { sparkline, histogramSvg, areaChart } from './charts.js';

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

const state = { status: null, card: null, foil: false, range: 90, scry: new Map(), view: {}, lists: {} };

// Tooltip, den alle Diagramme teilen
const tooltip = {
  show(ev, html) {
    const tip = $('#tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${ev.clientY + 14}px`;
  },
  hide() { $('#tooltip').hidden = true; },
};

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
    loadSets().catch(() => {});
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
  if (tab === 'home') loadHome();
  if (tab === 'movers') loadMovers();
  if (tab === 'deals') loadDeals();
  if (tab === 'watch') loadWatchlist();
  try { localStorage.setItem('kh-tab', tab); } catch {}
}

// Liste/Kacheln umschalten
document.querySelectorAll('.view-toggle').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  state.view[seg.dataset.for] = b.dataset.v;
  try { localStorage.setItem(`kh-view-${seg.dataset.for}`, b.dataset.v); } catch {}
  if (seg.dataset.for === 'movers') renderMovers();
}));

/** Editionslisten für die Filter einmal laden. */
async function loadSets() {
  const sets = await api('/api/sets');
  const opts = sets.map((s) => `<option value="${s.id}">${esc(s.name)}${s.code ? ` (${esc(s.code)})` : ''}${s.release_date ? ` · ${s.release_date.slice(0, 4)}` : ''}</option>`).join('');
  document.querySelectorAll('.set-select').forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">alle Editionen</option>' + opts;
    sel.value = cur;
  });
}

/** CSV-Datei (Excel-tauglich: Semikolon, Komma als Dezimaltrenner) herunterladen. */
function downloadCsv(name, header, rows) {
  const cell = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return String(Math.round(v * 10000) / 10000).replace('.', ',');
    const t = String(v);
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = '\ufeff' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function imgTag(id, size = 'small', cls = '') {
  const src = state.status?.demo ? null : `https://api.scryfall.com/cards/cardmarket/${id}?format=image&version=${size}`;
  return src
    ? `<img class="${cls}" loading="lazy" src="${src}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph ${cls}'}))">`
    : `<div class="ph ${cls}"></div>`;
}

// ---------------------------------------------------------------- Übersicht
$('#home-min').addEventListener('change', loadHome);
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  const d = b.dataset.dir;
  mv.direction = d;
  $('#mv-dir').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === d)));
  showTab(b.dataset.goto);
}));

async function loadHome() {
  const d = await api(`/api/dashboard?minPrice=${$('#home-min').value}`);
  const p = d.portfolio;
  updateAlertBadge(p.alerts);

  $('#home-alerts').innerHTML = p.alerts.length ? `<div class="alert-box">🔔 <b>Preisalarm:</b> ${p.alerts.map((a) =>
    `<button class="link" data-open="${a.id}">${esc(a.name)}</button> ${a.alert === 'below' ? `ist auf ${eur(a.price)} gefallen (Alarm unter ${eur(a.alert_below)})` : `ist auf ${eur(a.price)} gestiegen (Alarm über ${eur(a.alert_above)})`}`).join(' · ')}</div>` : '';

  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  $('#home-kpis').innerHTML = [
    d.gainers.rows[0]
      ? kpi('Größter Anstieg', `<span class="up">${arrow(d.gainers.rows[0].change)} ${pct(d.gainers.rows[0].change)}</span>`, esc(d.gainers.rows[0].name))
      : kpi('Größter Anstieg', '–', 'noch keine Daten'),
    kpi('Karten gestiegen', `▲ ${d.up.toLocaleString('de-DE')}`, `von ${d.cards.toLocaleString('de-DE')} Karten ab ${eur(d.minPrice)}`, 'up'),
    kpi('Karten gefallen', `▼ ${d.down.toLocaleString('de-DE')}`, `${d.flat.toLocaleString('de-DE')} etwa gleich geblieben`, 'down'),
    p.owned
      ? kpi('Wert meiner Karten', eur(p.value), p.profit != null ? `<span class="${dir(p.profit)}">${p.profit >= 0 ? '+' : ''}${eur(p.profit)} ${p.profit >= 0 ? 'Gewinn' : 'Verlust'}</span>` : `${p.copies} Karten im Bestand`)
      : kpi('Meine Karten', `${p.watched}`, 'gemerkt · Menge eintragen für Gesamtwert'),
  ].join('');

  const total = d.up + d.down + d.flat || 1;
  const w = (n) => `${((n / total) * 100).toFixed(1)}%`;
  $('#home-mood').innerHTML = `
    <div class="mood-big ${dir(d.medianChange)}">${moodWord(d)}</div>
    <div class="muted small">Typische Karte: ${pct(d.medianChange)} (Ø 7 Tage gegen Ø 30 Tage)</div>
    <div class="mood-bar" role="img" aria-label="${d.up} gestiegen, ${d.flat} gleich, ${d.down} gefallen">
      <span class="seg-down" style="width:${w(d.down)}"></span><span class="seg-flat" style="width:${w(d.flat)}"></span><span class="seg-up" style="width:${w(d.up)}"></span>
    </div>
    <div class="mood-legend">
      <span><i class="dot down"></i>Gefallen ${Math.round((d.down / total) * 100)} %</span>
      <span><i class="dot flat"></i>Gleich ${Math.round((d.flat / total) * 100)} %</span>
      <span><i class="dot up"></i>Gestiegen ${Math.round((d.up / total) * 100)} %</span>
    </div>
    <p class="hint">„Gleich“ heißt weniger als ±2 % Veränderung.</p>`;
  $('#home-hist').innerHTML = d.cards ? histogramSvg(d.histogram) : '<div class="empty small">Noch keine Preise geladen.</div>';

  const mini = (c) => `<div class="mini" data-open="${c.id}">
      ${imgTag(c.id, 'normal', 'mini-img')}
      <div class="mini-body">
        <div class="mini-name">${esc(c.name)}</div>
        <div class="mini-set">${setLabel(c)}</div>
        <div class="mini-row"><b>${eur(c.trend)}</b>${c.change != null ? `<span class="chg ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}</span>` : ''}</div>
        ${sparkline(c.spark, { w: 120, h: 26 })}
      </div></div>`;
  const fill = (sel, rows) => { $(sel).innerHTML = rows.length ? rows.map(mini).join('') : '<div class="empty small">Keine Karten.</div>'; };
  fill('#home-up', d.gainers.rows);
  fill('#home-down', d.losers.rows);
  fill('#home-top', d.mostValuable);
  bindRows($('#tab-home'));
}

function moodWord(d) {
  const m = d.medianChange ?? 0;
  if (m > 0.03) return 'Stark steigend';
  if (m > 0.005) return 'Leicht steigend';
  if (m < -0.03) return 'Stark fallend';
  if (m < -0.005) return 'Leicht fallend';
  return 'Ruhig';
}

function updateAlertBadge(alerts) {
  const b = $('#alert-badge');
  b.hidden = !alerts?.length;
  b.textContent = alerts?.length ? `🔔 ${alerts.length}` : '';
}

// ---------------------------------------------------------------- Listen
function scryImg(id) {
  return state.status?.demo ? null : `https://api.scryfall.com/cards/cardmarket/${id}?format=image&version=small`;
}

function setLabel(c) {
  if (c.set_name) return `${esc(c.set_name)}${c.set_code ? ` (${esc(c.set_code)})` : ''}${c.release_date ? ` · ${c.release_date.slice(0, 4)}` : ''}`;
  return c.expansion_id ? `Edition #${c.expansion_id}` : 'Edition unbekannt';
}

function rowHtml(c, { change, changeLabel, showName = true } = {}) {
  const img = scryImg(c.id);
  const chg = change !== undefined ? change : c.guideTrend?.change7v30;
  return `<div class="row" data-id="${c.id}">
    ${img ? `<img loading="lazy" src="${img}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph'}))">` : '<div class="ph"></div>'}
    <div>${showName ? `<div class="name">${esc(c.name)}</div><div class="sub">${setLabel(c)}</div>` : `<div class="name set">${setLabel(c)}</div>`}</div>
    <div class="price" title="Preis-Trend = typischer Verkaufspreis laut Cardmarket">${eur(state.foil && c.trend_foil ? c.trend_foil : c.trend)}<small>ab ${eur(c.low)}</small></div>
    <div class="chg chg-col ${dir(chg)}" title="${esc(changeLabel || '7-Tage-Ø gegen 30-Tage-Ø')}">${arrow(chg)} ${pct(chg)}</div>
    <button class="star ${c.watched ? 'on' : ''}" data-star="${c.id}" aria-label="Merken">${c.watched ? '★' : '☆'}</button>
  </div>`;
}

function bindRows(container) {
  container.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openCard(Number(el.dataset.open))));
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
  const groups = await api(`/api/search?q=${encodeURIComponent(q)}`);
  box.innerHTML = groups.length ? groups.map(groupHtml).join('') : `<div class="empty">Nichts gefunden für „${esc(q)}“.</div>`;
  box.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const list = b.previousElementSibling;
    list.classList.toggle('collapsed');
    b.textContent = list.classList.contains('collapsed') ? b.dataset.more : 'Weniger anzeigen';
  }));
  bindRows(box);
});

/** Eine Karte mit all ihren Versionen: günstigste und teuerste im Verhältnis. */
function groupHtml(g) {
  const priced = g.versions.filter((v) => v.trend != null);
  const cheap = priced[0];
  const dear = priced[priced.length - 1];
  const median = priced.length ? priced[Math.floor((priced.length - 1) / 2)].trend : null;
  const factor = cheap && dear && cheap.trend > 0 ? dear.trend / cheap.trend : null;
  const pick = (label, v, cls) => v ? `<div class="pick ${cls}" data-open="${v.id}">
      <div class="pick-label">${label}</div>
      <div class="pick-price">${eur(v.trend)}</div>
      <div class="pick-set">${setLabel(v)}</div></div>` : '';
  const many = g.versions.length > 1;
  return `<div class="group">
    <div class="group-head">
      <h3>${esc(g.name)}</h3>
      <span class="muted">${g.count} ${g.count === 1 ? 'Version' : 'Versionen'}${many && median != null ? ` · typisch ${eur(median)}` : ''}</span>
    </div>
    ${many && cheap && dear && cheap !== dear ? `
      <div class="picks">
        ${pick('Günstigste Version', cheap, 'cheap')}
        <div class="ratio" title="So viel teurer ist die teuerste Version">
          <div class="ratio-num">${factor >= 1.05 ? `${factor.toLocaleString('de-DE', { maximumFractionDigits: factor < 10 ? 1 : 0 })}×` : '≈'}</div>
          <div class="ratio-txt">so teuer wie<br>die günstigste</div>
        </div>
        ${pick('Teuerste Version', dear, 'dear')}
      </div>
      ${spreadHtml(priced, cheap.trend, dear.trend)}` : ''}
    <div class="list versions ${g.versions.length > 4 ? 'collapsed' : ''}">
      ${g.versions.map((v) => rowHtml(v, { showName: false })).join('')}
    </div>
    ${g.versions.length > 4 ? `<button class="more ghost" data-more="Alle ${g.count} Versionen anzeigen">Alle ${g.count} Versionen anzeigen</button>` : ''}
  </div>`;
}

/** Punktleiste (logarithmisch): wo liegen die Versionen zwischen günstig und teuer? */
function spreadHtml(priced, lo, hi) {
  if (!(lo > 0) || hi / lo < 1.05) return '';
  const pos = (v) => (Math.log(v / lo) / Math.log(hi / lo)) * 100;
  return `<div class="spread" aria-hidden="true">
    <div class="spread-line"></div>
    ${priced.map((v) => `<span class="spread-dot" style="left:${pos(v.trend).toFixed(1)}%" title="${esc(v.set_name || '')}: ${eur(v.trend)}"></span>`).join('')}
  </div>
  <div class="spread-axis"><span>${eur(lo)}</span><span>Preise aller Versionen (logarithmisch)</span><span>${eur(hi)}</span></div>`;
}

// ---------------------------------------------------------------- Trends
const mv = { direction: 'up' };
$('#mv-dir').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mv.direction = b.dataset.v;
  $('#mv-dir').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadMovers();
});
['#mv-days', '#mv-min', '#mv-max', '#mv-sort', '#mv-foil', '#mv-set'].forEach((s) => $(s).addEventListener('change', loadMovers));
let mvTimer;
$('#mv-q').addEventListener('input', () => { clearTimeout(mvTimer); mvTimer = setTimeout(loadMovers, 350); });

async function loadMovers() {
  const box = $('#movers');
  box.innerHTML = '<div class="empty">Lade …</div>';
  const days = $('#mv-days').value;
  const params = new URLSearchParams({
    direction: mv.direction, days, minPrice: $('#mv-min').value, maxPrice: $('#mv-max').value,
    sort: $('#mv-sort').value, foil: $('#mv-foil').checked ? '1' : '0', set: $('#mv-set').value, q: $('#mv-q').value.trim(),
  });
  const r = await api(`/api/movers?${params}`);
  state.lists.movers = r;
  const word = mv.direction === 'up' ? 'gestiegen' : 'gefallen';
  $('#mv-source').textContent = r.source === 'history'
    ? `Top ${r.rows.length}: Karten, deren Preis vom ${fmtDay(r.from)} bis ${fmtDay(r.to)} am stärksten ${word} ist.`
    : `Top ${r.rows.length}: Karten, deren Durchschnittspreis der letzten 7 Tage am stärksten gegenüber dem 30-Tage-Durchschnitt ${word} ist (echte Verkaufspreise von Cardmarket).`;
  renderMovers();
}

function renderMovers() {
  const r = state.lists.movers;
  const box = $('#movers');
  if (!r) return;
  const labels = r.source === 'history' ? [fmtDay(r.from), fmtDay(r.to)] : ['Ø 30 Tage', 'Ø 7 Tage'];
  const tiles = state.view.movers === 'tiles';
  box.className = tiles ? 'tile-grid' : 'list';
  box.innerHTML = r.rows.length
    ? r.rows.map((c, i) => (tiles ? cardTileHtml(c, i + 1) : moverHtml(c, i + 1, labels))).join('')
    : `<div class="empty">${state.status?.products ? 'Keine Karten für diese Filter.' : 'Noch keine Preise geladen.'}</div>`;
  bindRows(box);
}

$('#mv-csv').addEventListener('click', () => {
  const r = state.lists.movers;
  if (!r?.rows.length) return;
  const foil = $('#mv-foil').checked;
  downloadCsv(`kartenhain-trends-${mv.direction === 'up' ? 'gestiegen' : 'gefallen'}.csv`,
    ['Rang', 'Karte', 'Edition', 'Vorher (€)', 'Jetzt (€)', 'Veränderung (%)', 'Preis-Trend (€)', 'Günstigstes Angebot (€)', 'Cardmarket-ID'],
    r.rows.map((c, i) => [i + 1, c.name, c.set_name ?? '', c.then_price, c.now_price, c.change * 100,
      foil ? c.trend_foil : c.trend, foil ? c.low_foil : c.low, c.id]));
});

function moverHtml(c, rank, [fromLabel, toLabel]) {
  return `<div class="row mover" data-id="${c.id}">
    ${imgTag(c.id)}
    <div><div class="name"><span class="rank">${rank}.</span> ${esc(c.name)}</div>
      <div class="sub">${setLabel(c)}</div>
      <div class="sub">${fromLabel}: <b>${eur(c.then_price)}</b> → ${toLabel}: <b>${eur(c.now_price)}</b> · Preis-Trend ${eur($('#mv-foil').checked ? c.trend_foil : c.trend)}</div></div>
    <div class="spark-col">${sparkline(c.spark)}</div>
    <div class="chg big ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}</div>
    <button class="star ${c.watched ? 'on' : ''}" data-star="${c.id}" aria-label="Merken">${c.watched ? '★' : '☆'}</button>
  </div>`;
}

/** Kachel mit großem Kartenbild. */
function cardTileHtml(c, rank) {
  return `<div class="ctile row" data-id="${c.id}">
    <div class="ctile-img">${imgTag(c.id, 'normal', 'ctile-pic')}
      <span class="ctile-rank">${rank}</span>
      <span class="ctile-badge ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}</span>
      <button class="star ctile-star ${c.watched ? 'on' : ''}" data-star="${c.id}" aria-label="Merken">${c.watched ? '★' : '☆'}</button>
    </div>
    <div class="ctile-body">
      <div class="name">${esc(c.name)}</div>
      <div class="sub">${setLabel(c)}</div>
      <div class="ctile-prices"><span>${eur(c.then_price)} → <b>${eur(c.now_price)}</b></span>${sparkline(c.spark, { w: 70, h: 22 })}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- Schnäppchen
['#dl-min', '#dl-ratio', '#dl-sort', '#dl-set'].forEach((s) => $(s).addEventListener('change', loadDeals));

async function loadDeals() {
  const box = $('#deals');
  box.innerHTML = '<div class="empty">Lade …</div>';
  const params = new URLSearchParams({ minPrice: $('#dl-min').value, maxRatio: $('#dl-ratio').value, sort: $('#dl-sort').value, set: $('#dl-set').value });
  const rows = (state.lists.deals = await api(`/api/deals?${params}`));
  box.innerHTML = rows.length ? rows.map(dealHtml).join('') : '<div class="empty">Keine Schnäppchen für diese Filter.</div>';
  bindRows(box);
}

function dealHtml(c) {
  const pctLow = Math.max(0, Math.min(100, (c.low / c.trend) * 100));
  return `<div class="row deal" data-id="${c.id}">
    ${imgTag(c.id)}
    <div><div class="name">${esc(c.name)}</div><div class="sub">${setLabel(c)}</div>
      <div class="deal-bar" title="Günstigstes Angebot im Verhältnis zum Preis-Trend">
        <span class="deal-fill" style="width:${pctLow.toFixed(1)}%"></span>
        <span class="deal-lbl">ab <b>${eur(c.low)}</b></span><span class="deal-lbl right">Trend <b>${eur(c.trend)}</b></span>
      </div></div>
    <div class="deal-save"><div class="big up">−${Math.round(c.discount * 100)} %</div><div class="sub">${eur(c.spread)} unter Trend</div></div>
    <button class="star ${c.watched ? 'on' : ''}" data-star="${c.id}" aria-label="Merken">${c.watched ? '★' : '☆'}</button>
  </div>`;
}

$('#dl-csv').addEventListener('click', () => {
  const rows = state.lists.deals;
  if (!rows?.length) return;
  downloadCsv('kartenhain-schnaeppchen.csv',
    ['Karte', 'Edition', 'Günstigstes Angebot (€)', 'Preis-Trend (€)', 'Ersparnis (€)', 'Ersparnis (%)', 'Ø 7 Tage (€)', 'Cardmarket-ID'],
    rows.map((c) => [c.name, c.set_name ?? '', c.low, c.trend, c.spread, c.discount * 100, c.avg7, c.id]));
});

// ---------------------------------------------------------------- Meine Karten
async function loadWatchlist() {
  const [rows, pf] = await Promise.all([api('/api/watchlist'), api('/api/portfolio')]);
  updateAlertBadge(pf.alerts);
  const kpi = (label, value, sub = '') => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  $('#pf-kpis').innerHTML = [
    kpi('Gesamtwert', eur(pf.value), `${pf.copies} Karten · ${pf.owned} verschiedene`),
    kpi('Einkaufswert', pf.cost != null ? eur(pf.cost) : '–', 'nur Karten mit Einkaufspreis'),
    kpi('Gewinn / Verlust', pf.profit != null ? `<span class="${dir(pf.profit)}">${pf.profit >= 0 ? '+' : ''}${eur(pf.profit)}</span>` : '–',
      pf.cost ? `<span class="${dir(pf.profit)}">${pct(pf.profit / pf.cost)}</span>` : 'Einkaufspreis eintragen'),
    kpi('Preisalarme', pf.alerts.length ? `🔔 ${pf.alerts.length}` : '0', pf.alerts.length ? 'ausgelöst' : 'nichts ausgelöst'),
  ].join('');
  areaChart($('#pf-chart'), pf.history, { label: 'Wert meiner Karten', tooltip });

  const box = $('#watchlist');
  box.innerHTML = rows.length ? rows.map(ownHtml).join('') : '<div class="empty">Noch keine Karten gemerkt. Tippe bei einer Karte auf ☆.</div>';
  bindRows(box);
  box.querySelectorAll('.own-form').forEach(bindOwnForm);
}

function ownHtml(c) {
  const chg = c.historyChange.d7 ?? c.guideTrend?.change7v30;
  return `<div class="own ${c.alert ? 'alerted' : ''}">
    <div class="row own-row" data-id="${c.id}">
      ${imgTag(c.id)}
      <div><div class="name">${esc(c.name)}${c.foil ? ' <span class="pill">Foil</span>' : ''}</div><div class="sub">${setLabel(c)}</div>
        ${c.alert ? `<div class="alert-line">🔔 ${c.alert === 'below' ? `unter ${eur(c.alert_below)} gefallen` : `über ${eur(c.alert_above)} gestiegen`}</div>` : ''}</div>
      <div class="spark-col">${sparkline(c.spark)}</div>
      <div class="price">${eur(c.value_each)}<small class="${dir(chg)}">${arrow(chg)} ${pct(chg)}</small></div>
      <button class="star on" data-star="${c.id}" aria-label="Nicht mehr merken">★</button>
    </div>
    ${ownFormHtml(c.id, c)}
    <div class="own-sum">
      ${c.qty ? `<span>Wert: <b>${eur(c.value)}</b></span>` : ''}
      ${c.profit != null ? `<span class="${dir(c.profit)}">${c.profit >= 0 ? 'Gewinn' : 'Verlust'}: <b>${c.profit >= 0 ? '+' : ''}${eur(c.profit)}</b></span>` : ''}
    </div>
  </div>`;
}

function ownFormHtml(id, o = {}) {
  const v = (x) => (x == null ? '' : String(x));
  return `<form class="own-form" data-id="${id}">
    <label>Menge<input type="number" name="qty" min="0" step="1" value="${v(o.qty || '')}" placeholder="0"></label>
    <label>Einkaufspreis / Stück<input type="number" name="buy_price" min="0" step="0.01" value="${v(o.buy_price)}" placeholder="€"></label>
    <label>Alarm unter<input type="number" name="alert_below" min="0" step="0.01" value="${v(o.alert_below)}" placeholder="€"></label>
    <label>Alarm über<input type="number" name="alert_above" min="0" step="0.01" value="${v(o.alert_above)}" placeholder="€"></label>
    <label class="check"><input type="checkbox" name="foil" ${o.foil || o.own_foil ? 'checked' : ''}> Foil</label>
    <span class="saved" hidden>✓ gespeichert</span>
  </form>`;
}

function bindOwnForm(form, onSaved) {
  let t;
  const save = async () => {
    const f = new FormData(form);
    await api(`/api/watchlist/${form.dataset.id}`, {
      method: 'PUT',
      body: JSON.stringify({ qty: f.get('qty'), buy_price: f.get('buy_price'), alert_below: f.get('alert_below'), alert_above: f.get('alert_above'), foil: f.get('foil') === 'on' }),
    });
    const ok = form.querySelector('.saved');
    ok.hidden = false;
    setTimeout(() => { ok.hidden = true; }, 1500);
    onSaved?.();
  };
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 600); });
  form.addEventListener('change', () => { clearTimeout(t); save(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
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
  $('#d-set').innerHTML = setLabel(state.card);
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
  $('#d-own').innerHTML = `<div class="card-head"><h3>Meine Karten</h3><span class="muted small">${c.watched ? 'Wird automatisch gespeichert' : 'Eintragen merkt die Karte automatisch'}</span></div>`
    + ownFormHtml(c.id, c.own ?? {});
  bindOwnForm($('#d-own .own-form'), () => {
    c.watched = true;
    $('#d-watch').textContent = '★ Gemerkt';
    const f = new FormData($('#d-own .own-form'));
    const num = (k) => (f.get(k) === '' ? null : Number(f.get(k)));
    c.own = { qty: num('qty') ?? 0, buy_price: num('buy_price'), alert_below: num('alert_below'), alert_above: num('alert_above'), foil: f.get('foil') === 'on' ? 1 : 0 };
    renderChart();
  });
  $('#d-tiles').innerHTML = [
    tile('Preis-Trend <span class="info" title="Typischer Verkaufspreis laut Cardmarket (geglätteter Durchschnitt der letzten Verkäufe). Gleicher Wert wie „Preis-Trend“ auf der Cardmarket-Kartenseite.">ⓘ</span>', eur(c['trend' + f]), g?.change7v30, '7T-Ø vs. 30T-Ø'),
    tile('Günstigstes Angebot <span class="info" title="Billigstes Angebot auf Cardmarket, egal welcher Zustand und welche Sprache.">ⓘ</span>', eur(c['low' + f])),
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
    ? [{ key: 'trend_foil', name: 'Preis-Trend Foil', color: 'var(--series-1)' }]
    : [{ key: 'trend', name: 'Preis-Trend', color: 'var(--series-1)' }, { key: 'low', name: 'Günstigstes', color: 'var(--series-2)' }];
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
  const buy = c.own?.qty > 0 && c.own?.buy_price != null && Boolean(c.own.foil) === state.foil ? c.own.buy_price : null;
  const vals = hist.flatMap((h) => usable.map((s) => h[s.key])).filter((v) => v != null);
  if (buy != null) vals.push(buy);
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
    ${buy != null ? `<line class="buy-line" x1="${m.l}" x2="${W - m.r}" y1="${y(buy)}" y2="${y(buy)}"/><text class="buy-label" x="${m.l + 6}" y="${y(buy) - 5}">Dein Einkaufspreis ${eur(buy)}</text>` : ''}
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
try { state.view.movers = localStorage.getItem('kh-view-movers') || 'list'; } catch { state.view.movers = 'list'; }
document.querySelectorAll('.view-toggle[data-for="movers"] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.view.movers)));
loadSets().catch(() => {});
let startTab = 'home';
try { startTab = localStorage.getItem('kh-tab') || 'home'; } catch {}
showTab(startTab);
