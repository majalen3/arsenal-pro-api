'use strict';
// Pure parser: manufacturer product page HTML → labelled spec fields. Returns ONLY values printed on the page.
// Layout families covered by fixtures: Storm/Roto Grip/900 Global ("Label:" / "S_value"), Brunswick-family Craft sites
// (label line / value line + "Core Numbers" weight table), Shopify brands (UPPERCASE label / value + "#16 / RG (x) Diff (y)").

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', reg: '®', trade: '™', deg: '°', frac12: '½' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}
function htmlToLines(html) {
  const s = String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  return decode(s.replace(/<[^>]*>/g, '\n')).split('\n').map((l) => l.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean);
}
function titleOf(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{1,200})["']/i.exec(html) || /<meta[^>]+content=["']([^"']{1,200})["'][^>]*property=["']og:title["']/i.exec(html);
  const t = og || /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  return t ? decode(t[1]).replace(/\s+/g, ' ').trim() : null;
}

// label (lower-case, no trailing colon) → field. Order inside a field = priority (first found wins).
const LABELS = {
  rg: ['radius of gyration', 'rg', 'rg (16 lb)'],
  diff: ['differential', 'total differential', 'diff', 'differential (16 lb)'],
  intDiff: ['intermediate differential', 'intermediate diff', 'int. diff', 'int diff', 'mass bias', 'mass bias differential', 'psa'],
  coverstock: ['coverstock', 'cover stock', 'coverstock name'],
  coverType: ['cover type', 'coverstock type'],
  finish: ['factory finish', 'finish', 'factory surface', 'box finish', 'out of box finish'],
  core: ['weight block', 'core', 'core name'],
  symmetry: ['symmetry', 'core type'],
  releaseDate: ['release date', 'launch date'],
  condition: ['best lane condition', 'lane condition', 'recommended lane condition', 'oil condition'],
};
const LABEL_OF = new Map();
for (const [f, ls] of Object.entries(LABELS)) ls.forEach((l, i) => LABEL_OF.set(l, { f, i }));
const ALL_LABELS = new Set([...LABEL_OF.keys(), 'brand', 'line', 'durometer', 'flare potential', 'weight', 'weights', 'available weights', 'color', 'fragrance', 'part number', 'level', 'warranty', 'reaction', 'core numbers', 'rg / differential', 'matchmaker', 'matchmaker app', 'avail. for sales orders', 'mass bias']);
const keyOf = (l) => l.toLowerCase().replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();
const clean = (v) => v.replace(/^[A-Z]_(?=\S)/, '').trim(); // Storm-family sites prefix values with a brand letter (S_/R_/N_)

const num = (s) => { const m = /^(\d?\.\d+|\d+\.\d*)$/.exec(String(s).trim()); return m ? parseFloat(m[1]) : null; };
const RANGE = { rg: [2.3, 2.9], diff: [0, 0.09], intDiff: [0, 0.04] };
const inRange = (f, v) => v !== null && v >= RANGE[f][0] && v <= RANGE[f][1];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function isoDate(raw) {
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; if (+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  m = /^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(raw);
  if (m) { const mo = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))); if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw); if (m) return raw;
  return null;
}
const coverKind = (s) => { const m = /\b(solid|pearl|hybrid|urethane)\b/i.exec(s || ''); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null; };
const symKind = (s) => /\basym/i.test(s || '') ? 'Asymmetric' : /\bsym/i.test(s || '') ? 'Symmetric' : null;

