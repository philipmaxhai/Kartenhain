// SQLite-Speicher (eingebautes node:sqlite, keine Zusatzpakete nötig).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,           -- Cardmarket idProduct
      name TEXT NOT NULL,
      expansion_id INTEGER,
      metacard_id INTEGER,
      category TEXT,
      date_added TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);

    -- Aktueller Stand des Cardmarket-Preisguides (eine Zeile pro Produkt)
    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY,
      avg REAL, low REAL, trend REAL, avg1 REAL, avg7 REAL, avg30 REAL,
      avg_foil REAL, low_foil REAL, trend_foil REAL,
      avg1_foil REAL, avg7_foil REAL, avg30_foil REAL,
      updated TEXT
    );

    -- Tägliche Momentaufnahmen für die Preisverlaufs-Graphen
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER NOT NULL,
      day TEXT NOT NULL,                -- YYYY-MM-DD
      trend REAL, low REAL, avg1 REAL, trend_foil REAL,
      PRIMARY KEY (id, day)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_history_day ON history(day);

    -- Pro Verlaufstag: ab welchem Preis an diesem Tag alle Karten gespeichert wurden
    CREATE TABLE IF NOT EXISTS history_days (
      day TEXT PRIMARY KEY,
      floor REAL NOT NULL
    );

    -- Editionsnamen (Cardmarket-Editions-ID -> Name), aus MTGJSON
    CREATE TABLE IF NOT EXISTS expansions (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      release_date TEXT
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY,
      added TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    -- Zwischenspeicher für Scryfall (Kartenbild, Sammlernummer, Gegenprobe des Preises)
    CREATE TABLE IF NOT EXISTS scryfall (
      id INTEGER PRIMARY KEY,           -- Cardmarket idProduct
      fetched TEXT NOT NULL,
      status INTEGER NOT NULL,          -- 200 gefunden, 404 unbekannt
      small TEXT, normal TEXT,
      set_name TEXT, set_code TEXT, number TEXT, rarity TEXT,
      eur REAL, eur_foil REAL, cm_url TEXT, frame TEXT
    );
  `);
  // Spalten, die in späteren Versionen dazugekommen sind (bestehende Datenbanken nachrüsten)
  addColumns(db, 'watchlist', {
    qty: 'INTEGER NOT NULL DEFAULT 0',
    buy_price: 'REAL',
    alert_below: 'REAL',
    alert_above: 'REAL',
    foil: 'INTEGER NOT NULL DEFAULT 0',
  });
  // Verkaufswert (Ø 7 Tage) im Verlauf, damit Graphen und "Meine Karten" denselben Wert zeigen
  addColumns(db, 'history', { avg7: 'REAL', avg7_foil: 'REAL' });
  // Cardmarket schreibt 0 für fehlende Werte (z. B. keine Foil-Version, keine Verkäufe).
  // Ältere Versionen haben diese Nullen übernommen: einmalig in "kein Wert" umwandeln.
  if (getMeta(db, 'zeroIsMissing') !== '1') {
    const cols = ['avg', 'low', 'trend', 'avg1', 'avg7', 'avg30', 'avg_foil', 'low_foil', 'trend_foil', 'avg1_foil', 'avg7_foil', 'avg30_foil'];
    db.exec(`UPDATE prices SET ${cols.map((c) => `${c} = NULLIF(${c}, 0)`).join(', ')}`);
    db.exec('UPDATE history SET trend = NULLIF(trend, 0), low = NULLIF(low, 0), avg1 = NULLIF(avg1, 0), trend_foil = NULLIF(trend_foil, 0)');
    setMeta(db, 'zeroIsMissing', '1');
  }
  return db;
}

function addColumns(db, table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
