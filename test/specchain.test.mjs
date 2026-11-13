// Unit tests for the legal source chain (lib/specchain.js). No network, no DB: every fetch is injected.  node --test test/specchain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const CH = require('../lib/specchain.js'), SF = require('../lib/specfetch.js'), P = require('../lib/specparse.js');
const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/spec-pages.json', import.meta.url)));
const EX = SF.CHAIN_HOSTS;

// A page like Brunswick's with colour/core but NO symmetry and NO RG table (what the maker prints for a spare ball), and an older copy that has it.
const THIN = '<title>Fury Test</title><p>Core</p><p>Fury</p><p>Coverstock</p><p>Polyester</p><p>Cover Type</p><p>Polyester</p><p>Finish</p><p>Crown Factory Polish</p>';
const OLDER = THIN + '<p>Release Date</p><p>July 16, 2022</p><h3>Core Numbers</h3><div><span>16 lb</span><span>15 lb</span></div><div><b>RG</b><span>2.524</span><span>2.541</span></div><div><b>DIFF</b><span>0.038</span><span>0.036</span></div>';
const makerFound = (html, url = 'https://brunswickbowling.com/products/balls/current/fury-test') => { const p = P.parseSpecPage(html); return { status: 'found', source: { url, host: new URL(url).hostname, fetchedAt: '2026-11-12T00:00:00Z', title: p.title }, fields: p.fields, weights: p.weights, headlineWeight: p.headlineWeight }; };
const wb = (ts, original, status = '200') => JSON.stringify({ url: original, archived_snapshots: { closest: { status, available: true, url: `http://web.archive.org/web/${ts}/${original}`, timestamp: ts } } });
function mockFetch(map, log = []) {
  return async (url, opts) => {
    log.push(url);
    const c = SF.checkUrl(url, EX); if (!c.ok) return { ok: false, status: 'blocked', why: c.why, url };
    for (const [k, v] of Object.entries(map)) if (url.startsWith(k)) return typeof v === 'string' ? { ok: true, status: 200, body: v, url } : v;
    return { ok: false, status: 404, body: '', url };
  };
}
const deps = (map, extra = {}) => ({ fetch: mockFetch(map, extra.log), usbc: { meta: { page: 'https://bowl.com/approved-ball-list', listDate: '2026-11-10' }, idx: CH.indexUsbc([['Brunswick', 'Fury Test', '2023-05-02'], ['Hammer', 'Axe Green-Smoke', '2025-04-01']]) }, now: () => '2026-11-12T12:00:00Z', ...extra });

