// My Team routes (lib/teams.js). Start the server with SESSION_PEPPER=<32+ chars> RL_SIGNUP=1000 RL_TEAM_CREATE=1000
// RL_TEAM_JOIN=1000 RL_TEAM_JOIN_IP=1000. TEST_DATABASE_URL (optional, LOCAL database only) lets the expiry test move an
// invite's expiry into the past; without it that one check is skipped. Every account made here is deleted at the end.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const BASE = process.env.BASE || 'http://localhost:8787';
if (/onrender\.com/.test(BASE)) throw new Error('team tests write data: never run them against production');
const ORIGIN = 'https://majalen3.github.io';
const made = [];
const call = async (method, path, { body, token, origin = ORIGIN } = {}) => {
  const h = {}; if (origin) h.Origin = origin; if (token) h.Authorization = 'Bearer ' + token; if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j, headers: r.headers };
};
async function user() {
  const pw = 'correct horse battery', r = await call('POST', '/api/auth/signup', { body: { email: `t-${crypto.randomUUID().slice(0, 12)}@example.com`, password: pw } });
  assert.equal(r.status, 201, JSON.stringify(r.json)); const u = { token: r.json.token, password: pw, id: r.json.user.id }; made.push(u); return u;
}
const T = '/api/account/teams';
async function team(sec, name = 'Thursday Rollers') { const r = await call('POST', T, { token: sec.token, body: { name, displayName: 'Sam', night: 'Thu', time: '18:30' } }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; }
async function invite(sec, tid, body = {}) { const r = await call('POST', `${T}/${tid}/invites`, { token: sec.token, body }); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json; }
async function join(u, code, displayName = 'Alex') { return call('POST', T + '/join', { token: u.token, body: { code, displayName } }); }
after(async () => { for (const m of made) { try { await call('DELETE', '/api/account', { token: m.token, body: { password: m.password } }); } catch (e) {} } });

test('needs an account, and the account CORS allowlist', async () => {
  assert.equal((await call('GET', T)).status, 401);
  assert.equal((await call('GET', T, { token: 'x'.repeat(43) })).status, 401);
  const u = await user();
  assert.equal((await call('GET', T, { token: u.token, origin: 'https://evil.example' })).status, 403);
  const pre = await fetch(BASE + T, { method: 'OPTIONS', headers: { Origin: ORIGIN } }); assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
});

test('create → invite → join → share bag → teammate sees it; emails and account ids never leave', async () => {
  const sec = await user(), mate = await user();
  const t = await team(sec); assert.equal(t.role, 'secretary'); assert.equal(t.team.night, 'Thu'); assert.equal(t.team.time, '18:30');
  const inv = await invite(sec, t.team.id); assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const j = await join(mate, inv.code.toLowerCase().replace('-', ' ')); assert.equal(j.status, 201, JSON.stringify(j.json)); assert.equal(j.json.role, 'member');
  assert.equal((await join(mate, inv.code)).json.already, true, 'joining twice is a no-op');
  const bag = { title: 'Tonight', balls: [{ name: 'Phaze II', role: 'Benchmark', why: 'Reads the mids early' }, { name: 'Ice Storm', role: 'Spare', why: 'Goes straight' }] };
  const s = await call('POST', `${T}/${t.team.id}/shares/bag`, { token: mate.token, body: { data: bag } }); assert.equal(s.status, 200, JSON.stringify(s.json));
  const v = await call('GET', `${T}/${t.team.id}`, { token: sec.token }); assert.equal(v.status, 200);
  const m = v.json.members.find((x) => x.memberId === j.json.memberId); assert.deepEqual(m.shares.bag.data, bag); assert.equal(m.displayName, 'Alex');
  const raw = JSON.stringify(v.json); assert.ok(!raw.includes('@example.com') && !raw.includes(mate.id) && !raw.includes(sec.id), 'no email or account id in a team view');
  assert.ok(Array.isArray(v.json.reports), 'the secretary sees reports');
  const mv = await call('GET', `${T}/${t.team.id}`, { token: mate.token }); assert.equal(mv.json.reports, undefined, 'members do not see reports');
  const list = await call('GET', T, { token: mate.token }); assert.equal(list.json.teams.length, 1); assert.equal(list.json.teams[0].members, 2);
  // stop sharing
  assert.equal((await call('DELETE', `${T}/${t.team.id}/shares/bag`, { token: mate.token })).json.deleted, 1);
  const v2 = await call('GET', `${T}/${t.team.id}`, { token: sec.token }); assert.deepEqual(v2.json.members.find((x) => x.memberId === j.json.memberId).shares, {});
});

test('isolation: a non-member cannot read or write a team (404), and team A members cannot reach team B', async () => {
  const a = await user(), b = await user(), out = await user();
  const ta = await team(a, 'A team'), tb = await team(b, 'B team');
  for (const [m, p, body] of [['GET', `/${ta.team.id}`], ['POST', `/${ta.team.id}/shares/bag`, { data: { balls: [] } }], ['POST', `/${ta.team.id}/notes`, { text: 'hi' }],
    ['POST', `/${ta.team.id}/invites`, {}], ['GET', `/${ta.team.id}/invites`], ['DELETE', `/${ta.team.id}/members/me`], ['DELETE', `/${ta.team.id}`], ['POST', `/${ta.team.id}/settings`, { name: 'x' }]]) {
    assert.equal((await call(m, T + p, { token: out.token, body })).status, 404, `${m} ${p} by a stranger`);
    assert.equal((await call(m, T + p, { token: b.token, body })).status, 404, `${m} ${p} by team B's secretary`);
  }
  assert.equal((await call('GET', `${T}/zzzz`, { token: a.token })).status, 404);
  assert.equal((await call('GET', T, { token: out.token })).json.teams.length, 0);
  assert.equal((await call('GET', `${T}/${tb.team.id}`, { token: a.token })).status, 404);
});

test('secretary powers: settings, invites, revoke, remove; members cannot', async () => {
  const sec = await user(), m1 = await user(), m2 = await user();
  const t = await team(sec), tid = t.team.id, inv = await invite(sec, tid);
  const j1 = (await join(m1, inv.code, 'One')).json, j2 = (await join(m2, inv.code, 'Two')).json;
  assert.equal((await call('POST', `${T}/${tid}/settings`, { token: m1.token, body: { night: 'Mon' } })).status, 403);
  assert.equal((await call('POST', `${T}/${tid}/invites`, { token: m1.token, body: {} })).status, 403);
  assert.equal((await call('GET', `${T}/${tid}/invites`, { token: m1.token })).status, 403);
  assert.equal((await call('DELETE', `${T}/${tid}/members/${j2.memberId}`, { token: m1.token })).status, 403);
  assert.equal((await call('DELETE', `${T}/${tid}`, { token: m1.token })).status, 403);
  const st = await call('POST', `${T}/${tid}/settings`, { token: sec.token, body: { night: 'Tue', time: '19:00', name: 'Tuesday Rollers' } }); assert.equal(st.status, 200); assert.equal(st.json.team.night, 'Tue');
  assert.equal((await call('POST', `${T}/${tid}/settings`, { token: sec.token, body: { night: 'Someday' } })).status, 400);
  assert.equal((await call('POST', `${T}/${tid}/settings`, { token: sec.token, body: { time: '25:00' } })).status, 400);
  // notes: author or secretary deletes
  const n = (await call('POST', `${T}/${tid}/notes`, { token: m2.token, body: { lanes: '5 - 6', text: 'The pair hooked early on 5-6' } })).json; assert.equal(n.lanes, '5-6');
  assert.equal((await call('DELETE', `${T}/${tid}/notes/${n.id}`, { token: m1.token })).status, 403);
  // report → the secretary sees it → removes the member (their shares and notes go with them)
  await call('POST', `${T}/${tid}/shares/tags`, { token: m2.token, body: { data: { tags: ['lefty', 'league bowler'] } } });
  const rp = await call('POST', `${T}/${tid}/reports`, { token: m1.token, body: { memberId: j2.memberId, reason: 'Off-topic notes' } }); assert.equal(rp.status, 201);
  assert.equal((await call('POST', `${T}/${tid}/reports`, { token: m1.token, body: { memberId: j1.memberId } })).status, 400, 'no self-report');
  const v = await call('GET', `${T}/${tid}`, { token: sec.token }); assert.equal(v.json.reports.length, 1); assert.equal(v.json.reports[0].aboutMember, j2.memberId);
  const rm = await call('DELETE', `${T}/${tid}/members/${j2.memberId}`, { token: sec.token }); assert.equal(rm.status, 200); assert.equal(rm.json.removed, true);
  const v2 = await call('GET', `${T}/${tid}`, { token: sec.token });
  assert.equal(v2.json.members.length, 2); assert.equal(v2.json.notes.length, 0, 'removed member\u2019s notes are gone'); assert.equal(v2.json.reports.length, 0, 'reports about them are gone');
  assert.equal((await call('GET', `${T}/${tid}`, { token: m2.token })).status, 404, 'removed member can no longer read');
  // revoke
  const inv2 = await invite(sec, tid); assert.equal((await call('DELETE', `${T}/${tid}/invites/${inv2.id}`, { token: sec.token })).json.revoked, 1);
  assert.equal((await join(m2, inv2.code)).status, 410, 'revoked code refused');
  const li = await call('GET', `${T}/${tid}/invites`, { token: sec.token }); assert.ok(li.json.invites.some((i) => i.id === inv2.id && i.state === 'off')); assert.ok(!JSON.stringify(li.json).includes(inv2.code), 'codes are never listed');
  // delete the team
  assert.equal((await call('DELETE', `${T}/${tid}`, { token: sec.token })).json.deleted, 1);
  assert.equal((await call('GET', `${T}/${tid}`, { token: m1.token })).status, 404);
});

test('invite codes: wrong code, use cap, and expiry', async () => {
  const sec = await user(), a = await user(), b = await user(), t = await team(sec);
  assert.equal((await join(a, 'ABCD-EFGH')).status, 410);
  assert.equal((await join(a, 'short')).status, 400);
  const one = await invite(sec, t.team.id, { maxUses: 1, days: 1 });
  assert.equal((await join(a, one.code)).status, 201); assert.equal((await join(b, one.code)).status, 410, 'use cap');
  assert.equal((await call('POST', `${T}/${t.team.id}/invites`, { token: sec.token, body: { days: 30 } })).status, 400);
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/localhost|127\.0\.0\.1/.test(url)) { console.log('# expiry DB step skipped (TEST_DATABASE_URL not set to a local DB)'); return; }
  const { Client } = createRequire(import.meta.url)('pg'); const c = new Client({ connectionString: url }); await c.connect();
  const inv = await invite(sec, t.team.id);
  await c.query("UPDATE team_invites SET expires_at = now() - interval '1 minute' WHERE id=$1", [inv.id]); await c.end();
  assert.equal((await join(b, inv.code)).status, 410, 'expired code refused');
  const li = await call('GET', `${T}/${t.team.id}/invites`, { token: sec.token }); assert.equal(li.json.invites.find((i) => i.id === inv.id).state, 'expired');
});

