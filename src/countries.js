// Cardmarket liefert Verkäuferländer als Kürzel. Fast alle sind ISO-3166,
// Ausnahme: Deutschland heißt bei Cardmarket "D".
const NAMES = {
  AT: 'Österreich', BE: 'Belgien', BG: 'Bulgarien', CA: 'Kanada', CH: 'Schweiz',
  CY: 'Zypern', CZ: 'Tschechien', DE: 'Deutschland', DK: 'Dänemark', EE: 'Estland',
  ES: 'Spanien', FI: 'Finnland', FR: 'Frankreich', GB: 'Großbritannien', GR: 'Griechenland',
  HK: 'Hongkong', HR: 'Kroatien', HU: 'Ungarn', IE: 'Irland', IS: 'Island', IT: 'Italien',
  JP: 'Japan', LI: 'Liechtenstein', LT: 'Litauen', LU: 'Luxemburg', LV: 'Lettland',
  MT: 'Malta', NL: 'Niederlande', NO: 'Norwegen', PL: 'Polen', PT: 'Portugal',
  RO: 'Rumänien', SE: 'Schweden', SG: 'Singapur', SI: 'Slowenien', SK: 'Slowakei',
  US: 'USA',
};

export function normalizeCountry(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return c === 'D' ? 'DE' : c;
}

export function countryInfo(code) {
  const iso = normalizeCountry(code);
  if (!iso) return { code: null, name: 'Unbekannt', flag: '' };
  const flag = /^[A-Z]{2}$/.test(iso)
    ? String.fromCodePoint(...[...iso].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65))
    : '';
  return { code: iso, name: NAMES[iso] ?? iso, flag };
}
