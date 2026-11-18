// Kartenhain auf die neueste Version bringen, ohne git.
//
// Start.bat ruft vor jedem Start tools/update.js auf. Das fragt GitHub nach dem neuesten Stand
// von "main", lädt ihn als .tar.gz und kopiert die Dateien über die alten. Deine Daten bleiben:
// der Ordner data, die Datei .env und die Start-Dateien werden nie angefasst.
// Klappt etwas nicht (kein Internet, GitHub gestört …), bleibt alles, wie es war.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';

export const REPO = 'philipmaxhai/Kartenhain';
export const BRANCH = 'main';
const UA = 'Kartenhain-Updater';
// Diese Dateien und Ordner im Hauptordner bleiben immer, wie sie sind
export const KEEP = ['data', '.env', 'version.txt', 'Start.bat', 'Demo starten.bat', 'node_modules', '.git'];
// Ohne diese Dateien ist ein Download unvollständig
const REQUIRED = ['package.json', 'src/server.js', 'public/index.html', 'tools/start.cmd', 'tools/update.js'];
const TMP_SUFFIX = '.kh-neu';

/** Installierte Version aus version.txt (Zeile 1: Commit, Zeile 2: Datum) oder null (von Hand installiert). */
export function readInstalled(root) {
  try {
    const [sha = '', date = ''] = fs.readFileSync(path.join(root, 'version.txt'), 'utf8')
      .replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    return { sha: sha.toLowerCase(), date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date : null };
  } catch {
    return null;
  }
}

/** Gleicher Commit? (auch wenn einer der beiden gekürzt ist) */
export function sameCommit(a, b) {
  if (!a || !b) return false;
  const [x, y] = [String(a).toLowerCase(), String(b).toLowerCase()];
  return x.length >= y.length ? x.startsWith(y) : y.startsWith(x);
}

/** Neuester Stand auf GitHub: { sha, date }. Wirft bei Fehlern. */
export async function latestCommit({ fetchImpl = fetch, branch = BRANCH, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/branches/${encodeURIComponent(branch)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 || res.status === 429
      ? 'GitHub bekommt gerade zu viele Anfragen, später klappt es wieder'
      : `GitHub antwortet mit Fehler ${res.status}`);
  }
  const b = await res.json();
  const sha = b?.commit?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error('unerwartete Antwort von GitHub');
  const date = String(b.commit.commit?.committer?.date ?? b.commit.commit?.author?.date ?? '');
  return { sha: sha.toLowerCase(), date: /^\d{4}-\d{2}-\d{2}/.test(date) ? date : '' };
}

/**
 * Einträge eines tar-Archivs: [{ name, type, data }].
 * Versteht ustar mit Präfix, pax-Kopfzeilen (wie bei GitHub/git archive) und GNU-Langnamen.
 */
export function parseTar(buf) {
  const out = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // zwei leere Blöcke = Ende
    const str = (a, b) => {
      const s = h.subarray(a, b);
      const z = s.indexOf(0);
      return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
    };
    let unsigned = 0, signed = 0;
    for (let i = 0; i < 512; i++) {
      const v = i >= 148 && i < 156 ? 32 : h[i];
      unsigned += v;
      signed += v > 127 ? v - 256 : v;
    }
    const sum = parseInt(str(148, 156).trim(), 8);
    if (sum !== unsigned && sum !== signed) throw new Error('Archiv beschädigt');
    if (h[124] & 0x80) throw new Error('Archiv enthält zu große Dateien');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const start = off + 512;
    if (!Number.isFinite(size) || size < 0 || start + size > buf.length) throw new Error('Archiv unvollständig');
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;

    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = str(257, 262) === 'ustar' ? str(345, 500) : '';
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    if (type === 'x') { longName = paxRecords(data).path ?? longName; continue; }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'g') continue; // allgemeine Angaben (bei GitHub: Commit-Kennung)
    if (longName) { name = longName; longName = null; }
    out.push({ name, type, data });
  }
  return out;
}

/** pax-Einträge "länge schlüssel=wert\n" (Länge in Bytes, inklusive Länge und Zeilenumbruch). */
function paxRecords(buf) {
  const rec = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(i, sp).toString('ascii'), 10);
    if (!(len > 0) || i + len > buf.length) break;
    const kv = buf.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = kv.indexOf('=');
    if (eq > 0) rec[kv.slice(0, eq)] = kv.slice(eq + 1);
    i += len;
  }
  return rec;
}

/**
 * Prüft das Archiv und liefert die zu kopierenden Dateien (Pfade relativ zum Hauptordner).
 * Wirft, wenn etwas nicht stimmt. Dann wird gar nichts geschrieben.
 */