test('validation and caps: share shapes, tags whitelist, text lengths', async () => {
  const sec = await user(), t = await team(sec), tid = t.team.id, s = (kind, data) => call('POST', `${T}/${tid}/shares/${kind}`, { token: sec.token, body: { data } });
  assert.equal((await s('bag', { balls: Array.from({ length: 9 }, () => ({ name: 'x' })) })).status, 400);
  assert.equal((await s('bag', { balls: [{ name: 'x'.repeat(61) }] })).status, 400);
  assert.equal((await s('bag', { balls: [{ name: 'ok', why: 'y'.repeat(81) }] })).status, 400);
  assert.equal((await s('bag', { balls: [{ name: 'Ball\u0007' }] })).status, 400);
  const extra = await s('bag', { balls: [{ name: 'Ok', role: 'Spare', why: 'Straight', secret: 'dropped' }], evil: 1 }); assert.equal(extra.status, 200); assert.ok(!JSON.stringify(extra.json).includes('dropped'), 'unknown fields are dropped');
  assert.equal((await s('tags', { tags: ['lefty', 'best bowler'] })).status, 400, 'tags come from the list only');
  assert.equal((await s('tags', { tags: ['lefty', 'coach'] })).status, 200);
  assert.equal((await s('regular', { center: 'Bowlero', nights: 7 })).json.data.days, 90);
  assert.equal((await s('regular', { center: 'Bowlero', nights: -1 })).status, 400);
  assert.equal((await s('stats', { items: [{ label: 'Nights logged', value: 12, src: 'you' }] })).status, 200);
  assert.equal((await s('stats', { items: Array.from({ length: 7 }, () => ({ label: 'a', value: '1' })) })).status, 400);
  assert.equal((await s('rank', { x: 1 })).status, 400, 'unknown share kind');
  assert.equal((await call('POST', `${T}/${tid}/notes`, { token: sec.token, body: { text: 'x'.repeat(201) } })).status, 400);
  assert.equal((await call('POST', `${T}/${tid}/notes`, { token: sec.token, body: { text: 'ok', lanes: 'lanes five' } })).status, 400);
  assert.equal((await call('POST', T, { token: sec.token, body: { name: '', displayName: 'Sam' } })).status, 400);
  assert.equal((await call('POST', T, { token: sec.token, body: { name: 'x'.repeat(41), displayName: 'Sam' } })).status, 400);
  assert.equal((await call('POST', T, { token: sec.token, body: { name: 'Ok', displayName: 'y'.repeat(31) } })).status, 400);
});

