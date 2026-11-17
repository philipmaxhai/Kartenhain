// Kartenhain Preistracker – Oberfläche (ohne Frameworks)
import { sparkline, histogramSvg, histogramTable, areaChart } from './charts.js';

// ---------------------------------------------------------------- Helfer
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pos = (v) => (typeof v === 'number' && v > 0 ? v : null);
const eur = (v) => (v == null || Number.isNaN(v) ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }));
const signedEur = (v) => (v == null ? '–' : `${v > 0.004 ? '+' : v < -0.004 ? '−' : ''}${eur(Math.abs(v))}`);
const pct = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '–'
  : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`);
const dir = (v) => (v == null || Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'down');
const arrow = (v) => ({ up: '▲', down: '▼', flat: '●' })[dir(v)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n0 = (v) => Number(v ?? 0).toLocaleString('de-DE');
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
const fmtShort = (d) => new Date(d + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
// Cardmarket schreibt die Zeitzone ohne Doppelpunkt (+0100); so versteht es jeder Browser
const toDate = (iso) => new Date(String(iso ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
const fmtWhen = (iso) => {
  const d = toDate(iso);
  return Number.isNaN(d.getTime()) ? '?' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
};
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString();

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body;
  try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const state = {
  status: null,
  fee: 5,
  band: null,
  card: null, foil: false, range: 90, scry: null,
  view: { movers: 'list' },
  lists: {},
  mvDir: 'up',
  tab: 'home',
};

/** Echter Verkaufswert (Ø Preis der Verkäufe der letzten 7 Tage) und was nach der Gebühr übrig bleibt. */
const sale = (c, foil = false) => (foil ? c?.sale_value_foil : c?.sale_value) ?? null;
const net = (v) => (v == null ? null : v * (1 - state.fee / 100));
const feeText = () => `${state.fee.toLocaleString('de-DE')} %`;
/** Genau diese Version auf Cardmarket (Cardmarket leitet idProduct auf die richtige Seite weiter). */
const cmUrl = (id, foil, extra = {}) => `https://www.cardmarket.com/de/Magic/Products?${qs({ idProduct: id, isFoil: foil ? 'Y' : 'N', ...extra })}`;

// Tooltip, den alle Diagramme teilen
const tooltip = {
  show(ev, html) {
    const tip = $('#tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - 14;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  },
  hide() { $('#tooltip').hidden = true; },
};

function loading(el, on = true) { el?.classList.toggle('is-loading', on); }
function failed(el, e) {
  loading(el, false);
  el.innerHTML = `<div class="empty">Konnte nicht geladen werden: ${esc(e.message)}<br><button class="btn-ghost" onclick="location.reload()">Neu laden</button></div>`;
}

// ---------------------------------------------------------------- Hell / Dunkel
const ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
function applyTheme(t) {
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else document.documentElement.removeAttribute('data-theme');
  const b = $('#theme-toggle');
  b.innerHTML = t === 'light' ? ICON_MOON : ICON_SUN;
  b.title = t === 'light' ? 'Dunkles Design' : 'Helles Design';
  b.setAttribute('aria-label', b.title);
}
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  store.set('kh-theme', next);
});

// ---------------------------------------------------------------- Preisbereich
const BANDS = [
  { key: 'all', label: 'Alle', min: 0.1, max: null },
  { key: 'b1', label: 'bis 1 €', min: 0.1, max: 1 },
  { key: 'b5', label: '1–5 €', min: 1, max: 5 },
  { key: 'b20', label: '5–20 €', min: 5, max: 20 },
  { key: 'b100', label: '20–100 €', min: 20, max: 100 },
  { key: 'top', label: 'ab 100 €', min: 100, max: null },
];
// Unter 0,10 € ist fast nur Massenware; bei sehr kleinem eigenen Höchstpreis trotzdem ab 0,02 € (kleinster Cardmarket-Preis)
const customBand = (max) => ({ key: `max:${max}`, label: `bis ${eur(max)}`, min: max <= 0.15 ? 0.02 : 0.1, max, custom: true });
function loadBand() {
  const key = store.get('kh-band', 'all');
  if (key.startsWith('max:') && Number(key.slice(4)) > 0) return customBand(Number(key.slice(4)));
  return BANDS.find((b) => b.key === key) ?? BANDS[0];
}
const bandParams = () => ({ minPrice: state.band.min, maxPrice: state.band.max });
function bandText(b = state.band) {
  if (b.max && b.min <= 0.1) return `bis ${eur(b.max)}`;
  if (b.max) return `${eur(b.min)} bis ${eur(b.max)}`;
  return b.min <= 0.1 ? 'alle Preise ab 0,10 €' : `ab ${eur(b.min)}`;
}
function renderBand() {
  $('#band-chips').innerHTML = BANDS.map((b) => `<button type="button" data-band="${b.key}" aria-pressed="${b.key === state.band.key}"
    title="${b.key === 'all' ? 'Alle Karten ab 0,10 € (darunter ist fast nur Massenware)' : `Karten mit Verkaufswert ${esc(bandText(b))}`}">${b.label}</button>`).join('');
  $('#band-custom').classList.toggle('on', Boolean(state.band.custom));
  if (state.band.custom) $('#band-max').value = String(state.band.max).replace('.', ',');
  else if (document.activeElement !== $('#band-max')) $('#band-max').value = '';
}
function setBand(b) {
  state.band = b;
  store.set('kh-band', b.key);
  renderBand();
  reloadTab();
}
$('#band-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-band]');
  if (btn) setBand(BANDS.find((b) => b.key === btn.dataset.band));
});
function applyCustomBand() {
  const raw = $('#band-max').value.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!raw) { if (state.band.custom) setBand(BANDS[0]); return; }
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) setBand(customBand(Math.round(v * 100) / 100));
  else renderBand();
}
$('#band-max').addEventListener('change', applyCustomBand);
$('#band-max').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustomBand(); } });

// ---------------------------------------------------------------- Status
async function loadStatus() {
  let s;
  try {
    s = state.status = await api('/api/status');
  } catch {
    $('#status').innerHTML = '<span class="err">Der Preistracker antwortet nicht. Läuft das schwarze Fenster noch?</span>';
    return;
  }
  state.fee = Number(s.feePercent ?? 5);
  $('#demo-banner').hidden = !s.demo;
  $('#update-banner').hidden = !s.update?.available;
  $('#foot-version').textContent = s.version
    ? `Version vom ${s.version.date ? new Date(s.version.date).toLocaleDateString('de-DE') : '?'} (${s.version.sha})`
    : 'Version: von Hand installiert';

  const el = $('#status');
  const created = s.priceGuideCreatedAt || s.lastUpdate;
  const old = created && Date.now() - toDate(created).getTime() > 36 * 3600 * 1000;
  if (!s.products) {
    el.innerHTML = s.updating ? 'Lade die Cardmarket-Preise … (1 bis 2 Minuten)' : 'Noch keine Preise. <button class="mini-btn" id="upd">Jetzt laden</button>';
  } else {
    el.innerHTML = `<b>${n0(s.products)}</b> Karten · Preise vom <b>${created ? fmtWhen(created) : '?'}</b>${old ? ' <span class="err">(älter als 1 Tag)</span>' : ''}`
      + `<br>${n0(s.historyDays)} ${s.historyDays === 1 ? 'Tag' : 'Tage'} eigener Verlauf`
      + (s.updating ? ' · lade neue Preise …' : s.demo ? '' : ' <button class="mini-btn" id="upd" title="Neue Preise von Cardmarket holen">↻ Aktualisieren</button>');
  }
  if (s.lastError && !s.updating) {
    el.innerHTML = `<span class="err">Laden der Cardmarket-Preise hat nicht geklappt: ${esc(s.lastError)}</span> <button class="mini-btn" id="upd">Nochmal</button>`;
  }
  $('#upd')?.addEventListener('click', runUpdate);

  if (s.updating) {
    state.wasUpdating = true;
    setTimeout(loadStatus, 4000);
  } else if (state.wasUpdating || (state.seenCreated && created !== state.seenCreated)) {
    // neue Preise da: Editionen und aktuelle Ansicht neu laden
    state.wasUpdating = false;
    loadSets().catch(() => {});
    reloadTab();
  }
  state.seenCreated = created;
}