function weightTable(lines) {
  const out = {};
  // Craft family: "16 lb" … run, then "RG" + n numbers, "DIFF" + n numbers (+ optional int diff row).
  for (let i = 0; i < lines.length; i++) {
    const ws = []; let j = i;
    while (j < lines.length && /^(1[0-6])\s*lbs?\.?$/i.test(lines[j])) { ws.push(+/^(\d+)/.exec(lines[j])[1]); j++; }
    if (ws.length < 2) continue;
    for (let k = j; k < Math.min(lines.length, j + 6 * (ws.length + 1)); k++) {
      const lab = keyOf(lines[k]);
      const f = lab === 'rg' ? 'rg' : (lab === 'diff' || lab === 'differential') ? 'diff' : (/^(int\.? ?diff|intermediate diff(erential)?|mb|mass bias|psa)$/.test(lab)) ? 'intDiff' : null;
      if (!f) continue;
      const vals = lines.slice(k + 1, k + 1 + ws.length).map(num);
      if (vals.every((v) => inRange(f, v))) ws.forEach((w, n) => { (out[w] = out[w] || {})[f] = vals[n]; });
    }
    if (Object.keys(out).length) return out;
  }
  // Row-wise table (Track/Ebonite): header "Weight","RG","DIFF"[,"INT DIFF"] then rows "16 lb", rg, diff[, int].
  const colOf = (l) => { const k = keyOf(l); return k === 'rg' ? 'rg' : (k === 'diff' || k === 'differential') ? 'diff' : /^(int\.? ?diff|intermediate diff(erential)?|mb|mass bias|psa)$/.test(k) ? 'intDiff' : null; };
  for (let i = 0; i < lines.length; i++) {
    if (keyOf(lines[i]) !== 'weight') continue;
    const cols = []; let j = i + 1; while (j < lines.length && colOf(lines[j])) cols.push(colOf(lines[j++]));
    if (cols.length < 2) continue;
    while (j + cols.length < lines.length && /^(1[0-6])\s*lbs?\.?$/i.test(lines[j])) {
      const w = +/^(\d+)/.exec(lines[j])[1], vals = lines.slice(j + 1, j + 1 + cols.length).map(num);
      if (!vals.every((v, n) => inRange(cols[n], v))) break;
      out[w] = Object.fromEntries(cols.map((c, n) => [c, vals[n]])); j += 1 + cols.length;
    }
    if (Object.keys(out).length) return out;
  }
  // Shopify family: "#16" then "RG (2.51) Diff (.048)" (same or next line).
  for (let i = 0; i < lines.length; i++) {
    const m = /^#?\s?(1[0-6])\s*(?:lbs?\.?)?\s*(.*)$/i.exec(lines[i]); if (!m) continue;
    const rest = m[2] || lines[i + 1] || '';
    const r = /RG\s*[:(]?\s*(\d?\.\d+)\s*\)?\s*[,/]?\s*Diff(?:erential)?\s*[:(]?\s*(\d?\.\d+)\)?/i.exec(rest);
    if (r) { const rg = num(r[1]), diff = num(r[2]); if (inRange('rg', rg) && inRange('diff', diff)) out[+m[1]] = { rg, diff }; }
  }
  return out;
}

function parseSpecPage(html) {
  const lines = htmlToLines(html);
  const hits = {};
  for (let i = 0; i < lines.length - 1; i++) {
    const L = LABEL_OF.get(keyOf(lines[i])); if (!L) continue;
    const nxt = lines[i + 1]; if (ALL_LABELS.has(keyOf(nxt)) || nxt.length > 160) continue;
    const prev = hits[L.f]; if (!prev || L.i < prev.i) hits[L.f] = { i: L.i, raw: clean(nxt), label: lines[i].replace(/[:：]\s*$/, '') };
  }
  const fields = {};
  for (const [f, h] of Object.entries(hits)) {
    if (f === 'rg' || f === 'diff' || f === 'intDiff') { const v = num(h.raw); if (inRange(f, v)) fields[f] = { v, raw: h.raw, label: h.label }; continue; }
    if (f === 'releaseDate') { fields[f] = { v: isoDate(h.raw), raw: h.raw, label: h.label }; continue; }
    if (f === 'symmetry') { const k = symKind(h.raw); if (k) fields[f] = { v: k, raw: h.raw, label: h.label }; continue; }
    if (f === 'coverType') { fields[f] = { v: coverKind(h.raw) || h.raw, raw: h.raw, label: h.label }; continue; }
    fields[f] = { v: h.raw, raw: h.raw, label: h.label };
  }
  // Derived from printed words only (never guessed): cover type from the coverstock name, symmetry from the core name.
  if (!fields.coverType && fields.coverstock && coverKind(fields.coverstock.v)) fields.coverType = { v: coverKind(fields.coverstock.v), raw: fields.coverstock.raw, label: 'from coverstock name', derived: true };
  if (!fields.symmetry && fields.core && symKind(fields.core.v)) fields.symmetry = { v: symKind(fields.core.v), raw: fields.core.raw, label: 'from core name', derived: true };
  const weights = weightTable(lines);
  // A bare "RG"/"DIFF" label inside a per-weight table is that table's first column, not a headline value.
  if (Object.keys(weights).length) for (const f of ['rg', 'diff', 'intDiff']) if (fields[f] && /^(rg|diff|mb|int\.? ?diff)$/i.test(fields[f].label)) delete fields[f];
  // Storm prints one weight next to the headline numbers ("Weight: 16").
  const wi = lines.findIndex((l) => keyOf(l) === 'weight');
  const headlineWeight = wi >= 0 && /^(1[0-6])$/.test(lines[wi + 1] || '') ? +lines[wi + 1] : null;
  if (headlineWeight && (fields.rg || fields.diff) && !weights[headlineWeight]) weights[headlineWeight] = Object.fromEntries(['rg', 'diff', 'intDiff'].filter((f) => fields[f]).map((f) => [f, fields[f].v]));
  return { title: titleOf(html), fields, weights, headlineWeight };
}

module.exports = { parseSpecPage, htmlToLines, isoDate, coverKind, symKind, weightTable };
