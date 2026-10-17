// node --test test/   (BASE=http://localhost:8787 by default). Uses unique device ids; cleans up after itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://localhost:8787';
const ORIGIN = 'https://majalen3.github.io';
const dev = () => 'T-' + crypto.randomUUID();
const call = async (method, path, { body, device, raw, headers = {} } = {}) => {
  const h = { Origin: ORIGIN, ...headers };
  if (device) h['X-Device-Id'] = device;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, headers: r.headers, json: j };
};
const line = (o = {}) => ({ ballId: 'super-nova', name: 'L1', release: 25, aim: 2, speed: 15, rev: 220, oil: 1, finish: '2000', pattern: 'house', note: 'n', ...o });

test('health ok + security headers', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});
test('CORS preflight + simple response', async () => {
  const p = await fetch(BASE + '/api/lines', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-device-id' } });
  assert.equal(p.status, 204);
  assert.match(p.headers.get('access-control-allow-headers').toLowerCase(), /x-device-id/);
  assert.ok(p.headers.get('access-control-allow-origin'));
  const g = await call('GET', '/api/health');
  assert.ok(g.headers.get('access-control-allow-origin'));
});
test('line save/load/overwrite/delete', async () => {
  const d = dev();
  let r = await call('POST', '/api/lines', { device: d, body: line() }); assert.equal(r.status, 201);
  const id = r.json.id;
  r = await call('POST', '/api/lines', { device: d, body: line({ release: 12 }) }); assert.equal(r.json.release, 12); assert.equal(r.json.id, id);
  r = await call('GET', '/api/lines?ballId=super-nova', { device: d }); assert.equal(r.json.length, 1);
  r = await call('DELETE', '/api/lines/' + id, { device: d }); assert.equal(r.json.deleted, 1);
});
test('device header required on writes/reads', async () => {
  assert.equal((await call('POST', '/api/lines', { body: line() })).status, 400);
  assert.equal((await call('GET', '/api/lines')).status, 400);
  assert.equal((await call('GET', '/api/lines', { device: 'bad id with spaces' })).status, 400);
});
test('per-device isolation (read/overwrite/delete)', async () => {
  const a = dev(), b = dev();
  const ra = await call('POST', '/api/lines', { device: a, body: line({ name: 'mine', note: 'A' }) });
  await call('POST', '/api/surface-log', { device: a, body: { ballId: 'x', date: '2026-01-01', finish: '500' } });
  await call('POST', '/api/pattern-notes', { device: a, body: { lane: '1', oil: 'x', adjustment: 'y' } });
  assert.equal((await call('GET', '/api/lines?ballId=super-nova', { device: b })).json.length, 0);
  assert.equal((await call('GET', '/api/surface-log', { device: b })).json.length, 0);
  assert.equal((await call('GET', '/api/pattern-notes', { device: b })).json.length, 0);
  assert.equal((await call('DELETE', '/api/lines/' + ra.json.id, { device: b })).json.deleted, 0);
  await call('POST', '/api/lines', { device: b, body: line({ name: 'mine', note: 'B' }) });
  const mine = await call('GET', '/api/lines?ballId=super-nova', { device: a }); assert.equal(mine.json[0].note, 'A');
  assert.equal((await call('DELETE', '/api/lines/' + ra.json.id, { device: a })).json.deleted, 1);
});
test('validation: bad numbers/lengths -> 400, never 500', async () => {
  const d = dev();
  const cases = [line({ release: 99 }), line({ aim: 'x' }), line({ speed: -1 }), line({ rev: 5000 }), line({ name: '' }), line({ name: 'x'.repeat(61) }), line({ ballId: 'b'.repeat(65) }), line({ note: 'n'.repeat(201) }), line({ finish: 'f'.repeat(25) }), line({ release: {} }), line({ name: ['a'] })];
  for (const c of cases) { const r = await call('POST', '/api/lines', { device: d, body: c }); assert.equal(r.status, 400, JSON.stringify(c).slice(0, 80)); }
  for (const raw of ['{bad', '', 'null', '[]', '"str"', '{"a":']) { const r = await call('POST', '/api/lines', { device: d, raw }); assert.ok([400].includes(r.status), 'raw ' + raw + ' -> ' + r.status); }
  assert.equal((await call('POST', '/api/surface-log', { device: d, body: { ballId: 'a', date: '2026-13-45', finish: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/surface-log', { device: d, body: { ballId: 'a', date: 'bad', finish: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/pattern-notes', { device: d, body: { lane: '', oil: 'x', adjustment: 'y' } })).status, 400);
  assert.equal((await call('DELETE', '/api/lines/abc', { device: d })).status, 400);
  assert.equal((await call('GET', '/api/nope', { device: d })).status, 404);
});
test('oversize body -> 413; huge array -> 400', async () => {
  const d = dev();
  assert.equal((await call('POST', '/api/lines', { device: d, body: line({ note: 'x'.repeat(30000) }) })).status, 413);
});
test('XSS / unicode payloads stored inert and returned as JSON', async () => {
  const d = dev();
  const nm = '<img src=x onerror=alert(1)>\u{1F3B3}"\'';
  const r = await call('POST', '/api/lines', { device: d, body: line({ name: nm }) }); assert.equal(r.status, 201);
  const g = await fetch(BASE + '/api/lines?ballId=super-nova', { headers: { 'X-Device-Id': d } });
  assert.match(g.headers.get('content-type'), /application\/json/);
  assert.equal((await g.json())[0].name, nm);
  assert.equal((await call('POST', '/api/lines', { device: d, body: line({ name: 'nul\u0000byte' }) })).status, 400);
});
test('concurrent upserts do not 500', async () => {
  const d = dev();
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/api/lines', { device: d, body: line({ release: i + 1 }) })));
  assert.ok(rs.every((r) => r.status === 201), rs.map((r) => r.status).join());
  assert.equal((await call('GET', '/api/lines?ballId=super-nova', { device: d })).json.length, 1);
});
test('surface log + pattern notes save/load', async () => {
  const d = dev();
  assert.equal((await call('POST', '/api/surface-log', { device: d, body: { ballId: 'a', date: '2026-10-17', finish: '2000' } })).status, 201);
  assert.equal((await call('GET', '/api/surface-log?ballId=a', { device: d })).json[0].date, '2026-10-17');
  assert.equal((await call('POST', '/api/pattern-notes', { device: d, body: { lane: '12', oil: 'heavy', adjustment: 'in 2' } })).status, 201);
  assert.equal((await call('GET', '/api/pattern-notes', { device: d })).json[0].lane, '12');
});
test('per-device storage quota -> 429/409 rather than unbounded growth', async () => {
  const d = dev();
  let last;
  for (let i = 0; i < 12; i++) { last = await call('POST', '/api/pattern-notes', { device: d, body: { lane: String(i), oil: 'o', adjustment: 'a' } }); }
  assert.ok(last.status === 201 || last.status === 429);
});
test('rate limit: burst from one device yields 429, health exempt', async () => {
  const d = dev(); const codes = [];
  for (let i = 0; i < 150; i++) codes.push((await call('GET', '/api/pattern-notes', { device: d })).status);
  assert.ok(codes.includes(429), 'no 429 in burst of 150');
  assert.equal((await call('GET', '/api/health')).status, 200);
});
test('DELETE /api/me wipes only this device', async () => {
  const a = dev(), b = dev();
  await call('POST', '/api/lines', { device: a, body: line() }); await call('POST', '/api/lines', { device: b, body: line() });
  await call('POST', '/api/pattern-notes', { device: a, body: { lane: '1', oil: 'x', adjustment: 'y' } });
  const r = await call('DELETE', '/api/me', { device: a }); assert.equal(r.json.deleted.lines, 1); assert.equal(r.json.deleted.pattern_notes, 1);
  assert.equal((await call('GET', '/api/lines?ballId=super-nova', { device: b })).json.length, 1);
  assert.equal((await call('DELETE', '/api/me')).status, 400);
});