async function runUpdate() {
  $('#status').textContent = 'Lade die Cardmarket-Preise … (1 bis 2 Minuten)';
  try {
    await api('/api/update', { method: 'POST' });
  } catch (e) {
    $('#status').textContent = `Aktualisieren hat nicht geklappt: ${e.message}`;
  }
  state.wasUpdating = true;
  loadStatus();
}

// ---------------------------------------------------------------- Reiter
const BAND_TABS = ['home', 'movers', 'deals'];
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(tab) {
  if (!$(`#tab-${tab}`)) tab = 'home';
  state.tab = tab;
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  $('#bandbar').hidden = !BAND_TABS.includes(tab);
  store.set('kh-tab', tab);
  reloadTab();
  if (tab === 'search') setTimeout(() => $('#q').focus(), 50);
}
function reloadTab() {
  if (state.tab === 'home') loadHome();
  if (state.tab === 'movers') loadMovers();
  if (state.tab === 'deals') loadDeals();
  if (state.tab === 'watch') loadWatchlist();
}

// Liste/Kacheln umschalten
$$('.view-toggle').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  state.view[seg.dataset.for] = b.dataset.v;
  store.set(`kh-view-${seg.dataset.for}`, b.dataset.v);
  if (seg.dataset.for === 'movers') renderMovers();
}));

/** Editionslisten für die Filter einmal laden. */
async function loadSets() {
  const sets = await api('/api/sets');
  const opts = sets.map((s) => `<option value="${s.id}">${esc(s.name)}${s.code ? ` (${esc(s.code)})` : ''}${s.release_date ? ` · ${s.release_date.slice(0, 4)}` : ''}</option>`).join('');
  $$('.set-select').forEach((sel) => {
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
  const csv = '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- Bausteine
/** Kartenbild über den eigenen Server (der fragt Scryfall nur einmal pro Karte). */
function thumb(id, cls = 'thumb', size = 'small') {
  if (state.status?.demo) return `<div class="${cls} ph"></div>`;
  return `<img class="${cls}" loading="lazy" decoding="async" src="/img/${id}${size === 'normal' ? '?v=normal' : ''}" alt=""
    onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls} ph'}))">`;
}

function setLabel(c) {
  if (c.set_name) return `${esc(c.set_name)}${c.set_code ? ` (${esc(c.set_code)})` : ''}${c.release_date ? ` · ${c.release_date.slice(0, 4)}` : ''}`;
  return c.expansion_id ? `Edition #${c.expansion_id}` : 'Edition unbekannt';
}

const starBtn = (c, cls = '') => `<button class="star ${cls} ${c.watched ? 'on' : ''}" data-star="${c.id}"
  aria-label="${c.watched ? 'Nicht mehr merken' : 'Merken'}" title="${c.watched ? 'Gemerkt (nochmal klicken zum Entfernen)' : 'Merken'}">${c.watched ? '★' : '☆'}</button>`;
const openAttrs = (id) => `data-open="${id}" tabindex="0" role="button"`;
const listHead = (cols, cls = '') => `<div class="list-head ${cls}" aria-hidden="true"><span></span><span>${cols[0]}</span><span>${cols[1] ?? ''}</span><span>${cols[2]}</span><span>${cols[3]}</span><span></span></div>`;

// Ein Klick auf eine Karte öffnet sie, ein Klick auf ☆ merkt sie (für alle Listen gemeinsam)
document.addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    toggleWatch(Number(star.dataset.star), !star.classList.contains('on'));
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open && !e.target.closest('a, input, select, label, form, .more')) openCard(Number(open.dataset.open));
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-open]')) {
    e.preventDefault();
    openCard(Number(e.target.dataset.open));
  }
});

async function toggleWatch(id, on) {
  try {
    await api(`/api/watchlist/${id}`, { method: on ? 'POST' : 'DELETE' });
  } catch (e) {
    return alert(`Merken hat nicht geklappt: ${e.message}`);
  }
  $$(`[data-star="${id}"]`).forEach((s) => {
    s.classList.toggle('on', on);
    s.textContent = on ? '★' : '☆';
    s.setAttribute('aria-label', on ? 'Nicht mehr merken' : 'Merken');
  });
  for (const list of Object.values(state.lists)) {
    for (const c of list?.rows ?? (Array.isArray(list) ? list : [])) if (c.id === id) c.watched = on;
  }
  if (state.card?.id === id) { state.card.watched = on; renderWatchButton(); }
  if (state.tab === 'watch' && !on) loadWatchlist();
}

// ---------------------------------------------------------------- Übersicht
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
  state.mvDir = b.dataset.dir;
  $('#mv-dir').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === state.mvDir)));
  showTab(b.dataset.goto);
}));

