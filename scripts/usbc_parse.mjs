// Parse the USBC Approved Ball List text (pdftotext -layout of bowl.com's approved_balllist_CURRENT.pdf) into [{brand,name,approved}].
// Approved date is kept as printed ("Oct-13" = month precision) and as ISO ("2013-10" / "2018-01-30"). Facts only.
import { readFileSync } from 'node:fs';
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = n => String(n).padStart(2, '0');
export function parseDate(s) {
  let m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(s); if (m && MON[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${p2(MON[m[1].slice(0, 3).toLowerCase()])}-${p2(m[2])}`;
  m = /^([A-Z][a-z]{2})-(\d{2})$/.exec(s); if (m && MON[m[1].toLowerCase()]) { const y = +m[2]; return `${y > 30 ? 1900 + y : 2000 + y}-${p2(MON[m[1].toLowerCase()])}`; }
  return null;
}
export function parseUsbc(txt) {
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*(\S.*?)\s{2,}(\S.*?)\s{2,}((?:[A-Z][a-z]+ \d{1,2}, \d{4})|(?:[A-Z][a-z]{2}-\d{2}))\s*$/.exec(line); if (!m) continue;
    const iso = parseDate(m[3]); if (!iso) continue;
    out.push({ brand: m[1].trim(), name: m[2].trim(), printed: m[3], approved: iso });
  }
  return out;
}

