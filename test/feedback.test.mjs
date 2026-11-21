// Integration: feedback, survey, usage counts, crash reports, receipt delete, owner read. Runs against the isolated test server.
import test from 'node:test';
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8787';
const OWNER = process.env.FEEDBACK_ADMIN_TOKEN || '';
const ORIGIN = 'https://majalen3.github.io';
const call = async (method, path, { body, raw, headers = {} } = {}) => {
  const h = { Origin: ORIGIN, ...headers };
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.clone().json(); } catch (e) {}
  return { status: r.status, headers: r.headers, json: j, res: r };
};
const own = { Authorization: 'Bearer ' + OWNER };
const jpg = (n = 64) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]).toString('base64');
const receipts = [];

test('feedback: CORS preflight works from the app without a device id', async () => {
  const p = await fetch(BASE + '/api/feedback', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(p.status, 204); assert.equal(p.headers.get('access-control-allow-origin'), '*');
});
test('feedback: valid submit stores scrubbed text, path-only route, screenshot; returns a receipt', async () => {
  const r = await call('POST', '/api/feedback', { body: { type: 'bug', text: 'Lane froze, email me a@b.co', build: 'v82', route: '/lane?ball=x', device: 'phone', screenshot: jpg() } });
  assert.equal(r.status, 201); assert.match(r.json.receipt, /^[A-Za-z0-9_-]{22}$/); assert.equal(r.json.screenshot, 'stored');
  receipts.push(r.json.receipt);
  const l = await call('GET', '/api/owner/feedback', { headers: own });
  assert.equal(l.status, 200);
  const row = l.json.feedback.find((x) => /Lane froze/.test(x.text));
  assert.ok(row); assert.equal(row.route, '/lane'); assert.equal(row.build, 'v82'); assert.equal(row.device, 'phone'); assert.equal(row.has_shot, true);
  assert.doesNotMatch(row.text, /a@b\.co/);
  assert.equal(row.receipt_hash, undefined, 'owner list never returns receipt hashes');
  const s = await call('GET', `/api/owner/feedback/${row.id}/screenshot`, { headers: own });
  assert.equal(s.status, 200); assert.equal(s.headers.get('content-type'), 'image/jpeg');
});
test('feedback: validation (type, text cap, screenshot type/size, body cap, non-object)', async () => {
  assert.equal((await call('POST', '/api/feedback', { body: { type: 'rant' } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { body: { type: 'idea', text: 'x'.repeat(2500) } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { body: { type: 'idea', text: 5 } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { body: { type: 'idea', screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { body: { type: 'idea', screenshot: jpg(210 * 1024) } })).status, 400);
  assert.equal((await call('POST', '/api/feedback', { raw: JSON.stringify({ type: 'idea', screenshot: jpg(400 * 1024) }) })).status, 413);
  assert.equal((await call('POST', '/api/feedback', { raw: '[1]' })).status, 400);
  const ok = await call('POST', '/api/feedback', { body: { type: 'praise', text: '  long text gets trimmed  ', route: 'not a route', device: 'iPhone 15', build: 'beta' } });
  assert.equal(ok.status, 201); receipts.push(ok.json.receipt);
});
test('survey: 1-5 plus optional one-liner; validation', async () => {
  const r = await call('POST', '/api/survey', { body: { useful: 4, note: 'Bag pick was spot on', build: 'v82', device: 'phone' } });
  assert.equal(r.status, 201); receipts.push(r.json.receipt);
  for (const b of [{ useful: 0 }, { useful: 6 }, { useful: 2.5 }, { useful: 3, note: 'x'.repeat(400) }, {}]) assert.equal((await call('POST', '/api/survey', { body: b })).status, 400, JSON.stringify(b).slice(0, 40));
});
test('usage: only allow-listed keys are summed; no request row is kept', async () => {
  const r1 = await call('POST', '/api/usage', { body: { build: 'v82', counts: { 'bag.built': 2, 'optimize.used': 1, 'evil.key': 9 } } });
  assert.equal(r1.status, 202); assert.equal(r1.json.stored, 2);
  await call('POST', '/api/usage', { body: { build: 'v82', counts: { 'bag.built': 3 } } });
  assert.equal((await call('POST', '/api/usage', { body: { counts: 'x' } })).status, 400);
  const s = await call('GET', '/api/owner/summary', { headers: own });
  const bb = s.json.usage.find((u) => u.key === 'bag.built');
  assert.ok(bb.n >= 5); assert.ok(bb.reports >= 2);
  assert.ok(!s.json.usage.some((u) => u.key === 'evil.key'));
});
test('errors: scrubbed again on the server, aggregated by fingerprint', async () => {
  const e = { kind: 'error', message: 'TypeError: x is undefined near "Joe Smith" https://evil.example/?token=abc', stack: 'at f (https://majalen3.github.io/arsenal-pro-bowling/js/lane.js?v=1:10:5)', build: 'v82', route: '/lane', device: 'phone' };
  const a = await call('POST', '/api/errors', { body: e }); const b = await call('POST', '/api/errors', { body: e });
  assert.equal(a.status, 202); assert.equal(a.json.fingerprint, b.json.fingerprint);
  assert.equal((await call('POST', '/api/errors', { body: { kind: 'boom', message: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/errors', { body: { kind: 'error' } })).status, 400);
  const s = await call('GET', '/api/owner/summary', { headers: own });
  const row = s.json.errors.find((x) => x.fingerprint === a.json.fingerprint);
  assert.ok(row && row.n >= 2);
  assert.doesNotMatch(row.message + row.stack, /Joe|evil\.example|token|https/);
  assert.match(row.stack, /lane\.js:10:5/);
});
test('owner read: wrong or missing token is refused', async () => {
  assert.equal((await call('GET', '/api/owner/summary')).status, 401);
  assert.equal((await call('GET', '/api/owner/summary', { headers: { Authorization: 'Bearer wrong-token-wrong-token-wrong-token' } })).status, 401);
  assert.equal((await call('GET', '/api/owner/feedback/abc/screenshot', { headers: own })).status, 400);
});
test('delete by receipt removes what the bowler sent (feedback + survey + screenshot)', async () => {
  assert.equal((await call('DELETE', '/api/feedback', { body: { receipts: ['nope'] } })).status, 400);
  const d = await call('DELETE', '/api/feedback', { body: { receipts } });
  assert.equal(d.status, 200); assert.equal(d.json.deleted.feedback, 2); assert.equal(d.json.deleted.survey, 1);
  const l = await call('GET', '/api/owner/feedback', { headers: own });
  assert.ok(!l.json.feedback.some((x) => /Lane froze/.test(x.text)));
  const again = await call('DELETE', '/api/feedback', { body: { receipts } });
  assert.equal(again.json.deleted.feedback, 0);
});
test('feedback is rate-limited per IP (checked before the body is parsed)', async () => {
  let saw = 0;
  for (let i = 0; i < 25 && !saw; i++) { const r = await call('POST', '/api/feedback', { body: { type: 'nope' } }); if (r.status === 429) saw = +r.headers.get('retry-after'); }
  assert.ok(saw > 0, 'got a 429 with Retry-After');
});