async function loadHome() {
  const tab = $('#tab-home');
  loading(tab);
  let d;
  try {
    d = await api(`/api/dashboard?${qs(bandParams())}`);
  } catch (e) {
    loading(tab, false);
    return failed($('#home-mood'), e);
  }
  loading(tab, false);
  const p = d.portfolio;
  updateAlertBadge(p.alerts);

  $('#home-alerts').innerHTML = p.alerts.length ? `<div class="alert-box"><span aria-hidden="true">🔔</span><div><b>Preisalarm:</b> ${p.alerts.map((a) =>
    `<button class="link" data-open="${a.id}">${esc(a.name)}</button> ${a.alert === 'below' ? `ist auf ${eur(a.price)} gefallen (Alarm unter ${eur(a.alert_below)})` : `ist auf ${eur(a.price)} gestiegen (Alarm über ${eur(a.alert_above)})`}`).join(' · ')}</div></div>` : '';

  $('#home-band-note').textContent = `· ${bandText()}`;
  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const top = d.gainers.rows[0];
  $('#home-kpis').innerHTML = [
    kpi('Karten gestiegen', `<span class="up">▲ ${n0(d.up)}</span>`, `von ${n0(d.cards)} Karten mit Verkäufen`, 'up'),
    kpi('Karten gefallen', `<span class="down">▼ ${n0(d.down)}</span>`, `${n0(d.flat)} etwa gleich geblieben`, 'down'),
    top ? kpi('Größter Anstieg', `<span class="up">▲ ${pct(top.change)}</span>`, esc(top.name)) : kpi('Größter Anstieg', '–', 'keine Karte in diesem Preisbereich'),
    p.owned
      ? kpi('Wert meiner Karten', eur(p.value), p.profit != null ? `<span class="${dir(p.profit)}">${signedEur(p.profit)} ${p.profit >= 0 ? 'Gewinn' : 'Verlust'}</span>` : `${n0(p.copies)} Karten · nach Gebühr ≈ ${eur(net(p.value))}`)
      : kpi('Meine Karten', n0(p.watched), 'gemerkt · Menge eintragen für den Gesamtwert'),
  ].join('');

  const total = d.up + d.down + d.flat || 1;
  const share = (n) => Math.round((n / total) * 100);
  $('#home-mood').innerHTML = d.cards ? `
    <div class="mood-big ${dir(d.medianChange)}">${moodWord(d)}</div>
    <div class="mood-sub">Typische Karte: <b class="${dir(d.medianChange)}">${arrow(d.medianChange)} ${pct(d.medianChange)}</b> (Ø 7 Tage gegen Ø 30 Tage)</div>
    <div class="mood-bar" role="img" aria-label="${d.up} gestiegen, ${d.flat} gleich, ${d.down} gefallen">
      <span class="seg-down" style="flex:${d.down}"></span><span class="seg-flat" style="flex:${d.flat}"></span><span class="seg-up" style="flex:${d.up}"></span>
    </div>
    <div class="mood-legend">
      <span><i class="dot down"></i>▼ Gefallen <b>${share(d.down)} %</b></span>
      <span><i class="dot flat"></i>Gleich <b>${share(d.flat)} %</b></span>
      <span><i class="dot up"></i>▲ Gestiegen <b>${share(d.up)} %</b></span>
    </div>
    <p class="hint">„Gleich“ heißt weniger als ±2 % Veränderung. Als gestiegen zählt eine Karte nur, wenn auch der Preis-Trend mitzieht.</p>`
    : `<div class="empty small">${state.status?.products ? `Keine Karten mit Verkäufen im Bereich ${esc(bandText())}.` : 'Noch keine Preise geladen.'}</div>`;
  state.dash = d;
  $('#home-hist').innerHTML = d.cards
    ? `<div id="hist-svg"></div><details class="table-view"><summary>Als Tabelle anzeigen</summary><div>${histogramTable(d.histogram)}</div></details>`
    : '';
  drawHistogram();

  const mini = (c) => `<div class="mini" ${openAttrs(c.id)}>
      ${thumb(c.id)}
      <div class="mini-body">
        <div class="mini-name">${esc(c.name)}</div>
        <div class="mini-set">${setLabel(c)}</div>
        <div class="mini-row"><b title="Verkaufswert">${eur(sale(c))}</b><span class="chg ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}</span></div>
        ${sparkline(c.spark, { w: 140, h: 26 })}
      </div></div>`;
  const empty = `<div class="empty small">Keine Karte im Bereich ${esc(bandText())}.</div>`;
  $('#home-up').innerHTML = d.gainers.rows.map(mini).join('') || empty;
  $('#home-down').innerHTML = d.losers.rows.map(mini).join('') || empty;
  $('#home-top-note').textContent = `· ${bandText()}`;
  $('#home-top').innerHTML = d.mostValuable.map((c) => `<div class="ctile" ${openAttrs(c.id)}>
      <div class="ctile-img">${thumb(c.id, 'ctile-pic', 'normal')}${starBtn(c, 'ctile-star')}</div>
      <div class="ctile-body">
        <div class="name">${esc(c.name)}</div>
        <div class="sub">${setLabel(c)}</div>
        <div class="ctile-value"><small>Verkaufswert</small>${eur(sale(c))}</div>
      </div></div>`).join('') || empty;
}

function drawHistogram() {
  const el = $('#hist-svg');
  if (!el || !state.dash?.cards) return;
  const w = el.clientWidth || 600;
  el.innerHTML = histogramSvg(state.dash.histogram, { w, h: w < 420 ? 180 : 220 });
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

// ---------------------------------------------------------------- Suche
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  const box = $('#search-results');
  if (q.length < 2) return;
  loading(box);
  let groups;
  try {
    groups = await api(`/api/search?${qs({ q })}`);
  } catch (err) {
    return failed(box, err);
  }
  loading(box, false);
  state.lists.search = groups.flatMap((g) => g.versions);
  box.innerHTML = groups.length ? groups.map(groupHtml).join('') : `<div class="empty">Nichts gefunden für „${esc(q)}“. Tipp: englischen Kartennamen verwenden, z. B. „Lightning Bolt“.</div>`;
  box.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', () => {
    const list = b.previousElementSibling;
    list.classList.toggle('collapsed');
    b.textContent = list.classList.contains('collapsed') ? b.dataset.more : 'Weniger anzeigen';
  }));
});

/** Eine Karte mit all ihren Versionen: günstigste und teuerste im Verhältnis. */
function groupHtml(g) {
  const priced = g.versions.filter((v) => v.price_value != null);
  const cheap = priced[0];
  const dear = priced[priced.length - 1];
  const median = priced.length ? priced[Math.floor((priced.length - 1) / 2)].price_value : null;
  const factor = cheap && dear ? dear.price_value / cheap.price_value : null;
  const pick = (label, v, cls) => `<div class="pick ${cls}" ${openAttrs(v.id)}>
      ${thumb(v.id)}
      <div><div class="pick-label">${label}</div>
      <div class="pick-price">${eur(v.price_value)} ${v.foil_only ? '<span class="pill foil">nur Foil</span>' : ''}</div>
      <div class="pick-set">${setLabel(v)}</div></div></div>`;
  const many = g.versions.length > 1;
  return `<div class="group">
    <div class="group-head">
      <h3>${esc(g.name)}</h3>
      <span class="muted small">${g.count} ${g.count === 1 ? 'Version' : 'Versionen'}${many && median != null ? ` · typischer Verkaufswert ${eur(median)}` : ''}</span>
    </div>
    ${many && cheap && dear && cheap !== dear ? `
      <div class="picks">
        ${pick('Günstigste Version', cheap, 'cheap')}
        <div class="ratio" title="So viel teurer ist die teuerste Version">
          <div class="ratio-num">${factor >= 1.05 ? `${factor.toLocaleString('de-DE', { maximumFractionDigits: factor < 10 ? 1 : 0 })}×` : '≈'}</div>
          <div class="ratio-txt">so teuer wie <br>die günstigste</div>
        </div>
        ${pick('Teuerste Version', dear, 'dear')}
      </div>
      ${spreadHtml(priced, cheap.price_value, dear.price_value)}` : ''}
    ${listHead(['Version', '', 'Verkaufswert', 'Ø 7 T vs. 30 T'])}
    <div class="list versions ${g.versions.length > 4 ? 'collapsed' : ''}">
      ${g.versions.map(versionRow).join('')}
    </div>
    ${g.versions.length > 4 ? `<button class="btn-ghost more" data-more="Alle ${g.count} Versionen anzeigen">Alle ${g.count} Versionen anzeigen</button>` : ''}
  </div>`;
}

