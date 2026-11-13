'use strict';
// Legal source chain for the ball spec lookup (owner t138u/t139u). Once a ball name is picked, each step may add fields the
// earlier steps did not print. Order = trust order, and a later step NEVER overwrites an earlier one:
//   1. maker            the maker's own current product page (lib/specfetch.js: allowlisted hosts, robots.txt, Crawl-delay)
//   2. archived-maker   a Wayback Machine copy of that same maker page (Wayback availability API, then the id_ raw copy)
//   3. usbc             the USBC Approved Ball List snapshot (data/usbc_approved.json): approval date only, exact name match
//   4. secondary        public references read only when RG/differential are still missing: Wikipedia, bowlinglife.eu
// A forum is never fetched; the app offers typing the spec in. bowlingballvideos, bowwwl, bowlingball.com and BowlingThisMonth are
// rejected inside specfetch.checkUrl (also when wrapped in a web.archive.org address). Every field carries its own source.
const fs = require('fs');
const path = require('path');
const SF = require('./specfetch');
const { parseSpecPage } = require('./specparse');

const TYPES = ['maker', 'archived-maker', 'usbc', 'secondary'];
const SPEC_FIELDS = ['rg', 'diff', 'intDiff', 'coverstock', 'coverType', 'finish', 'core', 'symmetry', 'releaseDate', 'condition'];
const CORE_FIELDS = ['rg', 'diff', 'coverstock', 'coverType', 'finish', 'core', 'symmetry'];
const EXTRA = SF.CHAIN_HOSTS;
const NUM_TOL = { rg: 0.005, diff: 0.002, intDiff: 0.002 };

// One request budget for the whole chain (the app waits ~35 s): each step gets what is left, and is skipped when almost nothing is.
const left = (deps) => (deps && deps.deadline ? deps.deadline - Date.now() : 15000);
const once = (deps, url, opts) => (deps && deps.fetch ? deps.fetch(url, opts) : SF.guardedFetch(url, Object.assign({ extraHosts: EXTRA }, opts)));
// The Internet Archive occasionally resets a connection; one retry after the per-host gap (never more: rate limits stay polite).
const fetchOne = async (deps, url, opts) => { try { return await once(deps, url, opts); } catch (e) { if (e && e.name === 'AbortError') throw e; await new Promise((r) => setTimeout(r, deps && deps.retryGapMs != null ? deps.retryGapMs : 2500)); return once(deps, url, opts); } };
const now = (deps) => (deps && deps.now ? deps.now() : new Date().toISOString());
const host = (u) => { try { return new URL(u).hostname; } catch (e) { return null; } };

