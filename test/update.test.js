// Automatisches Update über Start.bat: Download prüfen, Dateien ersetzen, Daten behalten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import {
  parseTar, planUpdate, applyUpdate, selfUpdate, readInstalled, sameCommit, configuredPort, portInUse,
} from '../src/selfupdate.js';
import { createUpdateCheck } from '../src/server.js';

// ---------------------------------------------------------------- kleines tar-Werkzeug für die Tests
function header(name, size, type = '0', prefix = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
function entry(name, data = '', type = '0', prefix = '') {
  const body = Buffer.from(data);
  return Buffer.concat([header(name, body.length, type, prefix), body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
function pax(records) {
  return Object.entries(records).map(([k, v]) => {
    const rest = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(rest) + 1;
    while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
    return `${len}${rest}`;
  }).join('');
}
const tar = (parts) => Buffer.concat([...parts, Buffer.alloc(1024)]);

const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const TOP = `Kartenhain-${SHA}`;
function repoTar({ extra = [], without = [] } = {}) {
  const files = {
    'package.json': '{"name":"kartenhain"}',
    'src/server.js': 'NEU server',
    'public/index.html': '<html>NEU</html>',
    'tools/start.cmd': '@echo off\r\nNEU\r\n',
    'tools/update.js': '// NEU',
    'Start.bat': 'NEUE START.BAT',     // wird nie kopiert
    '.env': 'PORT=1',                  // wird nie kopiert
    'data/kartenhain.sqlite': 'NEIN',  // wird nie kopiert
  };
  return tar([
    entry('pax_global_header', pax({ comment: SHA }), 'g'), // wie bei GitHub
    entry(`${TOP}/`, '', '5'),
    ...Object.entries(files).filter(([k]) => !without.includes(k)).map(([k, v]) => entry(`${TOP}/${k}`, v)),
    ...extra,
  ]);
}

function fakeGitHub({ sha = SHA, archive = zlib.gzipSync(repoTar()), apiStatus = 200, archiveStatus = 200, fail = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(String(url));
    assert.ok(opts?.headers?.['User-Agent'], 'GitHub verlangt einen User-Agent');
    if (fail) throw fail;
    if (String(url).startsWith('https://api.github.com/repos/philipmaxhai/Kartenhain/branches/main')) {
      return new Response(JSON.stringify({ name: 'main', commit: { sha, commit: { committer: { date: '2026-11-18T09:00:00Z' } } } }), { status: apiStatus });
    }
    if (String(url) === `https://codeload.github.com/philipmaxhai/Kartenhain/tar.gz/${sha}`) {
      return new Response(archive, { status: archiveStatus });
    }
    throw new Error(`unerwartete Adresse ${url}`);
  };
  return { impl, calls };
}

function installDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-upd-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('src/server.js', 'ALT server');
  put('public/index.html', '<html>ALT</html>');
  put('public/nur-alt.js', 'bleibt liegen');
  put('data/kartenhain.sqlite', 'MEINE DATEN');
  put('.env', 'PORT=3999\n');
  put('Start.bat', 'MEINE START.BAT');
  return { root, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), has: (rel) => fs.existsSync(path.join(root, rel)) };
}
const notRunning = async () => false;

// ---------------------------------------------------------------- tar lesen
test('tar: ustar-Präfix, pax-Langnamen, GNU-Langnamen, globale Kopfzeile', () => {
  const long = `${TOP}/${'sehr-langer-ordnername/'.repeat(6)}datei.txt`;
  const entries = parseTar(tar([
    entry('pax_global_header', pax({ comment: SHA }), 'g'),
    entry('kurz.txt', 'eins'),
    entry('datei.txt', 'zwei', '0', 'ordner/mit/praefix'),
    entry('PaxHeader', pax({ path: long, mtime: '1' }), 'x'),
    entry('abgeschnitten', 'drei'),
    entry('././@LongLink', 'gnu/' + 'x'.repeat(120) + '\0', 'L'),
    entry('gnu-kurz', 'vier'),
  ]));
  assert.deepEqual(entries.map((e) => [e.name, e.data.toString()]), [
    ['kurz.txt', 'eins'],
    ['ordner/mit/praefix/datei.txt', 'zwei'],
    [long, 'drei'],
    ['gnu/' + 'x'.repeat(120), 'vier'],
  ]);
  const broken = tar([entry('a.txt', 'x')]);
  broken[0] = 'b'.charCodeAt(0); // Name geändert, Prüfsumme passt nicht mehr
  assert.throws(() => parseTar(broken), /beschädigt/);
  assert.throws(() => parseTar(tar([entry('a.txt', 'x'.repeat(600))]).subarray(0, 900)), /unvollständig/);
});

test('Plan: Daten und Startdateien bleiben, gefährliche Pfade werden abgelehnt', () => {
  const files = planUpdate(parseTar(repoTar()));
  assert.deepEqual(files.map((f) => f.rel).sort(), ['package.json', 'public/index.html', 'src/server.js', 'tools/start.cmd', 'tools/update.js']);
  assert.throws(() => planUpdate(parseTar(repoTar({ extra: [entry(`${TOP}/../boese.txt`, 'x')] }))), /ungültiger Dateiname/);
  assert.throws(() => planUpdate(parseTar(repoTar({ extra: [entry('/etc/boese', 'x')] }))), /ungültiger Dateiname/);
  assert.throws(() => planUpdate(parseTar(repoTar({ extra: [entry(`${TOP}/src/a:b.js`, 'x')] }))), /ungültiger Dateiname/);
  assert.throws(() => planUpdate(parseTar(repoTar({ extra: [entry('anderer-ordner/x.js', 'x')] }))), /unerwarteten Aufbau/);
  assert.throws(() => planUpdate(parseTar(repoTar({ without: ['tools/update.js'] }))), /unvollständig \(tools\/update\.js fehlt\)/);
  // Verknüpfungen werden nie angelegt
  const withLink = planUpdate(parseTar(repoTar({ extra: [entry(`${TOP}/link`, '', '2')] })));
  assert.ok(!withLink.some((f) => f.rel === 'link'));
});

// ---------------------------------------------------------------- ganzer Ablauf
test('Update: neue Dateien, Daten bleiben, version.txt, danach "aktuell"', async () => {
  const { root, read, has } = installDir();
  const gh = fakeGitHub();
  let askedPort = null;
  const log = [];
  const r = await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: async (p) => { askedPort = p; return false; }, log: (m) => log.push(m) });
  assert.equal(r.status, 'updated');
  assert.equal(r.changed, 5);
  assert.equal(askedPort, 3999); // Port aus der .env
  assert.equal(read('src/server.js'), 'NEU server');
  assert.equal(read('tools/start.cmd'), '@echo off\r\nNEU\r\n'); // Zeilenenden unverändert
  assert.equal(read('data/kartenhain.sqlite'), 'MEINE DATEN');
  assert.equal(read('.env'), 'PORT=3999\n');
  assert.equal(read('Start.bat'), 'MEINE START.BAT');
  assert.equal(read('public/nur-alt.js'), 'bleibt liegen');
  assert.equal(read('version.txt'), `${SHA}\r\n2026-11-18T09:00:00Z\r\n`);
  assert.deepEqual(readInstalled(root), { sha: SHA, date: '2026-11-18T09:00:00Z' });
  assert.ok(!fs.readdirSync(path.join(root, 'src')).some((f) => f.endsWith('.kh-neu')));
  assert.ok(!has('.env.kh-neu'));
  assert.match(log.at(-1), /Update fertig: 5 Dateien erneuert/);

  const again = await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: notRunning });
  assert.equal(again.status, 'current');
  assert.equal(gh.calls.filter((u) => u.includes('codeload')).length, 1); // nicht noch einmal geladen

  // version.txt weg (z. B. von Hand neu entpackt): lädt, schreibt aber nichts Unverändertes neu
  fs.rmSync(path.join(root, 'version.txt'));
  const same = await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: notRunning });
  assert.equal(same.status, 'updated');
  assert.equal(same.changed, 0);
  assert.ok(has('version.txt'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('Update: bei Fehlern bleibt alles, wie es war', async () => {
  const cases = [
    ['abgebrochener Download', fakeGitHub({ archive: zlib.gzipSync(repoTar()).subarray(0, 300) }), /.+/],
    ['böser Pfad', fakeGitHub({ archive: zlib.gzipSync(repoTar({ extra: [entry(`${TOP}/../../boese.txt`, 'x')] })) }), /ungültiger Dateiname/],
    ['unvollständig', fakeGitHub({ archive: zlib.gzipSync(repoTar({ without: ['src/server.js'] })) }), /src\/server\.js fehlt/],
    ['GitHub-Limit', fakeGitHub({ apiStatus: 403 }), /zu viele Anfragen/],
    ['Download-Fehler', fakeGitHub({ archiveStatus: 500 }), /Download fehlgeschlagen \(Fehler 500\)/],
    ['kein Internet', fakeGitHub({ fail: new TypeError('fetch failed') }), /keine Verbindung zu GitHub/],
    ['Zeitüberschreitung', fakeGitHub({ fail: Object.assign(new Error('x'), { name: 'TimeoutError' }) }), /antwortet nicht/],
    ['kaputte Antwort', fakeGitHub({ sha: 'kein-commit' }), /unerwartete Antwort/],
  ];
  for (const [name, gh, msg] of cases) {
    const { root, read, has } = installDir();
    const r = await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: notRunning });
    assert.equal(r.status, 'failed', name);
    assert.match(r.error, msg, name);
    assert.equal(read('src/server.js'), 'ALT server', name);
    assert.ok(!has('version.txt'), name);
    assert.ok(!has('tools'), name);
    assert.ok(!fs.existsSync(path.join(path.dirname(root), 'boese.txt')), name);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Update: übersprungen bei git-Ordner, laufendem Kartenhain oder wenn ausgeschaltet', async () => {
  const { root } = installDir();
  const gh = fakeGitHub();
  assert.equal((await selfUpdate({ root, env: { KARTENHAIN_NO_UPDATE: '1' }, fetchImpl: gh.impl, isRunning: notRunning })).status, 'off');
  fs.writeFileSync(path.join(root, '.env'), 'PORT=3999\r\nKARTENHAIN_NO_UPDATE=1\r\n');
  assert.equal((await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: notRunning })).status, 'off');
  fs.writeFileSync(path.join(root, '.env'), 'PORT=3999\r\nKARTENHAIN_NO_UPDATE=\r\n'); // leer = an
  assert.equal((await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: async () => true })).status, 'running');
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal((await selfUpdate({ root, env: {}, fetchImpl: gh.impl, isRunning: notRunning })).status, 'git');
  assert.equal(gh.calls.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Update: Dateien werden erst komplett geschrieben, dann ersetzt', () => {
  const { root, read } = installDir();
  // Schritt 1 scheitert (Ziel ist ein Ordner, Datei kann nicht daneben geschrieben werden): nichts geändert
  fs.mkdirSync(path.join(root, 'public', 'index.html.kh-neu'));
  assert.throws(() => applyUpdate(root, [
    { rel: 'src/server.js', data: Buffer.from('NEU') },
    { rel: 'public/index.html', data: Buffer.from('NEU') },
  ]));
  assert.equal(read('src/server.js'), 'ALT server');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'server.js.kh-neu')));
  fs.rmSync(path.join(root, 'public', 'index.html.kh-neu'), { recursive: true });
  assert.equal(applyUpdate(root, [{ rel: 'neu/ordner/datei.txt', data: Buffer.from('ok') }]), 1);
  assert.equal(read('neu/ordner/datei.txt'), 'ok');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Hilfen: Version lesen, Commit vergleichen, Port, läuft schon?', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  assert.equal(readInstalled(dir), null);
  fs.writeFileSync(path.join(dir, 'version.txt'), '﻿ABCDEF1234567\r\n');
  assert.deepEqual(readInstalled(dir), { sha: 'abcdef1234567', date: null });
  assert.ok(sameCommit('abcdef1234567', `abcdef1234567${'0'.repeat(27)}`));
  assert.ok(!sameCommit('abcdef1', 'abcdef2'));
  assert.ok(!sameCommit(null, 'abc'));
  assert.equal(configuredPort(dir, {}), 3000);
  fs.writeFileSync(path.join(dir, '.env'), '# Port\r\nPORT = "3123"\r\nHISTORY_MIN_TREND=0.5\r\n');
  assert.equal(configuredPort(dir, {}), 3123);
  assert.equal(configuredPort(dir, { PORT: '4000' }), 4000);
  fs.rmSync(dir, { recursive: true, force: true });

  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  assert.equal(await portInUse(port), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await portInUse(port), false);
});

test('Hinweis "neue Version da" nur bei Update über Start.bat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-'));
  const gh = fakeGitHub({ sha: 'b'.repeat(40) });
  const manual = createUpdateCheck(dir, { fetchImpl: gh.impl });
  assert.equal(manual.enabled, false); // von Hand installiert: nichts zu vergleichen
  fs.writeFileSync(path.join(dir, 'version.txt'), `${SHA}\r\n2026-11-17T09:00:00Z\r\n`);
  const check = createUpdateCheck(dir, { fetchImpl: gh.impl });
  assert.equal(check.enabled, true);
  assert.equal(check.info(), null); // noch nicht gefragt
  await check.check();
  assert.deepEqual(check.info(), { available: true, date: '2026-11-18T09:00:00Z' });
  const same = createUpdateCheck(dir, { fetchImpl: fakeGitHub().impl });
  await same.check();
  assert.equal(same.info(), null);
  const offline = createUpdateCheck(dir, { fetchImpl: fakeGitHub({ fail: new TypeError('fetch failed') }).impl });
  await offline.check(); // wirft nicht
  assert.equal(offline.info(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