function versionRow(v) {
  const foil = v.foil_only;
  const chg = (foil ? null : v.guideTrend?.change7v30) ?? null;
  const val = v.price_value;
  const trend = foil ? v.trend_foil : v.trend;
  const low = foil ? v.low_foil : v.low;
  return `<div class="row" ${openAttrs(v.id)}>
    ${thumb(v.id)}
    <div class="r-main">
      <div class="name">${setLabel(v)} ${foil ? '<span class="pill foil">nur Foil</span>' : ''}</div>
      <div class="sub">Preis-Trend ${eur(trend)} · günstigstes Angebot ${eur(low)}</div>
    </div>
    <div class="r-price"><b>${eur(val)}</b><small>${val != null ? `≈ ${eur(net(val))} nach Gebühr` : 'keine Verkäufe'}</small></div>
    <div class="r-chg ${dir(chg)}">${chg != null ? `${arrow(chg)} ${pct(chg)}` : '<span class="muted">–</span>'}</div>
    ${starBtn(v)}
  </div>`;
}

/** Punktleiste (logarithmisch): wo liegen die Versionen zwischen günstig und teuer? */
function spreadHtml(priced, lo, hi) {
  if (!(lo > 0) || hi / lo < 1.05) return '';
  const at = (v) => (Math.log(v / lo) / Math.log(hi / lo)) * 100;
  return `<div class="spread" aria-hidden="true">
    <div class="spread-line"></div>
    ${priced.map((v) => `<span class="spread-dot" style="left:${at(v.price_value).toFixed(1)}%" title="${esc(v.set_name || 'Version')}: ${eur(v.price_value)}"></span>`).join('')}
  </div>
  <div class="spread-axis"><span>${eur(lo)}</span><span>Verkaufswert aller Versionen</span><span>${eur(hi)}</span></div>`;
}

// ---------------------------------------------------------------- Trends
$('#mv-dir').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.mvDir = b.dataset.v;
  $('#mv-dir').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadMovers();
});
['#mv-days', '#mv-sort', '#mv-foil', '#mv-set'].forEach((s) => $(s).addEventListener('change', loadMovers));
let mvTimer;
$('#mv-q').addEventListener('input', () => { clearTimeout(mvTimer); mvTimer = setTimeout(loadMovers, 350); });

let mvSeq = 0;
async function loadMovers() {
  const box = $('#movers');
  const seq = ++mvSeq;
  loading(box);
  const days = Number($('#mv-days').value);
  const foil = $('#mv-foil').checked;
  let r;
  try {
    r = await api(`/api/movers?${qs({
      direction: state.mvDir, days, sort: $('#mv-sort').value, foil: foil ? '1' : '0',
      set: $('#mv-set').value, q: $('#mv-q').value.trim(), ...bandParams(),
    })}`);
  } catch (e) {
    return failed(box, e);
  }
  if (seq !== mvSeq) return; // inzwischen anderer Filter gewählt
  loading(box, false);
  r.foil = foil;
  state.lists.movers = r;
  const word = state.mvDir === 'up' ? 'gestiegen' : 'gefallen';
  const what = `${foil ? 'Foil-Karten' : 'Karten'} ${bandText()}`;
  $('#mv-source').innerHTML = r.source === 'history'
    ? `<b>Top ${r.rows.length}</b>: ${what}, deren Preis-Trend vom ${fmtDay(r.from)} bis ${fmtDay(r.to)} am stärksten ${word} ist.`
    : `<b>Top ${r.rows.length}</b>: ${what}, deren Ø Verkaufspreis der letzten 7 Tage am stärksten gegenüber den letzten 30 Tagen ${word} ist (echte Verkäufe auf Cardmarket).`
      + (r.reason === 'floor'
        ? ' Der eigene Verlauf für günstige Karten läuft noch nicht lange genug, darum hier dieser Vergleich.'
        : days > 7 ? ` Für ${days} Tage braucht der Tracker erst ${days} Tage eigenen Verlauf (bisher ${n0(state.status?.historyDays)}).` : '');
  renderMovers();
}

function renderMovers() {
  const r = state.lists.movers;
  const box = $('#movers');
  if (!r) return;
  const labels = r.source === 'history' ? [fmtShort(r.from), fmtShort(r.to)] : ['Ø 30 Tage', 'Ø 7 Tage'];
  const tiles = state.view.movers === 'tiles';
  box.className = tiles ? 'tile-grid' : 'list';
  if (!r.rows.length) {
    box.className = 'list';
    box.innerHTML = `<div class="empty">${state.status?.products ? `Keine Karten für diese Filter im Bereich ${esc(bandText())}.` : 'Noch keine Preise geladen.'}</div>`;
    return;
  }
  box.innerHTML = tiles
    ? r.rows.map((c, i) => moverTile(c, i + 1, r.foil)).join('')
    : listHead(['Karte', 'Verlauf', 'Verkaufswert', 'Veränderung']) + r.rows.map((c, i) => moverRow(c, i + 1, labels, r.foil)).join('');
}

function moverRow(c, rank, [fromLabel, toLabel], foil) {
  const v = sale(c, foil) ?? c.now_price;
  return `<div class="row" ${openAttrs(c.id)}>
    ${thumb(c.id)}
    <div class="r-main">
      <div class="name"><span class="rank">${rank}.</span> ${esc(c.name)} ${foil ? '<span class="pill foil">Foil</span>' : ''}</div>
      <div class="sub">${setLabel(c)}</div>
      <div class="sub2">${fromLabel} <b>${eur(c.then_price)}</b> → ${toLabel} <b>${eur(c.now_price)}</b></div>
    </div>
    <div class="r-spark">${sparkline(c.spark)}</div>
    <div class="r-price"><b>${eur(v)}</b><small>≈ ${eur(net(v))} nach Gebühr</small></div>
    <div class="r-chg big ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}<small>${signedEur(c.now_price - c.then_price)}</small></div>
    ${starBtn(c)}
  </div>`;
}

/** Kachel mit großem Kartenbild. */
function moverTile(c, rank, foil) {
  const v = sale(c, foil) ?? c.now_price;
  return `<div class="ctile" ${openAttrs(c.id)}>
    <div class="ctile-img">${thumb(c.id, 'ctile-pic', 'normal')}
      <span class="ctile-rank">${rank}</span>
      <span class="ctile-badge ${dir(c.change)}">${arrow(c.change)} ${pct(c.change)}</span>
      ${starBtn(c, 'ctile-star')}
    </div>
    <div class="ctile-body">
      <div class="name">${esc(c.name)}</div>
      <div class="sub">${setLabel(c)}</div>
      <div class="ctile-prices"><span>${eur(c.then_price)} → <b>${eur(c.now_price)}</b></span>${sparkline(c.spark, { w: 150, h: 22 })}</div>
      <div class="ctile-value"><small>Verkaufswert</small>${eur(v)}</div>
    </div>
  </div>`;
}

$('#mv-csv').addEventListener('click', () => {
  const r = state.lists.movers;
  if (!r?.rows.length) return;
  const f = r.foil;
  downloadCsv(`kartenhain-trends-${state.mvDir === 'up' ? 'gestiegen' : 'gefallen'}${f ? '-foil' : ''}.csv`,
    ['Rang', 'Karte', 'Edition', 'Vorher (€)', 'Jetzt (€)', 'Veränderung (%)', 'Veränderung (€)', 'Verkaufswert Ø 7 Tage (€)',
      `Nach ${feeText()} Gebühr (€)`, 'Preis-Trend (€)', 'Günstigstes Angebot (€)', 'Cardmarket'],
    r.rows.map((c, i) => [i + 1, c.name, c.set_name ?? '', c.then_price, c.now_price, c.change * 100, c.now_price - c.then_price,
      sale(c, f), net(sale(c, f)), f ? c.trend_foil : c.trend, f ? c.low_foil : c.low, cmUrl(c.id, f)]));
});