test('leaving: the secretary hands off; the last member leaving deletes the team', async () => {
  const sec = await user(), m = await user(), t = await team(sec), tid = t.team.id, inv = await invite(sec, tid);
  const j = (await join(m, inv.code)).json;
  const l = await call('DELETE', `${T}/${tid}/members/me`, { token: sec.token }); assert.equal(l.status, 200); assert.equal(l.json.handedTo, j.memberId);
  const v = await call('GET', `${T}/${tid}`, { token: m.token }); assert.equal(v.json.me.role, 'secretary');
  const l2 = await call('DELETE', `${T}/${tid}/members/me`, { token: m.token }); assert.equal(l2.json.teamDeleted, true);
});

test('account export includes my team footprint only; account delete removes it and hands off', async () => {
  const sec = await user(), m = await user(), t = await team(sec), tid = t.team.id, inv = await invite(sec, tid);
  await join(m, inv.code, 'Mate');
  await call('POST', `${T}/${tid}/shares/tags`, { token: sec.token, body: { data: { tags: ['righty'] } } });
  await call('POST', `${T}/${tid}/notes`, { token: sec.token, body: { lanes: '7-8', text: 'Fresh on 7-8' } });
  await call('POST', `${T}/${tid}/shares/bag`, { token: m.token, body: { data: { balls: [{ name: 'Mate ball' }] } } });
  const ex = await call('GET', '/api/account/export', { token: sec.token }); assert.equal(ex.status, 200);
  assert.equal(ex.json.teams.length, 1); assert.equal(ex.json.teams[0].role, 'secretary'); assert.deepEqual(ex.json.teams[0].shares[0].data, { tags: ['righty'] }); assert.equal(ex.json.teams[0].notes[0].lanes, '7-8');
  assert.ok(!JSON.stringify(ex.json).includes('Mate ball'), 'a teammate\u2019s share is not in my export');
  const d = await call('DELETE', '/api/account', { token: sec.token, body: { password: sec.password } }); assert.equal(d.status, 200); assert.equal(d.json.deleted.teamMemberships, 1);
  made.splice(made.indexOf(sec), 1);
  const v = await call('GET', `${T}/${tid}`, { token: m.token }); assert.equal(v.status, 200); assert.equal(v.json.me.role, 'secretary', 'handed off'); assert.equal(v.json.members.length, 1); assert.equal(v.json.notes.length, 0);
});

