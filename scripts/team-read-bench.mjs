// Local-only read-path bench for My Team (GET /api/account/teams and GET /api/account/teams/:tid).
// Seeds a full team (20 bowlers, shared bags and tags, 100 notes, 10 reports) on a LOCAL fixture server, then times the two
// reads the app makes when My Team opens. Never point it at production: it writes data (it refuses an onrender.com BASE).
//   BASE=http://127.0.0.1:8788 node scripts/team-read-bench.mjs [rounds]   (start the fixture server with RL_IP set high, e.g. 1000000, or reads hit 429)
import crypto from 'node:crypto'; import http from 'node:http';
const BASE = process.env.BASE || 'http://127.0.0.1:8787', ROUNDS = +(process.argv[2] || 200), ORIGIN = 'https://majalen3.github.io';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error('local fixture server only');
const call = async (method, path, { body, token, headers = {} } = {}) => {
  const h = { Origin: ORIGIN, ...headers }; if (token) h.Authorization = 'Bearer ' + token; if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, bytes: Buffer.byteLength(text), etag: r.headers.get('etag'), cc: r.headers.get('cache-control') };
};
const user = async () => { const r = await call('POST', '/api/auth/signup', { body: { email: `b-${crypto.randomUUID().slice(0, 12)}@example.com`, password: 'correct horse battery' } }); if (r.status !== 201) throw new Error(JSON.stringify(r.json)); return r.json.token; };
const T = '/api/account/teams';
const sec = await user(), t = (await call('POST', T, { token: sec, body: { name: 'Bench Rollers', displayName: 'Sam', night: 'Thu', time: '18:30' } })).json.team.id;
const code = (await call('POST', `${T}/${t}/invites`, { token: sec, body: { maxUses: 30 } })).json.code;
const mates = [];
for (let i = 0; i < 19; i++) { const u = await user(); await call('POST', T + '/join', { token: u, body: { code, displayName: 'Bowler ' + i } }); mates.push(u); }
for (const u of [sec, ...mates]) {
  await call('POST', `${T}/${t}/shares/bag`, { token: u, body: { data: { title: 'Tonight I\u2019m bringing', balls: Array.from({ length: 6 }, (_, j) => ({ name: 'Ball ' + j, role: 'benchmark', why: 'for when the fronts dry up' })) } } });
  await call('POST', `${T}/${t}/shares/tags`, { token: u, body: { data: { tags: ['tweener'] } } });
}
for (let k = 0; k < 100; k++) await call('POST', `${T}/${t}/notes`, { token: mates[k % mates.length], body: { lanes: '5-6', text: 'Note ' + k + ': the pair hooked early and the left lane dried out by game three' } });
const view0 = (await call('GET', `${T}/${t}`, { token: sec })).json;
for (let k = 0; k < 10; k++) await call('POST', `${T}/${t}/reports`, { token: mates[k], body: { noteId: view0.notes[k].id, reason: 'bench' } });
const time = async (path, token, headers) => { const ms = [], st = {}; let bytes = 0;
  for (let i = 0; i < ROUNDS; i++) { const t0 = performance.now(); const r = await call('GET', path, { token, headers }); ms.push(performance.now() - t0); st[r.status] = (st[r.status] || 0) + 1; bytes = r.bytes; }
  ms.sort((a, b) => a - b); return { median_ms: +ms[ms.length >> 1].toFixed(2), p95_ms: +ms[Math.floor(ms.length * 0.95)].toFixed(2), bytes, status: st }; };
const out = { list_secretary: await time(T, sec), view_secretary: await time(`${T}/${t}`, sec), view_member: await time(`${T}/${t}`, mates[0]) };
const v = await call('GET', `${T}/${t}`, { token: sec }); out.cache_control = v.cc; out.etag = !!v.etag;
// Browser-style revalidation (node:http: fetch() would add Cache-Control: no-cache to a script-set If-None-Match).
const raw = (path, token, etag) => new Promise((res, rej) => { const u = new URL(BASE + path); const t0 = performance.now();
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Origin: ORIGIN, Authorization: 'Bearer ' + token, 'If-None-Match': etag } }, (r) => {
    let n = 0; r.on('data', (c) => { n += c.length; }); r.on('end', () => res({ status: r.statusCode, bytes: n, ms: performance.now() - t0 })); }).on('error', rej); });
if (v.etag) { const ms = [], st = {}; let bytes = 0; for (let i = 0; i < ROUNDS; i++) { const r = await raw(`${T}/${t}`, sec, v.etag); ms.push(r.ms); st[r.status] = (st[r.status] || 0) + 1; bytes = r.bytes; }
  ms.sort((a, b) => a - b); out.view_secretary_revalidate = { median_ms: +ms[ms.length >> 1].toFixed(2), p95_ms: +ms[Math.floor(ms.length * 0.95)].toFixed(2), bytes, status: st }; }
console.log(JSON.stringify(out, null, 1));
for (const u of [sec, ...mates]) await call('DELETE', '/api/account', { token: u, body: { password: 'correct horse battery' } });
