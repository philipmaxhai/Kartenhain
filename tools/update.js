// Holt die neueste Kartenhain-Version von GitHub (Start.bat ruft das vor jedem Start auf).
// Von Hand: node tools/update.js     Ausschalten: KARTENHAIN_NO_UPDATE=1 in der Datei .env
// Deine Daten (Ordner data, Datei .env) bleiben immer unverändert. Siehe src/selfupdate.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const major = Number(process.versions.node.split('.')[0]);

// Sehr alte Node-Versionen überspringen das Update still (tools/start.cmd meldet das dann verständlich)
if (major >= 18) {
  try {
    const { selfUpdate } = await import('../src/selfupdate.js');
    await selfUpdate({ root, log: (m) => console.log(` ${m}`) });
  } catch (e) {
    console.log(` Update gerade nicht möglich: ${e?.message ?? e}`);
  }
}
// Kein process.exit(): unter Windows könnten sonst die letzten Meldungen verloren gehen.
// Falls trotzdem etwas hängen bleibt, nach 3 Sekunden beenden.
process.exitCode = 0;
setTimeout(() => process.exit(0), 3000).unref();