test('moderation v2: report a shared item, hide and un-hide (Undo) a member or a note, nothing is deleted', async () => {
  const sec = await user(), a = await user(), b = await user(), out = await user();
  const t = await team(sec), tid = t.team.id, code = (await invite(sec, tid)).code;
  const ja = (await join(a, code, 'Alex')).json, jb = (await join(b, code, 'Blake')).json;
  await call('POST', `${T}/${tid}/shares/tags`, { token: a.token, body: { data: { tags: ['coach'] } } });
  await call('POST', `${T}/${tid}/shares/bag`, { token: a.token, body: { data: { title: 'Tonight', balls: [{ name: 'Phaze II', role: 'Benchmark', why: '' }] } } });
  const n1 = (await call('POST', `${T}/${tid}/notes`, { token: a.token, body: { lanes: '5-6', text: 'Hooks early' } })).json;
  const n2 = (await call('POST', `${T}/${tid}/notes`, { token: b.token, body: { text: 'Fine note' } })).json;
  const view = (u) => call('GET', `${T}/${tid}`, { token: u.token });
  const v0 = await view(b); assert.equal(v0.json.moderation, 2, 'the view advertises moderation v2 so the app can gate its buttons');

  // report one shared item: kind must be a real item and needs a member
  assert.equal((await call('POST', `${T}/${tid}/reports`, { token: b.token, body: { memberId: ja.memberId, kind: 'bag', reason: 'Not about bowling' } })).status, 201);
  assert.equal((await call('POST', `${T}/${tid}/reports`, { token: b.token, body: { memberId: ja.memberId, kind: 'photos' } })).status, 400, 'unknown item kind');
  assert.equal((await call('POST', `${T}/${tid}/reports`, { token: b.token, body: { kind: 'bag' } })).status, 400, 'item needs a member');
  assert.equal((await call('POST', `${T}/${tid}/reports`, { token: b.token, body: { noteId: n1.id, kind: 'bag' } })).status, 400, 'a note report has no item kind');
  const vs = await view(sec); assert.equal(vs.json.reports.length, 1); assert.equal(vs.json.reports[0].kind, 'bag'); assert.equal(vs.json.reports[0].aboutMember, ja.memberId);

  // only the secretary can hide; not a stranger, not a member, not yourself
  for (const [who, expect] of [[b, 403], [a, 403], [out, 404]]) assert.equal((await call('POST', `${T}/${tid}/members/${ja.memberId}/hide`, { token: who.token, body: { hidden: true } })).status, expect, 'hide by non-secretary');
  assert.equal((await call('POST', `${T}/${tid}/members/${ja.memberId}/hide`, { token: sec.token, body: {} })).status, 400, 'hidden must be a boolean');
  assert.equal((await call('POST', `${T}/${tid}/members/${t.memberId}/hide`, { token: sec.token, body: { hidden: true } })).status, 400, 'the secretary cannot hide themself');
  assert.equal((await call('POST', `${T}/${tid}/members/${'f'.repeat(16)}/hide`, { token: sec.token, body: { hidden: true } })).status, 404, 'unknown member');
  assert.equal((await call('POST', `${T}/${tid}/notes/${n1.id}/hide`, { token: b.token, body: { hidden: true } })).status, 403);

  // hide Alex: teammates see an empty card and no notes; the secretary and Alex still see what happened
  const h = await call('POST', `${T}/${tid}/members/${ja.memberId}/hide`, { token: sec.token, body: { hidden: true } }); assert.equal(h.status, 200); assert.equal(h.json.hidden, true);
  const vb = (await view(b)).json, ca = vb.members.find((m) => m.memberId === ja.memberId);
  assert.deepEqual(ca.shares, {}); assert.equal(ca.hidden, undefined, 'teammates are not told why'); assert.equal(ca.displayName, 'Alex');
  assert.deepEqual(vb.notes.map((n) => n.id), [n2.id], 'a hidden member\u2019s notes are withheld');
  const vsec = (await view(sec)).json; assert.equal(vsec.members.find((m) => m.memberId === ja.memberId).hidden, true); assert.ok(vsec.members.find((m) => m.memberId === ja.memberId).shares.bag, 'the secretary still sees it to decide');
  const va = (await view(a)).json; assert.equal(va.me.hidden, true); assert.equal(va.members.find((m) => m.memberId === ja.memberId).hidden, true); assert.ok(va.members.find((m) => m.memberId === ja.memberId).shares.tags, 'the owner keeps seeing their own items');
  // Undo: everything comes back, because nothing was deleted
  assert.equal((await call('POST', `${T}/${tid}/members/${ja.memberId}/hide`, { token: sec.token, body: { hidden: false } })).json.hidden, false);
  const vb2 = (await view(b)).json; assert.ok(vb2.members.find((m) => m.memberId === ja.memberId).shares.bag); assert.equal(vb2.notes.length, 2);
  assert.equal((await view(a)).json.me.hidden, false);

  // hide one note only, then Undo
  assert.equal((await call('POST', `${T}/${tid}/notes/${n1.id}/hide`, { token: sec.token, body: { hidden: true } })).status, 200);
  assert.deepEqual((await view(b)).json.notes.map((n) => n.id), [n2.id]);
  assert.equal((await view(sec)).json.notes.find((n) => n.id === n1.id).hidden, true);
  assert.equal((await view(a)).json.notes.some((n) => n.id === n1.id), false, 'a hidden note is hidden from its author too');
  assert.equal((await call('POST', `${T}/${tid}/notes/${n1.id}/hide`, { token: sec.token, body: { hidden: false } })).status, 200);
  assert.equal((await view(b)).json.notes.length, 2);
  assert.equal((await call('POST', `${T}/${tid}/notes/999999999/hide`, { token: sec.token, body: { hidden: true } })).status, 404);

  // hiding does not delete: the account export for Alex says so, and removing is still the permanent step
  await call('POST', `${T}/${tid}/members/${ja.memberId}/hide`, { token: sec.token, body: { hidden: true } });
  const ex = await call('GET', '/api/account/export', { token: a.token }); assert.equal(ex.json.teams[0].hiddenByTeam, true); assert.equal(ex.json.teams[0].shares.length, 2);
  assert.equal((await call('DELETE', `${T}/${tid}/members/${ja.memberId}`, { token: sec.token })).json.removed, true);
  assert.equal((await view(b)).json.members.length, 3 - 1);
  assert.equal(jb.role, 'member');
});