// ---------------------------------------------------------------- Schnäppchen
['#dl-ratio', '#dl-sort', '#dl-set'].forEach((s) => $(s).addEventListener('change', loadDeals));

let dlSeq = 0;
async function loadDeals() {
  const box = $('#deals');
  const seq = ++dlSeq;
  loading(box);
  let rows;
  try {
    rows = await api(`/api/deals?${qs({ maxRatio: $('#dl-ratio').value, sort: $('#dl-sort').value, set: $('#dl-set').value, ...bandParams() })}`);
  } catch (e) {
    return failed(box, e);
  }
  if (seq !== dlSeq) return;
  loading(box, false);
  state.lists.deals = rows;
  box.innerHTML = rows.length
    ? listHead(['Karte', '', 'Verkaufswert', 'Ersparnis'], 'deal') + rows.map(dealRow).join('')
    : `<div class="empty">Keine Schnäppchen im Bereich ${esc(bandText())} für diese Filter.</div>`;
}

function dealRow(c) {
  const share = Math.max(2, Math.min(100, (c.low / c.sale_value) * 100));
  const profit = net(c.sale_value) - c.low;
  return `<div class="row deal" ${openAttrs(c.id)}>
    ${thumb(c.id)}
    <div class="r-main"><div class="name">${esc(c.name)}</div><div class="sub">${setLabel(c)}</div>
      <div class="deal-bar" title="Günstigstes Angebot im Verhältnis zum echten Verkaufswert">
        <span class="deal-fill" style="width:${share.toFixed(1)}%"></span>
        <span class="deal-lbl">ab <b>${eur(c.low)}</b></span><span class="deal-lbl right">Verkaufswert <b>${eur(c.sale_value)}</b></span>
      </div></div>
    <div class="r-price"><b>${eur(c.sale_value)}</b><small>Preis-Trend ${eur(c.trend)}</small></div>
    <div class="deal-save"><span class="big up">−${Math.round(c.discount * 100)} %</span>
      <small class="${profit > 0 ? '' : 'down'}">${profit > 0 ? `≈ ${signedEur(profit)} nach Gebühr` : 'lohnt kaum nach Gebühr'}</small></div>
    ${starBtn(c)}
  </div>`;
}

$('#dl-csv').addEventListener('click', () => {
  const rows = state.lists.deals;
  if (!rows?.length) return;
  downloadCsv('kartenhain-schnaeppchen.csv',
    ['Karte', 'Edition', 'Günstigstes Angebot (€)', 'Verkaufswert Ø 7 Tage (€)', 'Ersparnis (€)', 'Ersparnis (%)',
      `Gewinn nach ${feeText()} Gebühr (€)`, 'Preis-Trend (€)', 'Cardmarket'],
    rows.map((c) => [c.name, c.set_name ?? '', c.low, c.sale_value, c.spread, c.discount * 100, net(c.sale_value) - c.low, c.trend, cmUrl(c.id, false)]));
});

// ---------------------------------------------------------------- Meine Karten
async function loadWatchlist() {
  const box = $('#watchlist');
  loading(box);
  let rows, pf;
  try {
    [rows, pf] = await Promise.all([api('/api/watchlist'), api('/api/portfolio')]);
  } catch (e) {
    return failed(box, e);
  }
  loading(box, false);
  state.lists.watch = rows;
  renderPortfolio(pf);
  box.innerHTML = rows.length ? rows.map(ownHtml).join('') : '<div class="empty">Noch keine Karten gemerkt. Tippe bei einer Karte auf ☆.</div>';
  box.querySelectorAll('.own-form').forEach((form) => bindOwnForm(form, (o) => updateOwnSum(form.closest('.own'), o)));
}

function renderPortfolio(pf) {
  state.pf = pf;
  updateAlertBadge(pf.alerts);
  const kpi = (label, value, sub = '', cls = '') => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  // Gewinn zählt nur Karten mit Einkaufspreis: deren Wert = Gewinn + Einkaufswert
  const netProfit = pf.cost != null && pf.profit != null ? net(pf.profit + pf.cost) - pf.cost : null;
  $('#pf-kpis').innerHTML = [
    kpi('Gesamtwert', eur(pf.value), `${n0(pf.copies)} Karten · nach Gebühr ≈ ${eur(net(pf.value))}`),
    kpi('Einkaufswert', pf.cost != null ? eur(pf.cost) : '–', 'nur Karten mit Einkaufspreis'),
    kpi('Gewinn / Verlust', pf.profit != null ? `<span class="${dir(pf.profit)}">${signedEur(pf.profit)}</span>` : '–',
      pf.cost ? `<span class="${dir(pf.profit)}">${pct(pf.profit / pf.cost)}</span> · nach Gebühr ${signedEur(netProfit)}` : 'Einkaufspreis eintragen', pf.profit == null ? '' : pf.profit >= 0 ? 'up' : 'down'),
    kpi('Preisalarme', pf.alerts.length ? `🔔 ${pf.alerts.length}` : '0', pf.alerts.length ? 'ausgelöst' : 'nichts ausgelöst'),
  ].join('');
  areaChart($('#pf-chart'), pf.history, { label: 'Wert meiner Karten', tooltip });
}

function ownHtml(c) {
  const chg = c.historyChange.d7 ?? (c.foil ? c.guideTrendFoil?.change7v30 : c.guideTrend?.change7v30) ?? null;
  return `<div class="own ${c.alert ? 'alerted' : ''}" data-id="${c.id}">
    <div class="row" ${openAttrs(c.id)}>
      ${thumb(c.id)}
      <div class="r-main"><div class="name">${esc(c.name)} ${c.foil ? '<span class="pill foil">Foil</span>' : ''}</div><div class="sub">${setLabel(c)}</div>
        ${c.alert ? `<div class="alert-line">🔔 ${c.alert === 'below' ? `unter ${eur(c.alert_below)} gefallen` : `über ${eur(c.alert_above)} gestiegen`}</div>` : ''}</div>
      <div class="r-spark">${sparkline(c.spark)}</div>
      <div class="r-price"><b>${eur(c.value_each)}</b><small>Verkaufswert pro Stück</small></div>
      <div class="r-chg ${dir(chg)}">${chg != null ? `${arrow(chg)} ${pct(chg)}` : '–'}<small>${c.historyChange.d7 != null ? '7 Tage' : 'Ø 7 T vs. 30 T'}</small></div>
      ${starBtn(c)}
    </div>
    ${ownFormHtml(c.id, { ...c, foil: c.foil })}
    <div class="own-sum">${ownSumHtml(c.value_each, c)}</div>
  </div>`;
}

function ownSumHtml(each, o) {
  const qty = Number(o.qty) || 0;
  if (!qty || each == null) return '';
  const value = each * qty;
  const parts = [`Wert: <b>${eur(value)}</b>`, `nach Gebühr ≈ <b>${eur(net(value))}</b>`];
  if (o.buy_price != null && o.buy_price !== '') {
    const profit = value - Number(o.buy_price) * qty;
    parts.push(`<span class="${dir(profit)}">${profit >= 0 ? 'Gewinn' : 'Verlust'}: <b>${signedEur(profit)}</b></span>`);
  }
  return parts.map((x) => `<span>${x}</span>`).join('');
}

