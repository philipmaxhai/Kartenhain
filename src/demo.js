// Demo-Daten: erzeugt erfundene Preise für echte Kartennamen, damit man die Oberfläche
// ohne Internetzugang ausprobieren kann. Die Zahlen sind NICHT echt.
import { tx, setMeta } from './db.js';
import { shiftDay } from './trends.js';

const CARDS = [
  ['Ragavan, Nimble Pilferer', 45], ['The One Ring', 60], ['Sheoldred, the Apocalypse', 70],
  ['Orcish Bowmasters', 35], ['Lightning Bolt', 1.5], ['Counterspell', 1.2], ['Sol Ring', 2.5],
  ['Force of Will', 80], ['Thoughtseize', 14], ['Fable of the Mirror-Breaker', 18],
  ['Wrenn and Six', 40], ['Cavern of Souls', 38], ['Mana Crypt', 180], ['Dockside Extortionist', 55],
  ['Jeweled Lotus', 75], ['Smothering Tithe', 22], ['Rhystic Study', 30], ['Cyclonic Rift', 25],
  ['Doubling Season', 45], ['Esper Sentinel', 9], ['Fury', 28], ['Solitude', 26],
  ['Urza\'s Saga', 32], ['Mox Opal', 70], ['Ancient Tomb', 48], ['Fatal Push', 3],
  ['Snapcaster Mage', 9], ['Tarmogoyf', 5], ['Liliana of the Veil', 24], ['Grief', 15],
];
const SETS = [[101, 'Demo-Edition Grundset', 'DGS', '2024-06-01', 1], [102, 'Demo-Edition Neuauflage', 'DNA', '2025-02-01', 0.6],
  [103, 'Demo-Edition Sonderversion', 'DSV', '2023-09-01', 3.5], [104, 'Demo-Edition Erstauflage', 'DEA', '1994-01-01', 12]];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function seedDemo(db, { days = 120, endDay = new Date().toISOString().slice(0, 10) } = {}) {
  const rand = rng(42);
  const insProduct = db.prepare('INSERT OR REPLACE INTO products (id, name, expansion_id, category) VALUES (?, ?, ?, ?)');
  const insHist = db.prepare('INSERT OR REPLACE INTO history (id, day, trend, low, avg1, trend_foil) VALUES (?, ?, ?, ?, ?, ?)');
  const insPrice = db.prepare(`INSERT OR REPLACE INTO prices (id, avg, low, trend, avg1, avg7, avg30,
    avg_foil, low_foil, trend_foil, avg1_foil, avg7_foil, avg30_foil, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const r2 = (v) => Math.round(v * 100) / 100;
  let id = 900000;

  const insSet = db.prepare('INSERT OR REPLACE INTO expansions (id, name, code, release_date) VALUES (?, ?, ?, ?)');
  tx(db, () => {
    for (const [sid, sname, scode, sdate] of SETS) insSet.run(sid, sname, scode, sdate);
    for (const [name, base] of CARDS) {
      const printings = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < printings; k++) {
        id++;
        insProduct.run(id, name, SETS[k][0], 'Magic Single (Demo)');
        // Zufallsweg mit Drift, damit es Gewinner und Verlierer gibt
        const drift = (rand() - 0.5) * 0.012;
        let price = base * (0.7 + rand() * 0.8) * SETS[k][4];
        const series = [];
        for (let d = days - 1; d >= 0; d--) {
          price = Math.max(0.1, price * (1 + drift + (rand() - 0.5) * 0.05));
          series.push({ day: shiftDay(endDay, -d), trend: r2(price) });
        }
        for (const s of series) {
          insHist.run(id, s.day, s.trend, r2(s.trend * (0.8 + rand() * 0.1)), r2(s.trend * (0.95 + rand() * 0.1)), r2(s.trend * 2.2));
        }
        const avg = (n) => r2(series.slice(-n).reduce((a, s) => a + s.trend, 0) / n);
        const last = series[series.length - 1].trend;
        insPrice.run(id, avg(3), r2(last * 0.82), last, avg(1), avg(7), avg(30),
          r2(last * 2.3), r2(last * 1.9), r2(last * 2.2), r2(avg(1) * 2.2), r2(avg(7) * 2.2), r2(avg(30) * 2.2),
          new Date().toISOString());
      }
    }
  });
  setMeta(db, 'demo', '1');
  setMeta(db, 'lastUpdate', new Date().toISOString());
  return id - 900000;
}

const DEMO_COUNTRIES = ['DE', 'FR', 'IT', 'ES', 'AT', 'NL', 'BE', 'PL', 'PT', 'CZ', 'GB', 'SE'];
const CONDS = ['NM', 'NM', 'EX', 'GD', 'LP'];
const LANGS = ['Englisch', 'Deutsch', 'Französisch', 'Italienisch', 'Spanisch'];

/** Erfundene Angebote im selben Format wie die echten Cardmarket-Artikel. */
export function demoArticles(idProduct, low, { foil = false } = {}) {
  const rand = rng(Number(idProduct) * 7 + (foil ? 1 : 0));
  const base = low || 1;
  return Array.from({ length: 30 }, (_, i) => ({
    price: Math.round(base * (1 + rand() * 0.6) * (foil ? 2 : 1) * 100) / 100,
    condition: CONDS[Math.floor(rand() * CONDS.length)],
    language: { languageName: LANGS[Math.floor(rand() * LANGS.length)] },
    isFoil: foil,
    count: 1 + Math.floor(rand() * 3),
    seller: { username: `demo_haendler_${i + 1}`, address: { country: DEMO_COUNTRIES[Math.floor(rand() * DEMO_COUNTRIES.length)] } },
  }));
}
