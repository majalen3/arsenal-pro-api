// Optional accounts. Start the server with SESSION_PEPPER=<32+ chars> and RL_SIGNUP=1000 (tests sign up many users from one IP).
// Every account made here is deleted at the end (DELETE /api/account with its password).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const BASE = process.env.BASE || 'http://localhost:8787';
const ORIGIN = 'https://majalen3.github.io';
const made = [];
const call = async (method, path, { body, token, origin = ORIGIN, device, raw } = {}) => {
  const h = {}; if (origin) h.Origin = origin; if (token) h.Authorization = 'Bearer ' + token; if (device) h['X-Device-Id'] = device;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, headers: r.headers, json: j };
};
const email = () => `t-${crypto.randomUUID().slice(0, 12)}@example.com`;
async function signup(pw = 'correct horse battery') {
  const e = email(), r = await call('POST', '/api/auth/signup', { body: { email: e, password: pw } });
  assert.equal(r.status, 201, JSON.stringify(r.json)); made.push({ token: r.json.token, password: pw, email: e });
  return { email: e, password: pw, raw: JSON.stringify(r.json), ...r.json };
}
let n = 0;
const ev = (o = {}) => ({ id: crypto.randomUUID(), seq: ++n, ts: 1761900000000 + n, deviceId: 'phoneA', schemaV: 1, type: 'ownedBall.created', entityId: 'own-x' + n, data: { catalogId: 'hy-road', name: 'Hy-Road', status: 'active' }, ...o });
after(async () => { for (const m of made) { try { await call('DELETE', '/api/account', { token: m.token, body: { password: m.password } }); } catch (e) {} } });