/** Nach dem Speichern: Summe der Karte und die Kennzahlen oben neu rechnen (ohne die Eingabe zu stören). */
async function updateOwnSum(card, o) {
  const c = state.lists.watch?.find((x) => x.id === Number(card?.dataset.id));
  if (c && card) {
    const foilChanged = Boolean(o.foil) !== Boolean(c.foil);
    if (foilChanged) return loadWatchlist();
    card.querySelector('.own-sum').innerHTML = ownSumHtml(c.value_each, o);
  }
  try { renderPortfolio(await api('/api/portfolio')); } catch { /* egal, beim nächsten Laden */ }
}

function ownFormHtml(id, o = {}) {
  const v = (x) => (x == null ? '' : String(x));
  return `<form class="own-form" data-id="${id}">
    <label>Menge<input type="number" name="qty" min="0" step="1" inputmode="numeric" value="${v(o.qty || '')}" placeholder="0"></label>
    <label>Einkaufspreis pro Stück<input type="number" name="buy_price" min="0" step="0.01" inputmode="decimal" value="${v(o.buy_price)}" placeholder="€"></label>
    <label>Alarm, wenn unter<input type="number" name="alert_below" min="0" step="0.01" inputmode="decimal" value="${v(o.alert_below)}" placeholder="€"></label>
    <label>Alarm, wenn über<input type="number" name="alert_above" min="0" step="0.01" inputmode="decimal" value="${v(o.alert_above)}" placeholder="€"></label>
    <label class="check"><input type="checkbox" name="foil" ${o.foil ? 'checked' : ''}> ist Foil</label>
    <span class="saved" hidden>✓ gespeichert</span>
  </form>`;
}

function bindOwnForm(form, onSaved) {
  let t;
  const save = async () => {
    const f = new FormData(form);
    const data = { qty: f.get('qty'), buy_price: f.get('buy_price'), alert_below: f.get('alert_below'), alert_above: f.get('alert_above'), foil: f.get('foil') === 'on' };
    try {
      await api(`/api/watchlist/${form.dataset.id}`, { method: 'PUT', body: JSON.stringify(data) });
    } catch (e) {
      return alert(`Speichern hat nicht geklappt: ${e.message}`);
    }
    const ok = form.querySelector('.saved');
    ok.hidden = false;
    clearTimeout(ok.timer);
    ok.timer = setTimeout(() => { ok.hidden = true; }, 1600);
    onSaved?.(data);
  };
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(save, 700); });
  form.addEventListener('change', () => { clearTimeout(t); save(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(t); save(); });
}

// ---------------------------------------------------------------- Detail
$('#d-close').addEventListener('click', closeCard);
$('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeCard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#detail').hidden) closeCard(); });
function closeCard() {
  $('#detail').hidden = true;
  document.body.style.overflow = '';
  tooltip.hide();
  state.lastFocus?.focus?.();
}

segment('#d-foil', (v) => { state.foil = v === '1'; renderCard(); loadOffers(); });
segment('#d-range', (v) => { state.range = Number(v); renderChart(); });
['#o-cond', '#o-lang'].forEach((s) => $(s).addEventListener('change', loadOffers));

function segment(sel, onChange) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    $(sel).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onChange(b.dataset.v);
  });
}
function pressSeg(sel, v) { $(sel).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === String(v)))); }

const hasFoil = (c) => [c.trend_foil, c.low_foil, c.avg7_foil, c.avg30_foil].some((v) => pos(v));
const hasNormal = (c) => [c.trend, c.low, c.avg7, c.avg30].some((v) => pos(v));

async function openCard(id) {
  let c;
  try {
    c = await api(`/api/card/${id}`);
  } catch (e) {
    return alert(`Karte konnte nicht geladen werden: ${e.message}`);
  }
  state.lastFocus = document.activeElement;
  state.card = c;
  state.scry = null;
  // Reine Foil-Karten gleich als Foil zeigen, eigene Foil-Karten auch
  state.foil = !hasNormal(c) && hasFoil(c) ? true : Boolean(c.own?.foil && hasFoil(c));
  pressSeg('#d-foil', state.foil ? '1' : '0');
  $('#d-foil').querySelector('[data-v="0"]').disabled = !hasNormal(c);
  $('#d-foil').querySelector('[data-v="1"]').disabled = !hasFoil(c);
  $('#detail').hidden = false;
  $('#detail').scrollTop = 0;
  document.body.style.overflow = 'hidden';

  const img = $('#d-img');
  img.hidden = true;
  img.removeAttribute('src');
  $('#d-art-ph').textContent = c.name;
  $('#d-art-ph').hidden = false;
  if (!state.status?.demo) {
    img.onload = () => { img.hidden = false; $('#d-art-ph').hidden = true; };
    img.onerror = () => { img.hidden = true; $('#d-art-ph').hidden = false; };
    img.src = `/img/${id}?v=normal`;
  }
  renderCard();
  loadOffers();
  loadScryfall(id);
  $('#d-close').focus();
}

async function loadScryfall(id) {
  try {
    const s = await api(`/api/card/${id}/scryfall`);
    if (state.card?.id !== id) return;
    state.scry = s.found ? s : null;
    renderSetLine();
    renderCrossCheck();
  } catch { /* ohne Scryfall weiter */ }
}

const RARITY = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', mythic: 'Mythic Rare', special: 'Special', bonus: 'Bonus' };
function renderSetLine() {
  const c = state.card, s = state.scry;
  $('#d-set').innerHTML = s
    ? `<span>${esc(s.set_name)} (${esc(s.set_code)})</span><span class="muted">#${esc(s.number)}${s.rarity ? ` · ${esc(RARITY[s.rarity] ?? s.rarity)}` : ''}</span>${s.frame ? `<span class="pill">${esc(s.frame)}</span>` : ''}`
    : `<span>${setLabel(c)}</span>`;
}

function renderWatchButton() {
  const c = state.card;
  const w = $('#d-watch');
  w.textContent = c.watched ? '★ Gemerkt' : '☆ Merken';
  w.classList.toggle('on', Boolean(c.watched));
  w.onclick = () => toggleWatch(c.id, !c.watched);
}