// ---- USBC Approved Ball List snapshot (exact normalised brand + name only; month-only dates stay month-only)
let USBC = null;
function loadUsbc(deps) {
  if (deps && deps.usbc) return deps.usbc;
  if (USBC) return USBC;
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'usbc_approved.json'), 'utf8')); USBC = { meta: Object.assign({}, j, { rows: undefined }), idx: indexUsbc(j.rows) }; } catch (e) { USBC = { meta: null, idx: new Map() }; }
  return USBC;
}
const nn = (s) => String(s).toLowerCase().replace(/[™®]/g, '').replace(/&/g, ' and ').replace(/viz-?a-?ball/g, 'viz a ball').replace(/[/\-_()]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const USBC_BRANDS = { 'kr strikeforce': ['strikeforce', 'krsf'], epic: ['epic bowling'], track: ['track inc'], 'columbia 300': ['columbia 300'], 'roto grip': ['roto grip'] };
function indexUsbc(rows) { const m = new Map(); for (const [b, n, d] of rows) { const k = nn(b) + '|' + nn(n); (m.get(k) || m.set(k, []).get(k)).push(d); } return m; }
function usbcLookup(brand, name, deps) {
  const u = loadUsbc(deps); if (!u.meta && !(deps && deps.usbc)) return null;
  const b = nn(brand), bs = USBC_BRANDS[b] || [b], hits = [];
  for (const bb of bs) for (const alt of [name, String(name).replace(/ Poly$/i, ' Polyester')]) hits.push(...(u.idx.get(bb + '|' + nn(alt)) || []));
  const dates = [...new Set(hits)].sort();
  if (!dates.length) return null;
  return { dates, meta: u.meta };
}

// ---- Wayback Machine: the availability API names the closest capture of the maker's own address; the id_ copy is the page as saved.
async function archivedCopy(originalUrl, deps) {
  const c = SF.checkUrl(originalUrl); if (!c.ok) return { status: 'blocked', why: c.why };
  if (left(deps) < 3000) return { status: 'out-of-time', why: 'ran out of time; try again' };
  const to = () => ({ timeoutMs: Math.max(2000, Math.min(15000, left(deps) - 500)) });
  const api = await fetchOne(deps, 'https://archive.org/wayback/available?url=' + encodeURIComponent(c.url.href), Object.assign({ accept: 'application/json' }, to()));
  if (!api.ok) return { status: api.status === 'blocked' || api.status === 'busy' ? api.status : 'not-found', why: api.why || `archive index answered ${api.status}` };
  let snap; try { snap = JSON.parse(api.body).archived_snapshots.closest; } catch (e) { snap = null; }
  if (!snap || !snap.available || String(snap.status) !== '200' || !/^\d{8,14}$/.test(String(snap.timestamp))) return { status: 'not-found', why: 'no saved copy of the maker page' };
  const raw = `https://web.archive.org/web/${snap.timestamp}id_/${c.url.href}`;
  const r = await fetchOne(deps, raw, to());
  if (!r.ok) return { status: r.status === 'blocked' || r.status === 'busy' ? r.status : 'not-found', why: r.why || `archived copy answered ${r.status}` };
  return { status: 'found', body: r.body, snapshot: `https://web.archive.org/web/${snap.timestamp}/${c.url.href}`, timestamp: snap.timestamp, original: c.url.href };
}

// ---- Secondary references (read only when RG/differential are still missing). Facts only; never a banned site.
const slug = (s) => nn(s).replace(/ /g, '-');
async function secondaryPages(brand, name, deps) {
  const out = [], b = String(brand), n = String(name);
  out.push({ url: `https://bowlinglife.eu/${slug(b)}-${slug(n)}-review`, label: 'bowlinglife.eu review page', attribution: 'bowlinglife.eu (public review; not the maker)' });
  try {
    const q = encodeURIComponent(`intitle:"${b} ${n}" "bowling ball"`);
    const r = await fetchOne(deps, `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3`, { accept: 'application/json' });
    if (r.ok) for (const h of (JSON.parse(r.body).query || {}).search || []) {
      if (nn(h.title).split(' ').filter((t) => nn(n).split(' ').includes(t)).length === nn(n).split(' ').length)   // every word of the ball name must be in the title
        out.push({ url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')), label: 'Wikipedia', attribution: 'Wikipedia, CC BY-SA 4.0 (not the maker)' });
    }
  } catch (e) { /* Wikipedia is optional */ }
  return out;
}

// ---- Merge helpers
function addFields(acc, parsed, src, step) {
  const added = [];
  for (const [k, x] of Object.entries(parsed.fields || {})) {
    if (!SPEC_FIELDS.includes(k) || x.v == null || x.v === '') continue;
    if (acc.fields[k]) {
      const a = acc.fields[k], differ = typeof a.v === 'number' && typeof x.v === 'number' ? Math.abs(a.v - x.v) > (NUM_TOL[k] || 0) : ['coverType', 'symmetry'].includes(k) && String(a.v) !== String(x.v);
      if (differ) acc.conflicts.push({ field: k, kept: a.v, keptType: a.src.type, other: x.v, otherType: src.type });
      continue;   // earlier step wins; later steps only fill gaps
    }
    acc.fields[k] = Object.assign({}, x, { src }); added.push(k);
  }
  if (!acc.weightsSrc && Object.keys(parsed.weights || {}).length) { acc.weights = parsed.weights; acc.weightsSrc = src; acc.headlineWeight = parsed.headlineWeight || null; added.push('weights'); }
  else if (acc.weightsSrc && Object.keys(parsed.weights || {}).length) {
    // a later step may add a weight row the earlier table did not print (never changes a printed one)
    for (const [w, row] of Object.entries(parsed.weights)) if (!acc.weights[w]) { acc.weights[w] = row; acc.extraWeightSrc = acc.extraWeightSrc || {}; acc.extraWeightSrc[w] = src; added.push('weights'); }
  }
  step.fields = added;
  return added;
}
const missingCore = (acc) => CORE_FIELDS.filter((k) => !acc.fields[k] && !((k === 'rg' || k === 'diff') && acc.weights && Object.values(acc.weights).some((w) => w[k] != null)));

// Entry point. `maker` = {status:'found', fields, weights, headlineWeight, source:{url, host, fetchedAt, title}} from the maker step (server.js
// fetchSpecPage), or a not-found result. `makerUrls` = the maker addresses worth looking for in the archive when the live page failed or
// printed too little. Returns the merged result; never throws for a source that is down (the step records why).
async function runChain({ brand, name, maker, makerUrls = [], deps = {} }) {
  if (deps && !deps.deadline) deps = Object.assign({}, deps, { deadline: Date.now() + (deps.budgetMs || 18000) });
  const chain = [], acc = { fields: {}, weights: null, weightsSrc: null, headlineWeight: null, conflicts: [] };
  const mk = maker || { status: 'not-found' };
  // 1. maker
  const s1 = { step: 'maker', type: 'maker', outcome: mk.status === 'found' ? 'found' : mk.status || 'not-found', url: mk.source ? mk.source.url : (mk.tried || null), why: mk.why || null, fields: [] };
  if (mk.status === 'found') addFields(acc, mk, { type: 'maker', url: mk.source.url, host: mk.source.host || host(mk.source.url), fetchedAt: mk.source.fetchedAt || now(deps), title: mk.source.title || null }, s1);
  chain.push(s1);
  // 2. archived copy of the maker page: only when the live page failed or left core specs empty
  const urls = [...new Set([mk.source && mk.source.url, ...makerUrls].filter(Boolean))].slice(0, 2);
  const s2 = { step: 'archived-maker', type: 'archived-maker', outcome: 'skipped', why: null, fields: [] };
  if (missingCore(acc).length && urls.length && !(deps && deps.noArchive)) {
    for (const u of urls) {
      let a; try { a = await archivedCopy(u, deps); } catch (e) { a = { status: 'error', why: e && e.name === 'AbortError' ? 'archive was too slow' : 'archive did not answer' }; }
      s2.outcome = a.status; s2.why = a.why || null; s2.url = a.snapshot || u;
      if (a.status !== 'found') continue;
      const p = parseSpecPage(a.body);
      if (!Object.keys(p.fields).length && !Object.keys(p.weights).length) { s2.outcome = 'no-specs'; s2.why = 'the saved copy lists no specs'; continue; }
      const added = addFields(acc, p, { type: 'archived-maker', url: a.snapshot, original: a.original, host: 'web.archive.org', fetchedAt: now(deps), capturedAt: a.timestamp, title: p.title }, s2);
      s2.outcome = added.length ? 'found' : 'nothing-new'; break;
    }
  } else if (!missingCore(acc).length) s2.why = 'maker page already has the core specs';
  chain.push(s2);
  // 3. USBC approved list (always, local file: approval date + maker; not a release date)
  const s3 = { step: 'usbc', type: 'usbc', outcome: 'not-listed', why: null, fields: [] };
  const u = name ? usbcLookup(brand, name, deps) : null;
  if (u) {
    const date = u.dates[0];   // several listings (re-approvals): the first approval; every date is kept in `dates`
    acc.usbc = { v: date, dates: u.dates, src: { type: 'usbc', url: (u.meta && u.meta.page) || 'https://bowl.com/approved-ball-list', host: 'bowl.com', fetchedAt: now(deps), listDate: u.meta && u.meta.listDate } };
    s3.outcome = 'found'; s3.fields = ['usbcApproved']; s3.url = acc.usbc.src.url;
  }
  chain.push(s3);
  // 4. secondary references, only for gaps in RG/diff
  const s4 = { step: 'secondary', type: 'secondary', outcome: 'skipped', why: null, fields: [] };
  if (!(acc.fields.rg || (acc.weights && Object.values(acc.weights).some((w) => w.rg != null))) || !(acc.fields.diff || (acc.weights && Object.values(acc.weights).some((w) => w.diff != null)))) {
    if (!(deps && deps.noSecondary) && name) {
      s4.outcome = 'not-found';
      for (const c of await secondaryPages(brand, name, deps).catch(() => [])) {
        if (left(deps) < 3000) { s4.outcome = 'out-of-time'; break; }
        let r; try { r = await fetchOne(deps, c.url, { timeoutMs: Math.max(2000, Math.min(12000, left(deps) - 500)) }); } catch (e) { continue; }
        if (!r.ok) continue;
        const p = parseSpecPage(r.body); if (!Object.keys(p.fields).length) continue;
        // a review page for a different ball must not lend its numbers: the page must name the ball
        const text = require('./specparse').htmlToLines(r.body).join(' ').toLowerCase();
        if (!nn(text).includes(nn(`${brand} ${name}`)) && !nn(text).includes(nn(name))) continue;
        const added = addFields(acc, p, { type: 'secondary', url: r.url, host: host(r.url), fetchedAt: now(deps), attribution: c.attribution, title: p.title }, s4);
        s4.outcome = added.length ? 'found' : 'nothing-new'; s4.url = r.url; if (added.length) break;
      }
    }
  } else s4.why = 'RG and differential already found';
  chain.push(s4);
  const missing = SPEC_FIELDS.filter((k) => !acc.fields[k] && !((k === 'rg' || k === 'diff' || k === 'intDiff') && acc.weights && Object.values(acc.weights).some((w) => w[k] != null)));
  const types = [...new Set([...Object.values(acc.fields).map((f) => f.src.type), ...(acc.usbc ? ['usbc'] : [])])];
  const any = Object.keys(acc.fields).length || (acc.weights && Object.keys(acc.weights).length);
  const first = Object.values(acc.fields)[0] || (acc.weightsSrc ? { src: acc.weightsSrc } : null);
  const out = { status: any ? 'found' : (acc.usbc ? 'usbc-only' : (mk.status || 'not-found')), brand: brand && String(brand).toLowerCase(), chain, missing, sourceTypes: types, conflicts: acc.conflicts };
  if (any) Object.assign(out, { fields: acc.fields, weights: acc.weights || {}, weightsSrc: acc.weightsSrc, headlineWeight: acc.headlineWeight, source: mk.status === 'found' ? mk.source : (first && first.src) });
  if (acc.extraWeightSrc) out.extraWeightSrc = acc.extraWeightSrc;
  if (acc.usbc) out.usbc = acc.usbc;
  if (!any) { Object.assign(out, { why: mk.why || 'No maker page or saved copy lists specs for this ball.' }); if (mk.noSpecs) out.noSpecs = true; if (mk.tried) out.tried = mk.tried; if (mk.retryAfter) out.retryAfter = mk.retryAfter; }
  return out;
}
module.exports = { runChain, archivedCopy, usbcLookup, secondaryPages, indexUsbc, nn, TYPES, SPEC_FIELDS, CORE_FIELDS, missingCore };
