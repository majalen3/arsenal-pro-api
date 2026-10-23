// Pure unit tests for the spec lookup (no server, no network): node --test test/specs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const P = require('../lib/specparse.js'), F = require('../lib/specfetch.js');
const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/spec-pages.json', import.meta.url)));
const vals = (r) => Object.fromEntries(Object.entries(r.fields).map(([k, v]) => [k, v.v]));

test('Storm layout: labels with colons, S_ prefixes, headline weight', () => {
  const r = P.parseSpecPage(FX.storm);
  assert.deepEqual(vals(r), { core: 'Velocity', finish: '3000 Grit', symmetry: 'Symmetric', diff: 0.051, rg: 2.48, coverstock: 'TX-16 Solid', releaseDate: '2016-10-04', coverType: 'Solid' });
  assert.equal(r.fields.coverType.derived, true);
  assert.deepEqual(r.weights, { 16: { rg: 2.48, diff: 0.051 } });
  assert.equal(r.fields.intDiff, undefined, 'empty PSA must not become a value');
});
test('Roto Grip on the Storm site: R_ prefix, PSA = intermediate diff', () => {
  const r = P.parseSpecPage(FX.rotogrip);
  assert.equal(r.fields.core.v, 'Momentous AI'); assert.equal(r.fields.intDiff.v, 0.017); assert.equal(r.fields.symmetry.v, 'Asymmetric'); assert.equal(r.fields.coverType.v, 'Pearl');
});
test('Craft (Brunswick family): column weight table, no headline taken from the table', () => {
  const r = P.parseSpecPage(FX.craft);
  assert.equal(r.fields.rg, undefined); assert.equal(r.fields.diff, undefined);
  assert.deepEqual(r.weights[15], { rg: 2.48, diff: 0.035 }); assert.deepEqual(r.weights[16], { rg: 2.493, diff: 0.03 });
  assert.equal(r.fields.coverType.v, 'Hybrid'); assert.equal(r.fields.symmetry.v, 'Symmetric'); assert.equal(r.fields.symmetry.derived, true);
  assert.equal(r.fields.releaseDate.v, '2024-08-15');
});
test('Shopify (Hammer): uppercase labels, "#16 RG (x) Diff (y)"', () => {
  const r = P.parseSpecPage(FX.shopify);
  assert.deepEqual(r.weights, { 16: { rg: 2.51, diff: 0.048 }, 15: { rg: 2.5, diff: 0.058 }, 14: { rg: 2.5, diff: 0.056 } });
  assert.equal(r.fields.intDiff.v, 0.016); assert.equal(r.fields.symmetry.v, 'Asymmetric'); assert.equal(r.fields.condition.v, 'Medium to Heavy Oil');
});
test('Row-wise table (Track/Ebonite)', () => {
  const r = P.parseSpecPage(FX.rows);
  assert.deepEqual(r.weights[16], { rg: 2.51, diff: 0.036 }); assert.equal(Object.keys(r.weights).length, 3); assert.equal(r.fields.intDiff.v, 0.005);
});
test('No spec block → no fields (nothing invented)', () => {
  const r = P.parseSpecPage(FX.empty); assert.deepEqual(r.fields, {}); assert.deepEqual(r.weights, {});
});
test('Zero invented values: every returned raw value appears in the source text', () => {
  for (const k of ['storm', 'rotogrip', 'craft', 'shopify', 'rows']) {
    const text = P.htmlToLines(FX[k]).join('\n'), r = P.parseSpecPage(FX[k]);
    for (const [f, v] of Object.entries(r.fields)) assert.ok(text.includes(v.raw), `${k}.${f} raw "${v.raw}" not in source`);
    const nums = new Set((text.match(/\d*\.\d+/g) || []).map(Number));
    for (const w of Object.values(r.weights)) for (const n of Object.values(w)) assert.ok(nums.has(n), `${k} weight value ${n} not in source`);
  }
});
test('dates and kinds', () => {
  assert.equal(P.isoDate('10/04/16'), '2016-10-04'); assert.equal(P.isoDate('Sept 20, 2022'), '2022-09-20'); assert.equal(P.isoDate('soon'), null);
  assert.equal(P.coverKind('HK22 - Havoc Hybrid'), 'Hybrid'); assert.equal(P.coverKind('Reactive'), null);
  assert.equal(P.symKind('Asymmetrical'), 'Asymmetric'); assert.equal(P.symKind('Symmetrical'), 'Symmetric');
});
test('URL guard: allowlist, https only, no creds, no odd ports', () => {
  assert.equal(F.checkUrl('https://radicalbowling.com/products/balls/x').ok, true);
  assert.equal(F.checkUrl('https://www.stormbowling.com/storm-phaze-ii-bowling-ball').ok, true);
  for (const u of ['http://radicalbowling.com/', 'https://evil.example.com/', 'https://radicalbowling.com.evil.io/', 'https://user:pw@radicalbowling.com/', 'https://radicalbowling.com:8443/', 'https://169.254.169.254/latest', 'file:///etc/passwd', 'not a url', 'https://motivbowling.com/'])
    assert.equal(F.checkUrl(u).ok, false, u);
});
test('private address detection', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(F.isPrivateIp(ip), true, ip);
  for (const ip of ['104.18.2.3', '2606:4700::1']) assert.equal(F.isPrivateIp(ip), false, ip);
});
test('robots.txt: Storm-style groups, crawl-delay, wildcard disallow', () => {
  const r = F.parseRobots('User-agent: Yandex\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 10\nDisallow: /ajax\nDisallow:\nUser-agent: *\nDisallow: /*?*filter[\nCrawl-delay: 10\n');
  assert.equal(r.delay, 10);
  assert.equal(F.robotsAllows(r, '/storm-phaze-ii-bowling-ball'), true);
  assert.equal(F.robotsAllows(r, '/ajax/thing'), false);
  assert.equal(F.robotsAllows(r, '/x?a=1&filter[c]=2'), false);
  const all = F.parseRobots('User-agent: *\nDisallow: /'); assert.equal(F.robotsAllows(all, '/products/x'), false);
  const mine = F.parseRobots('User-agent: *\nDisallow: /\nUser-agent: ArsenalProSpecLookup\nAllow: /products/'); assert.equal(F.robotsAllows(mine, '/products/x'), true);
});
test('discovery scoring: only an exact ordered name scores 1', () => {
  const q = F.tokens('Black Widow Black/Gold');
  assert.equal(F.score(q, F.tokens('black-widow-black-gold')), 1);
  assert.ok(F.score(q, F.tokens('black-widow-gold')) < 1);
  assert.ok(F.score(F.tokens('Prism'), F.tokens('prism-warp')) < 0.75);
  assert.equal(F.score(F.tokens('Rattler Big Bite'), F.tokens('rattler-big-bite')), 1);
});
test('brands: aliases and the unsupported route', () => {
  assert.equal(F.brandOf('Roto Grip').prefix, 'roto-grip'); assert.equal(F.brandOf('900 GLOBAL').prefix, '900-global');
  assert.equal(F.brandOf('Motiv').strategy, 'unsupported'); assert.equal(F.brandOf('Acme'), null);
});
