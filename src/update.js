// Einmaliges Update von der Kommandozeile: npm run update
// Praktisch für einen täglichen Cronjob/Aufgabenplanung, wenn der Server nicht dauerhaft läuft.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { downloadAndImport } from './cardmarket.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(process.env.DB_FILE ?? path.join(ROOT, 'data', 'kartenhain.sqlite'));
const r = await downloadAndImport(db, { historyMinTrend: Number(process.env.HISTORY_MIN_TREND ?? 0.5) });
console.log(`Fertig: ${r.products} Karten, ${r.prices} Preise, ${r.history} Verlaufspunkte für ${r.day}.`);