test('sign up -> token + one-time recovery key; password is never echoed; login works; wrong password is a generic 401', async () => {
  const u = await signup();
  assert.match(u.token, /^[A-Za-z0-9_-]{40,}$/); assert.match(u.recoveryKey, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  assert.equal(u.user.email, u.email); assert.ok(!u.raw.includes(u.password) && !u.raw.includes('scrypt'));
  const me = await call('GET', '/api/account', { token: u.token }); assert.equal(me.status, 200); assert.equal(me.json.user.id, u.user.id); assert.equal(me.json.stored, 0);
  const li = await call('POST', '/api/auth/login', { body: { email: u.email.toUpperCase(), password: u.password } }); assert.equal(li.status, 200); assert.notEqual(li.json.token, u.token);
  const bad = await call('POST', '/api/auth/login', { body: { email: u.email, password: 'wrong password!' } }); assert.equal(bad.status, 401);
  const nobody = await call('POST', '/api/auth/login', { body: { email: email(), password: 'whatever123' } }); assert.equal(nobody.status, 401); assert.equal(nobody.json.error, bad.json.error, 'same message: no account enumeration');
  assert.equal((await call('POST', '/api/auth/signup', { body: { email: u.email, password: 'another password' } })).status, 409);
});
test('validation: bad email / short password -> 400, never 500', async () => {
  for (const b of [{}, { email: 'x', password: 'longenough1' }, { email: email(), password: 'short' }, { email: email(), password: 'x'.repeat(201) }, { email: email() + '\u0000', password: 'longenough1' }, { email: ['a'], password: 'longenough1' }])
    assert.equal((await call('POST', '/api/auth/signup', { body: b })).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await call('POST', '/api/auth/signup', { raw: '{bad' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'x' } })).status, 400);
});
test('no token / junk token / signed-out token -> 401', async () => {
  assert.equal((await call('GET', '/api/account')).status, 401);
  assert.equal((await call('GET', '/api/account/events', { token: crypto.randomBytes(32).toString('base64url') })).status, 401);
  const u = await signup(); const li = await call('POST', '/api/auth/login', { body: { email: u.email, password: u.password } });
  assert.equal((await call('POST', '/api/auth/logout', { token: li.json.token })).status, 200);
  assert.equal((await call('GET', '/api/account', { token: li.json.token })).status, 401, 'logged-out token is dead');
  assert.equal((await call('GET', '/api/account', { token: u.token })).status, 200, 'other sessions stay');
});
test('isolation: account A cannot read or write B; device-code routes cannot reach an account stream', async () => {
  const a = await signup(), b = await signup(), e = ev();
  let r = await call('POST', '/api/account/events', { token: a.token, body: { events: [e, ev()] } }); assert.equal(r.status, 200); assert.equal(r.json.accepted, 2);
  assert.equal((await call('GET', '/api/account/events', { token: b.token })).json.events.length, 0, 'B sees nothing of A');
  assert.equal((await call('GET', '/api/account/export', { token: b.token })).json.events.length, 0);
  assert.equal((await call('POST', '/api/account/events', { token: b.token, body: { events: [e] } })).json.accepted, 1, 'same id in B is B\'s own row');
  assert.equal((await call('GET', '/api/account/events', { token: a.token })).json.events.length, 2, 'A unchanged by B');
  // the account stream key is 'u:<id>'; ':' is not a legal device code, so a device header cannot name it
  assert.equal((await call('GET', '/api/events', { device: 'u:' + a.user.id, origin: null })).status, 400);
  const g = await call('GET', '/api/account/events', { token: a.token }); assert.deepEqual(g.json.events[0].data, e.data); assert.equal(g.json.events[0].id, e.id);
  const x = await call('GET', '/api/account/export', { token: a.token }); assert.equal(x.json.user.email, a.email); assert.equal(x.json.events.length, 2); assert.ok(!JSON.stringify(x.json).includes('pw_hash'));
});
test('migration: device events pushed into a new account keep ids/ts/prov; re-push is idempotent', async () => {
  const u = await signup(), dev = Array.from({ length: 30 }, (_, i) => ev({ prov: { kind: 'user', ref: 'user-reported' }, importId: i < 5 ? 'imp-a' : undefined }));
  const r1 = await call('POST', '/api/account/events', { token: u.token, body: { events: dev } }); assert.equal(r1.json.accepted, 30);
  const r2 = await call('POST', '/api/account/events', { token: u.token, body: { events: dev } }); assert.equal(r2.json.accepted, 0); assert.equal(r2.json.duplicates, 30);
  const g = await call('GET', '/api/account/events?limit=500', { token: u.token });
  assert.deepEqual(g.json.events.map((e) => e.id), dev.map((e) => e.id)); assert.deepEqual(g.json.events[0].prov, dev[0].prov); assert.equal(g.json.events[0].importId, 'imp-a'); assert.equal(g.json.events[7].ts, dev[7].ts);
});
test('CORS: account routes answer only the app origin; device routes keep *', async () => {
  const pre = await call('OPTIONS', '/api/account/events', {}); assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN); assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const evil = await call('POST', '/api/auth/login', { origin: 'https://evil.example', body: { email: email(), password: 'whatever123' } });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('OPTIONS', '/api/account', { origin: 'https://evil.example' })).status, 403);
  const dev = await call('GET', '/api/health', { origin: 'https://evil.example' }); assert.equal(dev.headers.get('access-control-allow-origin'), '*');
});
test('login is rate limited per email (8 / 15 min) with Retry-After', async () => {
  const u = await signup(); let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/auth/login', { body: { email: u.email, password: 'nope nope ' + i } });
  assert.equal(last.status, 429); assert.ok(+last.headers.get('retry-after') > 0);
});
test('recovery key resets the password, rotates the key and signs out every session', async () => {
  const u = await signup();
  assert.equal((await call('POST', '/api/auth/recover', { body: { email: u.email, recoveryKey: 'AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'brand new pass' } })).status, 401);
  const r = await call('POST', '/api/auth/recover', { body: { email: u.email, recoveryKey: u.recoveryKey.toLowerCase(), newPassword: 'brand new pass' } });
  assert.equal(r.status, 200); assert.notEqual(r.json.recoveryKey, u.recoveryKey);
  made.find((m) => m.email === u.email).token = r.json.token; made.find((m) => m.email === u.email).password = 'brand new pass';
  assert.equal((await call('GET', '/api/account', { token: u.token })).status, 401, 'old session revoked');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: u.email, password: 'brand new pass' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/recover', { body: { email: u.email, recoveryKey: u.recoveryKey, newPassword: 'third pass 333' } })).status, 401, 'old key is single-use');
});
test('delete account needs the password and removes user, sessions and events', async () => {
  const u = await signup(); await call('POST', '/api/account/events', { token: u.token, body: { events: [ev(), ev()] } });
  assert.equal((await call('DELETE', '/api/account', { token: u.token, body: { password: 'wrong one!!' } })).status, 401);
  const d = await call('DELETE', '/api/account', { token: u.token, body: { password: u.password } });
  assert.equal(d.status, 200); assert.equal(d.json.deleted.events, 2); assert.equal(d.json.deleted.account, 1);
  assert.equal((await call('GET', '/api/account', { token: u.token })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: u.email, password: u.password } })).status, 401);
  const m = made.find((x) => x.email === u.email); made.splice(made.indexOf(m), 1);
});