function renderCard() {
  const c = state.card;
  if (!c) return;
  const foil = state.foil;
  const f = foil ? '_foil' : '';
  $('#d-name').textContent = c.name;
  $('#d-art').classList.toggle('foil', foil);
  renderSetLine();
  renderWatchButton();
  $('#d-cm').href = cmUrl(c.id, foil);
  $('#d-cm').textContent = `Genau diese Version${foil ? ' (Foil)' : ''} auf Cardmarket ↗`;

  // Großer Verkaufswert
  const v = sale(c, foil);
  const g = foil ? c.guideTrendFoil : c.guideTrend;
  const avg7 = pos(c['avg7' + f]);
  const trend = pos(c['trend' + f]);
  const source = avg7 ? 'Ø Preis der echten Verkäufe der letzten 7 Tage'
    : trend ? 'Preis-Trend (in den letzten 7 Tagen keine Verkäufe)'
      : v ? 'Ø der letzten 30 Tage (zuletzt keine Verkäufe)' : 'keine Verkäufe bekannt';
  const swing = avg7 && trend ? Math.abs(avg7 - trend) / trend : 0;
  $('#d-sale').innerHTML = `
    <div class="eyebrow">Echter Verkaufswert${foil ? ' · Foil' : ''} <i class="info" title="${esc(source)}. So viel haben Käufer zuletzt im Schnitt wirklich bezahlt. Auf Cardmarket heißt das „7-Tages-Durchschnitt“.">i</i></div>
    <div class="sale-main">
      <span class="sale-value">${eur(v)}</span>
      ${g?.change7v30 != null ? `<span class="sale-chg ${dir(g.change7v30)}">${arrow(g.change7v30)} ${pct(g.change7v30)} <small>gegenüber Ø 30 Tage</small></span>` : ''}
    </div>
    <div class="sale-net">${v ? `Nach ca. ${feeText()} Cardmarket-Gebühr bleiben dir <b>≈ ${eur(net(v))}</b> pro Stück (ohne Versand).` : esc(source)}</div>
    ${swing > 0.3 ? `<div class="sale-warn">⚠ Ø 7 Tage und Preis-Trend liegen ${Math.round(swing * 100)} % auseinander (wenige oder sehr unterschiedliche Verkäufe). Vor dem Verkaufen die Angebote ansehen.</div>` : ''}`;

  // Die Zahlen in derselben Reihenfolge und mit denselben Namen wie auf der Cardmarket-Seite
  const row = (label, hint, value, extra = '', cls = '') => `<div class="cm-row ${cls}"><dt>${label}${hint ? `<small>${hint}</small>` : ''}</dt><dd>${value}${extra}</dd></div>`;
  const delta = (d, txt) => (d != null ? `<small class="${dir(d)}">${arrow(d)} ${pct(d)} <span class="muted">${txt}</span></small>` : '');
  $('#d-cm-note').textContent = foil ? 'Foil' : 'normal (nicht Foil)';
  $('#d-tiles').innerHTML = [
    row('ab', 'günstigstes Angebot gerade', eur(pos(c['low' + f]))),
    row('Preis-Trend', 'von Cardmarket berechneter Richtwert', eur(trend)),
    row('30-Tages-Durchschnittspreis', '', eur(pos(c['avg30' + f]))),
    row('7-Tages-Durchschnittspreis', '= echter Verkaufswert in diesem Tool', eur(avg7), delta(g?.change7v30, 'vs. 30 Tage'), 'key'),
    row('1-Tages-Durchschnittspreis', '', eur(pos(c['avg1' + f])), delta(g?.change1v7, 'vs. 7 Tage')),
  ].join('');

  renderCrossCheck();

  $('#d-own').innerHTML = `<div class="card-head"><h3>Meine Karten</h3><span class="muted small">${c.watched ? 'Wird automatisch gespeichert' : 'Eintragen merkt die Karte automatisch'}</span></div>`
    + ownFormHtml(c.id, c.own ?? {});
  bindOwnForm($('#d-own .own-form'), (o) => {
    c.watched = true;
    renderWatchButton();
    const num = (x) => (x === '' || x == null ? null : Number(x));
    c.own = { qty: num(o.qty) ?? 0, buy_price: num(o.buy_price), alert_below: num(o.alert_below), alert_above: num(o.alert_above), foil: o.foil ? 1 : 0 };
    $$(`[data-star="${c.id}"]`).forEach((s) => { s.classList.add('on'); s.textContent = '★'; });
    renderChart();
  });
  renderChart();
}

function renderCrossCheck() {
  const c = state.card, s = state.scry;
  if (!c) return;
  const foil = state.foil;
  const created = state.status?.priceGuideCreatedAt;
  const lines = [
    `<span>Preise aus der Cardmarket-Preisliste vom <b>${created ? fmtWhen(created) : '?'}</b>.</span>`,
    `<span>Die „Werte wie auf Cardmarket“ stehen genauso auf der Cardmarket-Seite dieser Version (goldener Knopf oben). Achte dort auf dieselbe Edition und auf ${foil ? '<b>Foil</b>' : '<b>nicht Foil</b>'}.
      Cardmarket rechnet im Lauf des Tages neu, kleine Abweichungen sind normal.</span>`,
  ];
  const hc = foil ? null : c.historyChange;
  if (hc?.d30 != null) lines.push(`<span>Eigener Verlauf: Preis-Trend in 30 Tagen <b class="${dir(hc.d30)}">${arrow(hc.d30)} ${pct(hc.d30)}</b>.</span>`);
  const theirs = s ? (foil ? s.eur_foil : s.eur) : null;
  const ours = pos(foil ? c.trend_foil : c.trend);
  if (theirs && ours) {
    const diff = Math.abs(theirs - ours) / ours;
    lines.push(diff <= 0.1
      ? `<span><span class="ok">✓ Gegenprobe bestanden:</span> Scryfall (bekommt die Preise auch von Cardmarket) meldet für diese Version ${eur(theirs)} als Preis-Trend.</span>`
      : `<span><span class="warn">⚠ Gegenprobe:</span> Scryfall meldet ${eur(theirs)} als Preis-Trend, hier steht ${eur(ours)} (${Math.round(diff * 100)} % Unterschied). Der Preis hat sich seit der Preisliste wohl bewegt. Im Zweifel auf Cardmarket nachsehen.</span>`);
  }
  $('#d-check').innerHTML = lines.join('');
}

// ---------------------------------------------------------------- Graph (SVG)
function chartSeries(foil) {
  // Farbe gehört zur Reihe, nicht zur Position: Preis-Trend ist immer Farbe 3
  return foil
    ? [{ key: 'avg7_foil', name: 'Verkaufswert Foil', color: 'var(--s1)' }, { key: 'trend_foil', name: 'Preis-Trend Foil', color: 'var(--s3)' }]
    : [{ key: 'avg7', name: 'Verkaufswert', color: 'var(--s1)' }, { key: 'low', name: 'Günstigstes', color: 'var(--s2)' }, { key: 'trend', name: 'Preis-Trend', color: 'var(--s3)' }];
}