test('maker page complete: nothing else is fetched except the local USBC list', async () => {
  const log = [], m = makerFound(FX.craft);
  const r = await CH.runChain({ brand: 'Brunswick', name: 'Rattler Big Bite', maker: m, deps: deps({}, { log }) });
  assert.equal(r.status, 'found'); assert.deepEqual(log.filter(u => !/^https:\/\/brunswickbowling/.test(u)), [], 'no archive/secondary calls when the maker page has every core field');
  assert.equal(r.chain[0].outcome, 'found'); assert.equal(r.chain[1].outcome, 'skipped'); assert.equal(r.chain[3].outcome, 'skipped');
  assert.ok(Object.values(r.fields).every(f => f.src.type === 'maker'));
});
test('maker 404 → archived copy of the SAME maker address; every field is typed archived-maker with snapshot + original', async () => {
  const orig = 'https://brunswickbowling.com/products/balls/current/fury-test', ts = '20240101000000', log = [];
  const r = await CH.runChain({ brand: 'Brunswick', name: 'Fury Test', maker: { status: 'not-found', why: 'maker page answered 404', tried: orig }, makerUrls: [orig],
    deps: deps({ 'https://archive.org/wayback/available': wb(ts, orig), [`https://web.archive.org/web/${ts}id_/${orig}`]: OLDER }, { log }) });
  assert.equal(r.status, 'found'); assert.equal(r.chain[1].outcome, 'found');
  for (const f of Object.values(r.fields)) { assert.equal(f.src.type, 'archived-maker'); assert.equal(f.src.original, orig); assert.match(f.src.url, /^https:\/\/web\.archive\.org\/web\/20240101000000\/https:\/\/brunswickbowling\.com\//); }
  assert.deepEqual(r.weights[15], { rg: 2.541, diff: 0.036 }); assert.equal(r.weightsSrc.type, 'archived-maker');
  assert.equal(r.usbc.v, '2023-05-02'); assert.equal(r.usbc.src.type, 'usbc'); assert.ok(r.sourceTypes.includes('usbc'));
  assert.equal(r.fields.releaseDate.v, '2022-07-16');
});
test('later steps only fill gaps: a maker value is never overwritten, a disagreement is listed', async () => {
  const orig = 'https://brunswickbowling.com/products/balls/current/fury-test', ts = '20230101000000';
  const older = OLDER.replace('<p>Polyester</p><p>Cover Type</p><p>Polyester</p>', '<p>Other Cover</p><p>Cover Type</p><p>Solid</p>');
  const r = await CH.runChain({ brand: 'Brunswick', name: 'Fury Test', maker: makerFound(THIN), makerUrls: [orig], deps: deps({ 'https://archive.org/wayback/available': wb(ts, orig), [`https://web.archive.org/web/${ts}id_/${orig}`]: older }) });
  assert.equal(r.fields.coverType.src.type, 'maker'); assert.equal(r.fields.coverType.v, 'Polyester');
  assert.equal(r.fields.finish.src.type, 'maker'); assert.equal(r.fields.releaseDate.src.type, 'archived-maker');
  assert.ok(r.conflicts.some(c => c.field === 'coverType' && c.keptType === 'maker' && c.otherType === 'archived-maker'));
});
test('USBC alone: a name on the approved list gives an approval date, labelled usbc, never a release date or specs', async () => {
  const r = await CH.runChain({ brand: 'Hammer', name: 'Axe Green Smoke', maker: { status: 'not-found' }, deps: deps({}, { noArchive: true, noSecondary: true }) });
  assert.equal(r.status, 'usbc-only'); assert.equal(r.usbc.v, '2025-04-01'); assert.equal(r.fields, undefined);
  assert.equal(CH.usbcLookup('Hammer', 'Not A Real Ball', deps({})), null);
});
test('secondary page is used only for RG/diff gaps, typed secondary with attribution, and only if it names the ball', async () => {
  const page = '<title>Review</title><h1>900 Global Sublime review</h1><p>Coverstock Name</p><p>Reserve Blend 802 Hybrid</p><p>Core Type</p><p>Symmetrical</p><p>RG</p><p>2.47</p>';
  const r = await CH.runChain({ brand: '900 Global', name: 'Sublime', maker: { status: 'not-found' }, deps: deps({ 'https://bowlinglife.eu/900-global-sublime-review': page, 'https://en.wikipedia.org/w/api.php': '{"query":{"search":[]}}' }, { noArchive: true }) });
  assert.equal(r.fields.rg.v, 2.47); assert.equal(r.fields.rg.src.type, 'secondary'); assert.match(r.fields.rg.src.attribution, /not the maker/);
  const other = await CH.runChain({ brand: '900 Global', name: 'Sublime', maker: { status: 'not-found' }, deps: deps({ 'https://bowlinglife.eu/900-global-sublime-review': page.replace(/Sublime/g, 'Other Ball'), 'https://en.wikipedia.org/w/api.php': '{"query":{"search":[]}}' }, { noArchive: true }) });
  assert.equal(other.fields, undefined, 'a page that does not name the ball lends no numbers');
});
test('banned sites are rejected everywhere, including wrapped in an archive address', () => {
  for (const u of ['https://www.bowlingball.com/x', 'https://bowlingballvideos.com/a', 'https://www.bowwwl.com/b', 'https://bowlingthismonth.com/c',
    'https://web.archive.org/web/2020/https://www.bowlingball.com/x', 'https://archive.org/wayback/available?url=https%3A%2F%2Fbowwwl.com%2Fa'])
    assert.equal(SF.checkUrl(u, EX).ok, false, u);
});
test('archive addresses are readable only when they copy an allowlisted maker page', () => {
  assert.equal(SF.checkUrl('https://web.archive.org/web/20240101000000id_/https://brunswickbowling.com/a', EX).ok, true);
  assert.equal(SF.checkUrl('https://web.archive.org/web/20240101000000/https://evil.example/a', EX).ok, false);
  assert.equal(SF.checkUrl('https://web.archive.org/web/20240101/https://web.archive.org/web/2019/https://brunswickbowling.com/a', EX).ok, false);
  assert.equal(SF.checkUrl('https://web.archive.org/save/https://brunswickbowling.com/a', EX).ok, false, 'no Save Page Now');
  assert.equal(SF.checkUrl('https://web.archive.org/web/20240101/https://brunswickbowling.com/a').ok, false, 'chain hosts need the opt-in');
});
test('an archive that is down or has no copy does not break the lookup', async () => {
  const orig = 'https://brunswickbowling.com/products/balls/current/fury-test';
  const r = await CH.runChain({ brand: 'Brunswick', name: 'Fury Test', maker: makerFound(THIN), makerUrls: [orig], deps: deps({ 'https://archive.org/wayback/available': { ok: false, status: 503, body: '' } }, { noSecondary: true }) });
  assert.equal(r.status, 'found'); assert.equal(r.chain[1].outcome, 'not-found'); assert.ok(r.missing.includes('rg'));
});
test('rate limits and robots stay in force for chain hosts', () => {
  for (const h of ['web.archive.org', 'archive.org', 'bowlinglife.eu', 'en.wikipedia.org', 'bowl.com']) assert.ok(SF.HOST_MIN_DELAY_MS[h] >= 1500, h + ' needs a minimum gap between requests');
  assert.equal(SF.robotsAllows(SF.parseRobots('User-agent: *\nDisallow: /control/'), '/web/2020/https://x'), true);
});
test('zero invented values: every returned value appears in a source page', async () => {
  const orig = 'https://brunswickbowling.com/products/balls/current/fury-test', ts = '20240101000000';
  const r = await CH.runChain({ brand: 'Brunswick', name: 'Fury Test', maker: makerFound(THIN), makerUrls: [orig], deps: deps({ 'https://archive.org/wayback/available': wb(ts, orig), [`https://web.archive.org/web/${ts}id_/${orig}`]: OLDER }, { noSecondary: true }) });
  const text = P.htmlToLines(THIN + OLDER).join('\n');
  for (const [k, f] of Object.entries(r.fields)) assert.ok(text.includes(f.raw), `${k} raw "${f.raw}" not in source`);
  for (const w of Object.values(r.weights)) for (const n of Object.values(w)) assert.ok(text.includes(String(n).replace(/0+$/, '')) || text.includes(n.toFixed(3)) || text.includes(n.toFixed(2)), `${n} not in source`);
});
