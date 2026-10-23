// v2 event sync. BASE=http://localhost:8787; start the server with EVENT_QUOTA=50 to exercise the quota path quickly
// (the default 5000 is checked by reading `quota` back). Unique device ids; DELETE /api/me cleans up.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://localhost:8787';
const used = new Set();
const dev = () => { const d = 'T-' + crypto.randomUUID(); used.add(d); return d; };
const call = async (method, path, { body, device, raw } = {}) => {
  const h = { Origin: 'https://majalen3.github.io' }; if (device) h['X-Device-Id'] = device;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, headers: r.headers, json: j };
};
let n = 0;
const ev = (o = {}) => ({ id: crypto.randomUUID(), seq: ++n, ts: 1761200000000 + n, deviceId: 'phoneA', schemaV: 1, type: 'line.edited', entity: 'line', entityId: 'super-nova|A', data: { release: 20 + (n % 5) }, synced: false, ...o });
after(async () => { for (const d of used) { try { await fetch(BASE + '/api/me', { method: 'DELETE', headers: { 'X-Device-Id': d } }); } catch (e) {} } });

test('POST /api/events is idempotent; GET pages by cursor in server order', async () => {
  const d = dev(); const batch = Array.from({ length: 7 }, () => ev());
  let r = await call('POST', '/api/events', { device: d, body: { events: batch } });
  assert.equal(r.status, 200); assert.equal(r.json.accepted, 7); assert.ok(/^\d+$/.test(r.json.cursor));
  r = await call('POST', '/api/events', { device: d, body: { events: batch } });
  assert.equal(r.json.accepted, 0); assert.equal(r.json.duplicates, 7);
  const p1 = await call('GET', '/api/events?limit=4', { device: d });
  assert.equal(p1.json.events.length, 4); assert.equal(p1.json.more, true);
  const p2 = await call('GET', '/api/events?limit=4&after=' + p1.json.cursor, { device: d });
  assert.equal(p2.json.events.length, 3); assert.equal(p2.json.more, false);
  const got = [...p1.json.events, ...p2.json.events];
  assert.deepEqual(got.map((e) => e.id), batch.map((e) => e.id));
  assert.deepEqual(got[0].data, batch[0].data); assert.equal(got[0].ts, batch[0].ts); assert.equal(got[0].deviceId, 'phoneA'); assert.equal(got[0].seq, batch[0].seq, 'phone seq kept'); assert.ok(/^\d+$/.test(got[0].serverSeq)); assert.equal(got[0].entityId, 'super-nova|A');
  const p3 = await call('GET', '/api/events?after=' + p2.json.cursor, { device: d }); assert.equal(p3.json.events.length, 0); assert.equal(p3.json.cursor, p2.json.cursor);
});
test('prov and importId round-trip; device isolation', async () => {
  const a = dev(), b = dev();
  const e = ev({ type: 'sessionAggregate.created', entity: 'sessionAggregate', prov: { kind: 'device', device: 'LaneTrax', n: null }, importId: 'imp-1', data: { summary: { arrows: { mean: 14.6 } } } });
  await call('POST', '/api/events', { device: a, body: { events: [e] } });
  const g = await call('GET', '/api/events', { device: a }); assert.deepEqual(g.json.events[0].prov, e.prov); assert.equal(g.json.events[0].importId, 'imp-1');
  assert.equal((await call('GET', '/api/events', { device: b })).json.events.length, 0);
  // same event id under another device code is a different row
  assert.equal((await call('POST', '/api/events', { device: b, body: { events: [e] } })).json.accepted, 1);
});
test('validation: malformed events -> 400, never 500; nothing stored from a bad batch', async () => {
  const d = dev();
  const bad = [{}, { events: [] }, { events: 'x' }, { events: [ev({ id: '' })] }, { events: [ev({ id: 'x'.repeat(81) })] }, { events: [ev({ type: 'nodot' })] }, { events: [ev({ ts: 'now' })] },
    { events: [ev({ ts: 1.5 })] }, { events: [ev({ data: [1] })] }, { events: [ev({ data: 'str' })] }, { events: [ev({ entityId: { a: 1 } })] }, { events: [ev({ prov: 'x' })] },
    { events: [ev({ id: 'nul\u0000' })] }, { events: [ev({ data: { s: 'nul\u0000' } })] }, { events: [ev({ schemaV: -1 })] }, { events: [ev({ seq: 'x' })] }, { events: [ev(), null] }, { events: [ev({ data: { s: 'x'.repeat(9000) } })] }];
  for (const b of bad) { const r = await call('POST', '/api/events', { device: d, body: b }); assert.equal(r.status, 400, JSON.stringify(b).slice(0, 90)); }
  for (const raw of ['{bad', 'null', '[]']) assert.equal((await call('POST', '/api/events', { device: d, raw })).status, 400);
  assert.equal((await call('POST', '/api/events', { body: { events: [ev()] } })).status, 400, 'device header required');
  assert.equal((await call('GET', '/api/events?after=abc', { device: d })).status, 400);
  assert.equal((await call('GET', '/api/events?limit=501', { device: d })).status, 400);
  assert.equal((await call('GET', '/api/events', { device: d })).json.events.length, 0);
});
test('batch over 20 kB -> 413; over 500 events -> 400', async () => {
  const d = dev();
  const big = Array.from({ length: 40 }, () => ev({ data: { note: 'x'.repeat(600) } }));
  assert.equal((await call('POST', '/api/events', { device: d, body: { events: big } })).status, 413);
  const many = Array.from({ length: 501 }, () => ({ id: 'e' + (++n), type: 'a.b', ts: 1 }));
  assert.equal((await call('POST', '/api/events', { device: d, body: { events: many } })).status, 400);
});
test('per-device event quota -> 429 with a message; re-sending known events still OK', async () => {
  const d = dev();
  const first = await call('POST', '/api/events', { device: d, body: { events: [ev()] } });
  const quota = first.json.quota; assert.ok(Number.isInteger(quota) && quota > 0);
  if (quota > 200) return; // default 5000: skip the fill (run the server with EVENT_QUOTA=50 to exercise)
  let stored = 1, r; const sent = [];
  while (stored < quota) { const k = Math.min(40, quota - stored); const b = Array.from({ length: k }, () => ({ id: 'q' + (++n), type: 'a.b', ts: n })); sent.push(...b); r = await call('POST', '/api/events', { device: d, body: { events: b } }); assert.equal(r.status, 200); stored += k; }
  r = await call('POST', '/api/events', { device: d, body: { events: [ev()] } });
  assert.equal(r.status, 429); assert.match(r.json.error, /quota/); assert.equal(r.json.stored, quota); assert.equal(r.headers.get('retry-after'), null, 'quota is not a rate limit: no Retry-After');
  assert.equal((await call('POST', '/api/events', { device: d, body: { events: sent.slice(0, 5) } })).status, 200, 'idempotent re-send under quota');
});
test('GET /api/me includes events; DELETE /api/me deletes them', async () => {
  const d = dev(); await call('POST', '/api/events', { device: d, body: { events: [ev(), ev()] } });
  const me = await call('GET', '/api/me', { device: d }); assert.equal(me.json.events.length, 2); assert.ok(Array.isArray(me.json.lines));
  const del = await call('DELETE', '/api/me', { device: d }); assert.equal(del.json.deleted.events, 2);
  assert.equal((await call('GET', '/api/events', { device: d })).json.events.length, 0);
});
test('concurrent batches from one device do not 500 or double-insert', async () => {
  const d = dev(); const b = Array.from({ length: 10 }, () => ev());
  const rs = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/api/events', { device: d, body: { events: b } })));
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join());
  assert.equal(rs.reduce((a, r) => a + r.json.accepted, 0), 10);
});
test('pattern notes are paged; no params keeps the old newest-50 response', async () => {
  const d = dev();
  for (let i = 0; i < 5; i++) await call('POST', '/api/pattern-notes', { device: d, body: { lane: String(i), oil: 'o', adjustment: 'a' } });
  const all = await call('GET', '/api/pattern-notes', { device: d }); assert.ok(Array.isArray(all.json)); assert.equal(all.json.length, 5); assert.equal(all.json[0].lane, '4');
  const p1 = await call('GET', '/api/pattern-notes?limit=2', { device: d }); assert.equal(p1.json.length, 2);
  const nb = p1.headers.get('x-next-before'); assert.ok(nb);
  const p2 = await call('GET', '/api/pattern-notes?limit=2&before=' + nb, { device: d }); assert.deepEqual(p2.json.map((x) => x.lane), ['2', '1']);
  assert.equal((await call('GET', '/api/pattern-notes?limit=0', { device: d })).status, 400);
});