function renderChart() {
  const c = state.card;
  const box = $('#d-chart');
  let hist = c.history;
  if (state.range && hist.length) {
    const d = new Date(hist[hist.length - 1].day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - state.range);
    const cut = d.toISOString().slice(0, 10);
    hist = hist.filter((h) => h.day >= cut);
  }
  const usable = chartSeries(state.foil).filter((s) => hist.some((h) => pos(h[s.key])));

  $('#d-legend').innerHTML = usable.length > 1 ? usable.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('') : '';
  $('#d-table').innerHTML = `<table><thead><tr><th>Tag</th>${usable.map((s) => `<th class="num">${s.name}</th>`).join('')}</tr></thead><tbody>`
    + hist.slice().reverse().map((h) => `<tr><td>${fmtDay(h.day)}</td>${usable.map((s) => `<td class="num">${eur(pos(h[s.key]))}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';

  if (hist.length < 2 || !usable.length) {
    box.innerHTML = `<div class="empty">${hist.length ? 'Erst ein Tag Verlauf gespeichert.' : 'Noch kein Verlauf gespeichert.'}
      Der Preis wird ab jetzt jeden Tag aufgezeichnet${c.watched ? '' : ' (Tipp: Karte merken, dann auf jeden Fall)'}.
      Bis dahin zeigen die Zahlen oben, wohin der Preis geht.</div>`;
    return;
  }

  const W = Math.max(box.clientWidth || 600, 280), H = W < 500 ? 230 : 270;
  const m = { l: 56, r: usable.length > 1 ? 104 : 16, t: 14, b: 28 };
  if (W < 420) m.r = 16; // auf dem Handy keine Namen am Linienende, die Legende reicht
  const t0 = Date.parse(hist[0].day), t1 = Date.parse(hist[hist.length - 1].day);
  const buy = c.own?.qty > 0 && c.own?.buy_price != null && Boolean(c.own.foil) === state.foil ? c.own.buy_price : null;
  const vals = hist.flatMap((h) => usable.map((s) => pos(h[s.key]))).filter((v) => v != null);
  if (buy != null) vals.push(buy);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || hi * 0.1 || 1;
  lo = Math.max(0, lo - pad); hi += pad;
  const ticks = niceTicks(lo, hi, 5);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (day) => m.l + ((Date.parse(day) - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

  const xt = [];
  const n = Math.min(W < 500 ? 4 : 6, hist.length);
  for (let i = 0; i < n; i++) xt.push(hist[Math.round((i * (hist.length - 1)) / (n - 1 || 1))]);

  const paths = usable.map((s) => {
    let d = '', pen = false;
    for (const h of hist) {
      const v = pos(h[s.key]);
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(h.day).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    const lastPt = [...hist].reverse().find((h) => pos(h[s.key]));
    return { s, d, lastPt, ly: lastPt ? y(lastPt[s.key]) : 0 };
  });
  // Namen am Linienende: nicht übereinander schreiben
  const labeled = paths.filter((p) => p.lastPt).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labeled.length; i++) labeled[i].ly = Math.max(labeled[i].ly, labeled[i - 1].ly + 14);

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Preisverlauf ${esc(c.name)}">
    <g class="axis">
      ${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${eur(t)}</text>`).join('')}
      ${xt.map((h, i) => `<text x="${x(h.day)}" y="${H - 7}" text-anchor="${i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}">${fmtShort(h.day)}</text>`).join('')}
    </g>
    ${buy != null ? `<line class="buy-line" x1="${m.l}" x2="${W - m.r}" y1="${y(buy)}" y2="${y(buy)}"/><text class="buy-label" x="${m.l + 6}" y="${y(buy) - 6}">Dein Einkaufspreis ${eur(buy)}</text>` : ''}
    ${paths.map((p) => `<path class="line" d="${p.d}" stroke="${p.s.color}"/>`).join('')}
    ${usable.length > 1 && m.r > 16 ? labeled.map((p) => `<text class="end-label" x="${x(p.lastPt.day) + 8}" y="${p.ly + 4}">${p.s.name}</text>`).join('') : ''}
    <line class="hover-line" id="hv-line" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    ${usable.map((s, i) => `<circle id="hv-dot-${i}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`).join('')}
    <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="hv-hit"/>
  </svg>`;

  const svg = box.querySelector('svg');
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
      const v = pos(best[s.key]);
      if (v == null) return dot.setAttribute('visibility', 'hidden');
      dot.setAttribute('cx', x(best.day)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible');
    });
    tooltip.show(ev, `<div class="t-day">${fmtDay(best.day)}</div>` + usable.map((s) => `<div><i style="background:${s.color}"></i>${s.name}: <b>${eur(pos(best[s.key]))}</b></div>`).join(''));
  };
  const leave = () => {
    tooltip.hide();
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

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!$('#detail').hidden) renderChart();
    // nur den Graphen neu zeichnen (die Liste nicht: sonst verliert ein Eingabefeld den Fokus)
    if (state.tab === 'watch' && state.pf) areaChart($('#pf-chart'), state.pf.history, { label: 'Wert meiner Karten', tooltip });
    if (state.tab === 'home') drawHistogram();
  }, 200);
});

// Foil-Karte zum Anfassen: leicht kippen und schimmern, wenn die Maus darüberfährt
const art = $('#d-art');
if (matchMedia('(hover: hover) and (pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  art.addEventListener('pointermove', (e) => {
    const r = art.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    art.style.setProperty('--ry', `${(px - 0.5) * 14}deg`);
    art.style.setProperty('--rx', `${(0.5 - py) * 14}deg`);
    art.style.setProperty('--sx', `${px * 100}%`);
    art.style.setProperty('--sy', `${py * 100}%`);
    art.classList.add('tilting');
  });
  art.addEventListener('pointerleave', () => {
    ['--rx', '--ry', '--sx', '--sy'].forEach((p) => art.style.removeProperty(p));
    art.classList.remove('tilting');
  });
}

// ---------------------------------------------------------------- Angebote
const COND_ID = { MT: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };
let offerSeq = 0;
async function loadOffers() {
  const c = state.card;
  const box = $('#d-offers');
  const seq = ++offerSeq;
  loading(box);
  const cond = $('#o-cond').value, lang = $('#o-lang').value;
  const link = cmUrl(c.id, state.foil, { language: lang, minCondition: COND_ID[cond] });
  try {
    const r = await api(`/api/card/${c.id}/offers?${qs({ foil: state.foil ? '1' : '0', minCondition: cond, language: lang })}`);
    if (seq !== offerSeq || state.card?.id !== c.id) return;
    loading(box, false);
    if (r.source === 'none') {
      box.innerHTML = `<p class="hint">${esc(r.message)}</p>
        <p>Günstigstes Angebot laut Cardmarket-Preisliste: <b>${eur(pos(state.foil ? c.low_foil : c.low))}</b> ·
        <a href="${esc(link)}" target="_blank" rel="noopener">Angebote dieser Version auf Cardmarket ansehen ↗</a></p>`;
      return;
    }
    if (!r.offers.length) {
      box.innerHTML = `<div class="empty small">Keine Angebote für diese Filter. <a href="${esc(link)}" target="_blank" rel="noopener">Auf Cardmarket ansehen ↗</a></div>`;
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="offers"><thead><tr><th>#</th><th class="num">Preis</th><th>Land</th><th>Zustand</th><th>Sprache</th><th>Verkäufer</th></tr></thead><tbody>
      ${r.offers.map((o, i) => `<tr><td>${i + 1}</td><td class="num"><b>${eur(o.price)}</b></td>
        <td class="o-land"><span class="flag">${o.country.flag}</span>${esc(o.country.name)}</td>
        <td>${esc(o.condition ?? '')}</td><td>${esc(o.language ?? '')}</td><td class="o-seller">${esc(o.seller ?? '')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="offers-more">${r.source === 'demo' ? '<span class="muted">Demo-Angebote, erfunden.</span> ' : ''}<a href="${esc(link)}" target="_blank" rel="noopener">Alle Angebote dieser Version auf Cardmarket ↗</a></p>`;
  } catch (e) {
    if (seq !== offerSeq) return;
    loading(box, false);
    box.innerHTML = `<p class="hint">Angebote konnten nicht geladen werden: ${esc(e.message)} · <a href="${esc(link)}" target="_blank" rel="noopener">Auf Cardmarket ansehen ↗</a></p>`;
  }
}

// ---------------------------------------------------------------- Start
applyTheme(store.get('kh-theme', 'dark'));
state.band = loadBand();
renderBand();
state.view.movers = store.get('kh-view-movers', 'list');
$$('.view-toggle[data-for="movers"] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === state.view.movers)));
await loadStatus();
loadSets().catch(() => {});
showTab(store.get('kh-tab', 'home'));
// Alle 10 Minuten nachsehen, ob der Server neue Preise geholt hat
setInterval(() => { if (!state.status?.updating) loadStatus(); }, 10 * 60 * 1000);