export function planUpdate(entries) {
  const files = [];
  let top = null;
  for (const e of entries) {
    const raw = e.name.replace(/\\/g, '/');
    const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
    if (!parts.length) continue;
    if (raw.startsWith('/') || /^[a-z]:/i.test(parts[0]) || parts.some((p) => p === '..' || /[<>:"|?*\x00-\x1f]/.test(p))) {
      throw new Error(`ungültiger Dateiname im Download: ${e.name}`);
    }
    top ??= parts[0];
    if (parts[0] !== top) throw new Error('Download hat einen unerwarteten Aufbau');
    const rel = parts.slice(1);
    if (!rel.length) continue; // der Hauptordner selbst
    if (e.type !== '0' && e.type !== '7') continue; // nur normale Dateien (Ordner entstehen von selbst, Verknüpfungen nie)
    if (KEEP.some((k) => k.toLowerCase() === rel[0].toLowerCase())) continue;
    files.push({ rel: rel.join('/'), data: e.data });
  }
  for (const r of REQUIRED) {
    if (!files.some((f) => f.rel === r)) throw new Error(`Download unvollständig (${r} fehlt)`);
  }
  return files;
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Ersetzen mit kleinen Wiederholungen (Virenscanner halten Dateien unter Windows manchmal kurz fest). */
function replaceFile(tmp, dest) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      if (i >= 6) throw e;
      try { fs.chmodSync(dest, 0o666); } catch { /* Datei gibt es noch nicht */ }
      pause(250);
    }
  }
}

/**
 * Schreibt die Dateien in zwei Schritten: erst alle neuen Dateien daneben (".kh-neu"),
 * dann umbenennen. Scheitert Schritt 1 (z. B. Platte voll), bleibt die alte Version komplett.
 * Gibt die Zahl der geänderten Dateien zurück.
 */
export function applyUpdate(root, files) {
  const base = path.resolve(root);
  const todo = [];
  try {
    for (const f of files) {
      const dest = path.resolve(base, ...f.rel.split('/'));
      if (!dest.startsWith(base + path.sep)) throw new Error(`ungültiger Pfad: ${f.rel}`);
      let same = false;
      try { same = fs.readFileSync(dest).equals(f.data); } catch { /* neue Datei */ }
      if (same) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      todo.push(dest);
      fs.writeFileSync(dest + TMP_SUFFIX, f.data);
    }
  } catch (e) {
    // Aufräumen, auch halb geschriebene Dateien; die alte Version bleibt unberührt
    for (const dest of todo) {
      try { fs.rmSync(dest + TMP_SUFFIX, { force: true }); } catch { /* egal */ }
    }
    throw e;
  }
  for (const dest of todo) replaceFile(dest + TMP_SUFFIX, dest);
  return todo.length;
}

/** Einstellungen aus der .env-Datei (das Update läuft vor dem Server und liest sie selbst). */
export function readEnvFile(root) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch { /* keine .env */ }
  return out;
}

const isOn = (v) => v != null && !['', '0', 'false', 'nein', 'no'].includes(String(v).trim().toLowerCase());

/** Port aus der Umgebung oder der .env-Datei (sonst 3000). */
export function configuredPort(root, env = process.env) {
  if (Number(env.PORT) > 0) return Number(env.PORT);
  const p = Number(readEnvFile(root).PORT);
  return p > 0 ? p : 3000;
}

/** Läuft auf dem Port schon etwas (also Kartenhain)? */
export function portInUse(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function friendly(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'GitHub antwortet nicht (Internet langsam oder weg?)';
  if (e?.message === 'fetch failed') return 'keine Verbindung zu GitHub (Internet weg?)';
  return e?.message || String(e);
}

/**
 * Der ganze Ablauf. Wirft nie, liefert { status } mit
 * off | git | running | current | updated | failed.
 */
export async function selfUpdate({
  root, env = process.env, fetchImpl = fetch, isRunning = portInUse, log = () => {}, branch = BRANCH,
} = {}) {
  try {
    if (isOn(env.KARTENHAIN_NO_UPDATE) || isOn(readEnvFile(root).KARTENHAIN_NO_UPDATE)) return { status: 'off' };
    if (fs.existsSync(path.join(root, '.git'))) {
      log('Git-Ordner gefunden: kein automatisches Update (bitte mit git aktualisieren).');
      return { status: 'git' };
    }
    if (await isRunning(configuredPort(root, env))) {
      log('Kartenhain läuft schon. Nach Updates wird beim nächsten Start gesucht.');
      return { status: 'running' };
    }
    log('Suche nach Updates …');
    const latest = await latestCommit({ fetchImpl, branch });
    const installed = readInstalled(root);
    if (installed && sameCommit(installed.sha, latest.sha)) {
      log('Kartenhain ist auf dem neuesten Stand.');
      return { status: 'current', sha: latest.sha };
    }
    log('Neue Version gefunden, wird geladen …');
    const res = await fetchImpl(`https://codeload.github.com/${REPO}/tar.gz/${latest.sha}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`Download fehlgeschlagen (Fehler ${res.status})`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // sonst schon entpackt geliefert
    const files = planUpdate(parseTar(buf));
    const changed = applyUpdate(root, files);
    // Erst wenn alles kopiert ist: neue Version merken
    fs.writeFileSync(path.join(root, 'version.txt'), `${latest.sha}\r\n${latest.date}\r\n`);
    log(changed ? `Update fertig: ${changed} ${changed === 1 ? 'Datei' : 'Dateien'} erneuert. Deine Daten sind unverändert.` : 'Kartenhain ist auf dem neuesten Stand.');
    return { status: 'updated', sha: latest.sha, changed };
  } catch (e) {
    const error = friendly(e);
    log(`Update gerade nicht möglich: ${error}`);
    log('Kein Problem: Kartenhain startet mit der bisherigen Version.');
    return { status: 'failed', error };
  }
}
