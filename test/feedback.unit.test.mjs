// Pure checks for lib/feedback.js (no server, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FB = require('../lib/feedback.js');
const express = require('express');

test('free text: emails, links and phone numbers are removed; length capped', () => {
  const t = FB.scrubText('mail me at joe.bowler@example.com or 555-867-5309, see https://x.example/a?b=c ok', 1000);
  assert.doesNotMatch(t, /@|example\.com|867|https/);
  assert.match(t, /\[email removed\].*\[number removed\].*\[link removed\] ok/);
  assert.equal(FB.scrubText('x'.repeat(5000), 1000).length, 1000);
  assert.equal(FB.scrubText(42, 10), '');
});
test('error text: URLs, query strings, quoted user text and long numbers are stripped', () => {
  const m = FB.scrubError('TypeError: Cannot read "Joe Smith" at https://majalen3.github.io/arsenal-pro-bowling/js/lane.js?v=2:10:5 id 1234567', 200);
  assert.doesNotMatch(m, /Joe|https|\?v=|1234567/);
  assert.match(m, /lane\.js:10:5/);
  assert.ok(FB.scrubError('y'.repeat(3000), 1500).length <= 1500);
});
test('route, build, device and counts are allow-listed', () => {
  assert.equal(FB.cleanRoute('/ball/:id?x=1'), '/ball/:id');
  assert.equal(FB.cleanRoute('/bag'), '/bag');
  assert.equal(FB.cleanRoute('javascript:alert(1)'), '');
  assert.equal(FB.cleanRoute('/Joe Smith'), '');
  assert.equal(FB.cleanBuild('v82'), 'v82'); assert.equal(FB.cleanBuild('v82; drop'), '');
  assert.equal(FB.cleanDevice('phone'), 'phone'); assert.equal(FB.cleanDevice('iPhone 15 Pro'), '');
  assert.deepEqual(FB.cleanCounts({ 'bag.built': 2, 'optimize.used': 99999, 'secret.key': 4, 'game.logged': -1, 'screen.me': 1.5 }), { 'bag.built': 2, 'optimize.used': 1000 });
  assert.equal(FB.cleanCounts([1]), null);
});
test('screenshot: only small JPEG/PNG/WebP with matching bytes', () => {
  const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
  assert.equal(FB.decodeShot(jpg).mime, 'image/jpeg');
  assert.equal(FB.decodeShot(null), null);
  assert.equal(typeof FB.decodeShot('data:image/svg+xml;base64,PHN2Zz4='), 'string');
  assert.equal(typeof FB.decodeShot('data:image/png;base64,' + Buffer.from([0xff, 0xd8, 0xff]).toString('base64')), 'string');
  assert.equal(typeof FB.decodeShot('data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(210 * 1024)]).toString('base64')), 'string');
});
test('owner token: off when unset or short; constant-time match otherwise', () => {
  const tok = 'o'.repeat(40);
  assert.equal(FB.ownerOk('Bearer ' + tok, ''), false);
  assert.equal(FB.ownerOk('Bearer short', 'short'), false);
  assert.equal(FB.ownerOk('Bearer ' + tok, tok), true);
  assert.equal(FB.ownerOk('Bearer ' + tok + 'x', tok), false);
  assert.equal(FB.ownerOk(undefined, tok), false);
});
test('owner routes answer 404 when FEEDBACK_ADMIN_TOKEN is unset (read side disabled)', async () => {
  const saved = process.env.FEEDBACK_ADMIN_TOKEN; delete process.env.FEEDBACK_ADMIN_TOKEN;
  const app = express(); const touched = [];
  const pool = { query: async (q) => { touched.push(q); return { rows: [], rowCount: 0 }; } };
  FB.mount(app, { pool, wrap: (fn) => fn, hit: () => 0, limited: () => {}, bad: (res, m) => res.status(400).json({ error: m }), body: (r) => r.body || {}, secret: () => 's' });
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const p of ['/api/owner/summary', '/api/owner/feedback', '/api/owner/feedback/1/screenshot']) {
      const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + 'o'.repeat(40) } });
      assert.equal(r.status, 404, p);
    }
    assert.equal(touched.length, 0, 'no query ran');
  } finally { srv.close(); if (saved !== undefined) process.env.FEEDBACK_ADMIN_TOKEN = saved; }
});
test('weekly digest: counts, themes, top bugs, survey, crash clusters as Markdown', async () => {
  const { digest, themesOf } = await import('../scripts/feedback-digest.mjs');
  const summary = { since: '2026-11-14T00:00:00.000Z', feedbackByKind: { bug: 2, idea: 1 }, survey: [{ useful: 4, n: 2 }, { useful: 5, n: 1 }],
    usage: [{ key: 'bag.built', n: 9, reports: 3 }], totals: { feedback: 3, shots: 1, survey: 3 },
    errors: [{ fingerprint: 'abc', kind: 'error', message: 'TypeError: x | y', stack: 'lane.js:10:5', n: 4, routes: ['/lane'], builds: ['v82'] }] };
  const list = { feedback: [{ id: 3, kind: 'bug', text: 'Optimize is slow on the lane', route: '/lane', build: 'v82', has_shot: true },
    { id: 2, kind: 'bug', text: 'Score frame 10 wrong', route: '/bowl', build: 'v82' }, { id: 1, kind: 'idea', text: 'Shake up my bag', route: '/bag', build: 'v82' }],
    surveyNotes: [{ useful: 4, note: 'bag pick was great' }] };
  const md = digest(summary, list, { now: new Date('2026-11-21T00:00:00Z') });
  assert.match(md, /\| Bug reports \| 2 \|/); assert.match(md, /Average 4\.33 of 5 from 3 answers/);
  assert.match(md, /\| \/lane \| 1 \| "Optimize is slow on the lane" \| v82 \| #3 \|/);
  assert.match(md, /TypeError: x \\\| y/);   // pipes escaped so the table holds
  assert.match(md, /\| bag\.built \| 9 \| 3 \|/);
  const th = themesOf(['Optimize is slow on the lane', 'bag pick was great', 'Shake up my bag']);
  assert.equal(th[0].name, 'Bag building'); assert.equal(th[0].n, 2);
});

test('v83: funnel keys are accepted; digest shows the funnel and the readiness scorecard', async () => {
  const { cleanCounts } = require('../lib/feedback.js');
  assert.deepEqual(cleanCounts({ 'usage.on': 2, 'first.bag': 1, 'first.ball': 1, 'first.optimize': 1, 'first.game': 1, 'ball.added': 4, 'app.installed': 1, 'app.shared': 1, 'evil': 3 }),
    { 'usage.on': 2, 'first.bag': 1, 'first.ball': 1, 'first.optimize': 1, 'first.game': 1, 'ball.added': 4, 'app.installed': 1, 'app.shared': 1 });
  const { digest, funnel, scorecard } = await import('../scripts/feedback-digest.mjs');
  assert.match(funnel([]).join('\n'), /no funnel yet/);
  const f = funnel([{ key: 'usage.on', n: 4 }, { key: 'first.bag', n: 3 }, { key: 'first.game', n: 1 }, { key: 'ball.added', n: 5 }]).join('\n');
  assert.match(f, /\| Packed a first bag \| 3 \| 75% \|/); assert.match(f, /\| Finished a first game \| 1 \| 25% \|/); assert.match(f, /Balls added: 5/);
  const sc = scorecard({ answers: 12, avg: 4.25, er: [{ builds: ['v82', 'v83'] }], us: [{ key: 'usage.on', n: 12 }, { key: 'first.bag', n: 10 }], bugs: 2 }).join('\n');
  assert.match(sc, /Phones that opted in \| 12 .* on track/); assert.match(sc, /Post-game average \| 4\.25 \(12\) .* on track/); assert.match(sc, /more than one build \| 1 \| 0 \| not yet/);
  const md = digest({ since: '2026-11-15T00:00:00Z', usage: [{ key: 'usage.on', n: 1, reports: 1 }] }, { feedback: [] }, { now: new Date('2026-11-22T00:00:00Z') });
  assert.match(md, /## Activation funnel/); assert.match(md, /## Readiness scorecard/);
});
