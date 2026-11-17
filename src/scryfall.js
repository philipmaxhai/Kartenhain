// Kartenbilder und Kartendetails von Scryfall, gefunden über die Cardmarket-ID.
//
// Scryfall erlaubt nur etwa 10 Anfragen pro Sekunde. Würde der Browser jedes Bild direkt über
// die Scryfall-API laden, wären es bei einer Kachelansicht schnell 40 Anfragen auf einmal.
// Das kann zu einer Sperre führen. Darum fragt der Server jede Karte nur einmal an,
// nacheinander mit kleinem Abstand, und speichert das Ergebnis in der Datenbank.
// Die Bilder selbst liegen auf cards.scryfall.io und haben kein Limit.

const API = 'https://api.scryfall.com/cards/cardmarket/';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Holt nur die Felder, die die Oberfläche braucht, aus einer Scryfall-Karte. */
export function pickCard(c) {
  // Doppelseitige Karten haben die Bilder pro Seite
  const face = c?.image_uris ? c : (c?.card_faces ?? []).find((f) => f.image_uris) ?? null;
  const frame = [
    c?.border_color === 'borderless' && 'randlos',
    ...(c?.frame_effects ?? []).map((e) => ({ showcase: 'Showcase', extendedart: 'Extended Art', etched: 'Etched', inverted: 'Inverted' })[e]).filter(Boolean),
    c?.full_art && 'Full Art',
    c?.textless && 'ohne Text',
    c?.promo && 'Promo',
    c?.lang && c.lang !== 'en' && c.lang.toUpperCase(),
  ].filter(Boolean);
  return {
    small: face?.image_uris?.small ?? null,
    normal: face?.image_uris?.normal ?? null,
    set_name: c?.set_name ?? null,
    set_code: c?.set ? String(c.set).toUpperCase() : null,
    number: c?.collector_number ?? null,
    rarity: c?.rarity ?? null,
    eur: num(c?.prices?.eur),
    eur_foil: num(c?.prices?.eur_foil),
    cm_url: c?.purchase_uris?.cardmarket ?? null,
    frame: frame.join(', ') || null,
  };
}

export function createScryfall(db, { fetchImpl = (...a) => fetch(...a), gapMs = 120, now = () => Date.now() } = {}) {
  const get = db.prepare('SELECT * FROM scryfall WHERE id = ?');
  const put = db.prepare(`INSERT OR REPLACE INTO scryfall
    (id, fetched, status, small, normal, set_name, set_code, number, rarity, eur, eur_foil, cm_url, frame)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const pending = new Map(); // id -> laufende Anfrage (gleiche Karte nicht doppelt anfragen)
  const retryAt = new Map(); // id -> Zeitpunkt, ab dem nach einem Fehler neu gefragt wird
  let queue = Promise.resolve();
  let last = 0;
  let calls = 0;

  // Eine Anfrage nach der anderen, mit Abstand
  function schedule(fn) {
    const run = queue.then(async () => {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      calls++;
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  }

  function save(id, status, card) {
    const p = pickCard(card);
    const fetched = new Date(now()).toISOString();
    put.run(id, fetched, status, p.small, p.normal, p.set_name, p.set_code, p.number, p.rarity, p.eur, p.eur_foil, p.cm_url, p.frame);
    return { id, fetched, status, ...p };
  }

  async function load(id, old) {
    let res;
    try {
      res = await fetchImpl(API + id, {
        headers: { 'User-Agent': 'Kartenhain-Preistracker/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      res = null;
    }
    if (res?.ok) return save(id, 200, await res.json());
    if (res?.status === 404) {
      // Scryfall kennt die Karte (nicht mehr): alte Daten behalten, aber erst morgen wieder fragen
      if (old?.status === 200) { retryAt.set(id, now() + DAY); return old; }
      return save(id, 404, null);
    }
    // Keine Verbindung, Limit erreicht oder Störung: alte Daten behalten, später neu versuchen
    retryAt.set(id, now() + (res?.status === 429 ? 60 * 1000 : 10 * 60 * 1000));
    if (res?.status === 429) last = now() + 1000; // kurz Pause für alle
    return old ?? { id, status: res?.status ?? 0 };
  }

  /**
   * Daten einer Karte. maxAgeMs: wie alt gespeicherte Daten höchstens sein dürfen
   * (Bilder ändern sich nie, Preise täglich).
   */
  async function info(id, { maxAgeMs = 30 * DAY } = {}) {
    id = Number(id);
    const row = get.get(id);
    const age = row ? now() - Date.parse(row.fetched) : Infinity;
    const limit = row?.status === 404 ? 7 * DAY : maxAgeMs; // unbekannte Karten nur selten neu fragen
    if (row && age < limit) return row;
    if ((retryAt.get(id) ?? 0) > now()) return row ?? { id, status: 0 };
    if (!pending.has(id)) {
      pending.set(id, schedule(() => load(id, row)).finally(() => pending.delete(id)));
    }
    return pending.get(id);
  }

  return { info, stats: () => ({ calls }) };
}

export const MAX_AGE = { image: 30 * DAY, prices: 12 * HOUR };
