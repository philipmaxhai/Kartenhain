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
  `);
  return db;
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
