'use strict';
// My Team (community hub, 2026-10-31; arsenal-pro-bowling docs/TEAM_PROMPT_COMMUNITY_DIRECTOR.md). Additive tables only.
// Rules this file enforces server-side:
//  - Every route needs a signed-in account (needUser) and sits under /api/account/, so the account CORS allowlist applies.
//  - A team is visible only to its members; a non-member gets 404 (no existence leak). Secretary-only actions check the role.
//  - Members are addressed by a per-team member id, never by account id or email; teammates never see an email.
//  - The server stores only what a member chose to share (one row per kind); it computes nothing about anyone.
//  - Invite codes are random, stored only as an HMAC, expire (1-14 days), can be revoked and have a use cap.
//  - Text caps, JSON size caps, member/team/note/invite caps and per-user rate limits.
//  - Leaving, being removed, or deleting the account removes that member's shares, notes and reports; a secretary who
//    leaves hands the role to the longest-standing member, and a team with no members left is deleted.
const crypto = require('crypto');

const SQL = `
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, night TEXT NOT NULL DEFAULT '', night_time TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member',
    display_name TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (team_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS team_members_user ON team_members (user_id);
  CREATE TABLE IF NOT EXISTS team_invites (
    id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
    uses INT NOT NULL DEFAULT 0, max_uses INT NOT NULL DEFAULT 30
  );
  CREATE INDEX IF NOT EXISTS team_invites_team ON team_invites (team_id);
  CREATE TABLE IF NOT EXISTS team_shares (
    member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE, kind TEXT NOT NULL, data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (member_id, kind)
  );
  CREATE TABLE IF NOT EXISTS team_notes (
    id BIGSERIAL PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE, lanes TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS team_notes_team ON team_notes (team_id, id);
  CREATE TABLE IF NOT EXISTS team_reports (
    id BIGSERIAL PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    reporter TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    about_member TEXT REFERENCES team_members(id) ON DELETE CASCADE, note_id BIGINT REFERENCES team_notes(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS team_reports_team ON team_reports (team_id);
`;

const CAPS = {
  teamsPerUser: +(process.env.TEAM_MAX_PER_USER || 10), membersPerTeam: +(process.env.TEAM_MAX_MEMBERS || 40),
  notesPerTeam: +(process.env.TEAM_MAX_NOTES || 300), invitesPerTeam: 10, reportsPerTeam: 100, shareBytes: 2000,
};
const RL = {
  create: [+(process.env.RL_TEAM_CREATE || 5), 86400e3], joinUser: [+(process.env.RL_TEAM_JOIN || 10), 900e3], joinIp: [+(process.env.RL_TEAM_JOIN_IP || 30), 900e3],
  invite: [20, 3600e3], note: [30, 3600e3], report: [10, 3600e3],
};
const NIGHTS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
const TAGS = ['two-hander', 'one-hander', 'lefty', 'righty', 'youth', 'senior', 'adaptive', 'collector', 'coach', 'league bowler'];
const KINDS = ['bag', 'stats', 'tags', 'regular'];
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += ALPHA[b[i] % ALPHA.length]; return s.slice(0, 4) + '-' + s.slice(4); };
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const rid = (n) => crypto.randomBytes(n).toString('hex');
const PAIR_RE = /^\d{1,3}(-\d{1,3})?$/;

// Plain text: trimmed, no control characters, length-capped (null = invalid).
function text(v, max, { required = false } = {}) {
  if (v === undefined || v === null) return required ? null : '';
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (required && !s) return null;
  return [...s].length > max ? null : s;
}
// Share payloads: strict shapes, so a share can only ever carry what the app shows.
function cleanShare(kind, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  let out = null;
  if (kind === 'bag') {
    if (!Array.isArray(d.balls) || d.balls.length > 8) return null;
    const balls = [];
    for (const b of d.balls) {
      if (!b || typeof b !== 'object') return null;
      const name = text(b.name, 60, { required: true }), role = text(b.role, 24), why = text(b.why, 80);
      if (name === null || role === null || why === null) return null;
      balls.push({ name, role, why });
    }
    const title = text(d.title, 40); if (title === null) return null;
    out = { title, balls };
  } else if (kind === 'stats') {
    if (!Array.isArray(d.items) || d.items.length > 6) return null;
    const items = [];
    for (const it of d.items) {
      if (!it || typeof it !== 'object') return null;
      const label = text(it.label, 40, { required: true }), value = text(String(it.value == null ? '' : it.value), 40, { required: true }), src = text(it.src, 20);
      if (label === null || value === null || src === null) return null;
      items.push({ label, value, src });
    }
    out = { items };
  } else if (kind === 'tags') {
    if (!Array.isArray(d.tags) || d.tags.length > TAGS.length || d.tags.some((t) => !TAGS.includes(t))) return null;
    out = { tags: [...new Set(d.tags)] };
  } else if (kind === 'regular') {
    const center = text(d.center, 60, { required: true }), nights = Number(d.nights);
    if (center === null || !Number.isInteger(nights) || nights < 0 || nights > 200) return null;
    out = { center, nights, days: 90 };
  }
  return out && Buffer.byteLength(JSON.stringify(out)) <= CAPS.shareBytes ? out : null;
}

// One member leaves (or is removed, or deletes the account): hand off the secretary role, drop their footprint,
// delete the team if nobody is left. Runs inside the caller's transaction.
async function leave(c, m) {
  await c.query('DELETE FROM team_members WHERE id=$1', [m.id]);   // cascades: shares, notes, reports by/about them
  const left = await c.query('SELECT id, role FROM team_members WHERE team_id=$1 ORDER BY joined_at, id', [m.team_id]);
  if (!left.rowCount) { await c.query('DELETE FROM teams WHERE id=$1', [m.team_id]); return { teamDeleted: true }; }
  if (m.role === 'secretary' && !left.rows.some((r) => r.role === 'secretary')) {
    await c.query("UPDATE team_members SET role='secretary' WHERE id=$1", [left.rows[0].id]);
    return { teamDeleted: false, handedTo: left.rows[0].id };
  }
  return { teamDeleted: false };
}
async function deleteUserTeams(c, userId) {
  const ms = await c.query('SELECT * FROM team_members WHERE user_id=$1', [userId]); let n = 0;
  for (const m of ms.rows) { await leave(c, m); n++; }
  return n;
}
async function exportUserTeams(pool, userId) {
  const ms = (await pool.query('SELECT m.*, t.name AS team_name, t.night, t.night_time FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY m.joined_at', [userId])).rows;
  const out = [];
  for (const m of ms) {
    const [sh, no, rp] = await Promise.all([
      pool.query('SELECT kind, data, updated_at FROM team_shares WHERE member_id=$1 ORDER BY kind', [m.id]),
      pool.query('SELECT id, lanes, text, created_at FROM team_notes WHERE member_id=$1 ORDER BY id', [m.id]),
      pool.query('SELECT id, about_member, note_id, reason, created_at FROM team_reports WHERE reporter=$1 ORDER BY id', [m.id])]);
    out.push({ team: { id: m.team_id, name: m.team_name, night: m.night, time: m.night_time }, memberId: m.id, role: m.role, displayName: m.display_name, joinedAt: m.joined_at,
      shares: sh.rows.map((r) => ({ kind: r.kind, data: r.data, updatedAt: r.updated_at })),
      notes: no.rows.map((r) => ({ id: String(r.id), lanes: r.lanes, text: r.text, createdAt: r.created_at })),
      reports: rp.rows.map((r) => ({ id: String(r.id), aboutMember: r.about_member, noteId: r.note_id && String(r.note_id), reason: r.reason, createdAt: r.created_at })) });
  }
  return out;
}

function mount(app, { pool, needUser, wrap, hit, limited, bad, body, pepper }) {
  const P = '/api/account/teams';
  const codeHash = (code) => crypto.createHmac('sha256', pepper()).update('invite:' + normCode(code)).digest('hex');
  const teamOut = (t) => ({ id: t.id, name: t.name, night: t.night, time: t.night_time, createdAt: t.created_at });
  const rl = (res, key, [n, ms]) => { const w = hit(key, n, ms); if (w) { limited(res, w); return true; } return false; };
  const tx = async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); } };
  const notFound = (res) => res.status(404).json({ error: 'team not found' });
  const ID_RE = /^[a-f0-9]{8,32}$/;
  // Membership gate: loads req.member for :tid or answers 404; { sec: true } also needs the secretary role (403).
  const member = (opts = {}) => wrap(async (req, res, next) => {
    const tid = req.params.tid; if (!ID_RE.test(tid || '')) return notFound(res);
    const r = await pool.query('SELECT * FROM team_members WHERE team_id=$1 AND user_id=$2', [tid, req.user.id]);
    if (!r.rowCount) return notFound(res);
    req.member = r.rows[0];
    if (opts.sec && req.member.role !== 'secretary') return res.status(403).json({ error: 'only the league secretary can do this' });
    next();
  });
  const nightOf = (b) => {
    const night = b.night === undefined ? undefined : NIGHTS.includes(b.night) ? b.night : null;
    const time = b.time === undefined ? undefined : b.time === '' ? '' : typeof b.time === 'string' && TIME_RE.test(b.time) ? b.time : null;
    return { night, time };
  };

  app.get(P, needUser, wrap(async (req, res) => {
    const r = await pool.query(`SELECT t.*, m.role, m.id AS member_id, m.display_name, (SELECT count(*)::int FROM team_members x WHERE x.team_id=t.id) AS n
      FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY m.joined_at`, [req.user.id]);
    res.json({ teams: r.rows.map((t) => ({ ...teamOut(t), role: t.role, memberId: t.member_id, displayName: t.display_name, members: t.n })) });
  }));
  app.post(P, needUser, wrap(async (req, res) => {
    const b = body(req), name = text(b.name, 40, { required: true }), dn = text(b.displayName, 30, { required: true }), { night, time } = nightOf(b);
    if (!name) return bad(res, 'team name required (1-40 characters)');
    if (!dn) return bad(res, 'your display name is required (1-30 characters)');
    if (night === null || time === null) return bad(res, 'league night must be Mon-Sun and time HH:MM');
    const n = (await pool.query('SELECT count(*)::int AS n FROM team_members WHERE user_id=$1', [req.user.id])).rows[0].n;
    if (n >= CAPS.teamsPerUser) return res.status(409).json({ error: `you are on ${CAPS.teamsPerUser} teams already; leave one first` });
    if (rl(res, 'tc:' + req.user.id, RL.create)) return;
    const id = rid(8), mid = rid(8);
    const t = await tx(async (c) => {
      const t = (await c.query('INSERT INTO teams (id, name, night, night_time) VALUES ($1,$2,$3,$4) RETURNING *', [id, name, night || '', time || ''])).rows[0];
      await c.query("INSERT INTO team_members (id, team_id, user_id, role, display_name) VALUES ($1,$2,$3,'secretary',$4)", [mid, id, req.user.id, dn]);
      return t;
    });
    res.status(201).json({ team: teamOut(t), memberId: mid, role: 'secretary' });
  }));
  app.post(P + '/join', needUser, wrap(async (req, res) => {
    const b = body(req), code = normCode(b.code), dn = text(b.displayName, 30, { required: true });
    if (code.length !== 8) return bad(res, 'invite code is 8 letters and numbers (XXXX-XXXX)');
    if (!dn) return bad(res, 'your display name is required (1-30 characters)');
    if (rl(res, 'tj:' + req.user.id, RL.joinUser) || rl(res, 'tji:' + req.ip, RL.joinIp)) return;
    const out = await tx(async (c) => {
      const inv = (await c.query('SELECT * FROM team_invites WHERE code_hash=$1 FOR UPDATE', [codeHash(code)])).rows[0];
      if (!inv || inv.revoked_at || new Date(inv.expires_at) <= new Date() || inv.uses >= inv.max_uses) return { status: 410, json: { error: 'this invite has expired or was turned off; ask the secretary for a new one' } };
      const mine = (await c.query('SELECT id, role FROM team_members WHERE team_id=$1 AND user_id=$2', [inv.team_id, req.user.id])).rows[0];
      const t = (await c.query('SELECT * FROM teams WHERE id=$1', [inv.team_id])).rows[0];
      if (mine) return { status: 200, json: { team: teamOut(t), memberId: mine.id, role: mine.role, already: true } };
      const n = (await c.query('SELECT count(*)::int AS n FROM team_members WHERE user_id=$1', [req.user.id])).rows[0].n;
      if (n >= CAPS.teamsPerUser) return { status: 409, json: { error: `you are on ${CAPS.teamsPerUser} teams already; leave one first` } };
      const size = (await c.query('SELECT count(*)::int AS n FROM team_members WHERE team_id=$1', [inv.team_id])).rows[0].n;
      if (size >= CAPS.membersPerTeam) return { status: 409, json: { error: `this team is full (${CAPS.membersPerTeam} members)` } };
      const mid = rid(8);
      await c.query("INSERT INTO team_members (id, team_id, user_id, role, display_name) VALUES ($1,$2,$3,'member',$4)", [mid, inv.team_id, req.user.id, dn]);
      await c.query('UPDATE team_invites SET uses=uses+1 WHERE id=$1', [inv.id]);
      return { status: 201, json: { team: teamOut(t), memberId: mid, role: 'member' } };
    });
    res.status(out.status).json(out.json);
  }));
  app.get(P + '/:tid', needUser, member(), wrap(async (req, res) => {
    const tid = req.params.tid, sec = req.member.role === 'secretary';
    const [t, ms, sh, no, rp] = await Promise.all([
      pool.query('SELECT * FROM teams WHERE id=$1', [tid]),
      pool.query('SELECT id, role, display_name, joined_at FROM team_members WHERE team_id=$1 ORDER BY joined_at, id', [tid]),
      pool.query('SELECT s.member_id, s.kind, s.data, s.updated_at FROM team_shares s JOIN team_members m ON m.id=s.member_id WHERE m.team_id=$1', [tid]),
      pool.query('SELECT id, member_id, lanes, text, created_at FROM team_notes WHERE team_id=$1 ORDER BY id DESC LIMIT 100', [tid]),
      sec ? pool.query('SELECT id, reporter, about_member, note_id, reason, created_at FROM team_reports WHERE team_id=$1 ORDER BY id DESC LIMIT 50', [tid]) : { rows: [] }]);
    const shares = {}; for (const s of sh.rows) (shares[s.member_id] = shares[s.member_id] || {})[s.kind] = { data: s.data, updatedAt: s.updated_at };
    res.json({ team: teamOut(t.rows[0]), me: { memberId: req.member.id, role: req.member.role, displayName: req.member.display_name },
      members: ms.rows.map((m) => ({ memberId: m.id, displayName: m.display_name, role: m.role, joinedAt: m.joined_at, shares: shares[m.id] || {} })),
      notes: no.rows.map((n) => ({ id: String(n.id), memberId: n.member_id, lanes: n.lanes, text: n.text, createdAt: n.created_at })),
      reports: sec ? rp.rows.map((r) => ({ id: String(r.id), reporter: r.reporter, aboutMember: r.about_member, noteId: r.note_id && String(r.note_id), reason: r.reason, createdAt: r.created_at })) : undefined });
  }));
  app.post(P + '/:tid/settings', needUser, member({ sec: true }), wrap(async (req, res) => {
    const b = body(req), name = b.name === undefined ? undefined : text(b.name, 40, { required: true }), { night, time } = nightOf(b);
    if (name === null) return bad(res, 'team name required (1-40 characters)');
    if (night === null || time === null) return bad(res, 'league night must be Mon-Sun and time HH:MM');
    const t = (await pool.query('UPDATE teams SET name=COALESCE($2,name), night=COALESCE($3,night), night_time=COALESCE($4,night_time), updated_at=now() WHERE id=$1 RETURNING *',
      [req.params.tid, name === undefined ? null : name, night === undefined ? null : night, time === undefined ? null : time])).rows[0];
    res.json({ team: teamOut(t) });
  }));
  app.post(P + '/:tid/me', needUser, member(), wrap(async (req, res) => {
    const dn = text(body(req).displayName, 30, { required: true }); if (!dn) return bad(res, 'display name required (1-30 characters)');
    await pool.query('UPDATE team_members SET display_name=$2 WHERE id=$1', [req.member.id, dn]); res.json({ displayName: dn });
  }));
  // Invites (secretary). The code is returned once; the server keeps only its HMAC.
  app.post(P + '/:tid/invites', needUser, member({ sec: true }), wrap(async (req, res) => {
    const b = body(req), days = b.days === undefined ? 7 : Number(b.days), uses = b.maxUses === undefined ? 30 : Number(b.maxUses);
    if (!Number.isInteger(days) || days < 1 || days > 14) return bad(res, 'days must be 1-14');
    if (!Number.isInteger(uses) || uses < 1 || uses > CAPS.membersPerTeam) return bad(res, `maxUses must be 1-${CAPS.membersPerTeam}`);
    const live = (await pool.query('SELECT count(*)::int AS n FROM team_invites WHERE team_id=$1 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses', [req.params.tid])).rows[0].n;
    if (live >= CAPS.invitesPerTeam) return res.status(409).json({ error: `${CAPS.invitesPerTeam} invites are open; turn one off first` });
    if (rl(res, 'ti:' + req.user.id, RL.invite)) return;
    const code = newCode(), id = rid(6), exp = new Date(Date.now() + days * 86400e3);
    await pool.query('INSERT INTO team_invites (id, team_id, code_hash, expires_at, max_uses) VALUES ($1,$2,$3,$4,$5)', [id, req.params.tid, codeHash(code), exp, uses]);
    res.status(201).json({ id, code, expiresAt: exp.toISOString(), maxUses: uses });
  }));
  app.get(P + '/:tid/invites', needUser, member({ sec: true }), wrap(async (req, res) => {
    const r = await pool.query('SELECT id, created_at, expires_at, revoked_at, uses, max_uses FROM team_invites WHERE team_id=$1 ORDER BY created_at DESC LIMIT 30', [req.params.tid]);
    const now = new Date();
    res.json({ invites: r.rows.map((i) => ({ id: i.id, createdAt: i.created_at, expiresAt: i.expires_at, uses: i.uses, maxUses: i.max_uses,
      state: i.revoked_at ? 'off' : new Date(i.expires_at) <= now ? 'expired' : i.uses >= i.max_uses ? 'used up' : 'open' })) });
  }));
  app.delete(P + '/:tid/invites/:iid', needUser, member({ sec: true }), wrap(async (req, res) => {
    const r = await pool.query('UPDATE team_invites SET revoked_at=now() WHERE id=$1 AND team_id=$2 AND revoked_at IS NULL', [String(req.params.iid).slice(0, 32), req.params.tid]);
    res.json({ revoked: r.rowCount });
  }));
  // Shares: one row per kind per member; the bowler switches each one on or off.
  app.post(P + '/:tid/shares/:kind', needUser, member(), wrap(async (req, res) => {
    const kind = req.params.kind; if (!KINDS.includes(kind)) return bad(res, 'unknown share kind');
    const data = cleanShare(kind, body(req).data); if (!data) return bad(res, `invalid ${kind} share (shape or size)`);
    const r = await pool.query('INSERT INTO team_shares (member_id, kind, data) VALUES ($1,$2,$3) ON CONFLICT (member_id, kind) DO UPDATE SET data=EXCLUDED.data, updated_at=now() RETURNING updated_at', [req.member.id, kind, data]);
    res.json({ kind, data, updatedAt: r.rows[0].updated_at });
  }));
  app.delete(P + '/:tid/shares/:kind', needUser, member(), wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM team_shares WHERE member_id=$1 AND kind=$2', [req.member.id, String(req.params.kind).slice(0, 16)]);
    res.json({ deleted: r.rowCount });
  }));
  // Lane-pair notes: any member writes; the author or the secretary deletes.
  app.post(P + '/:tid/notes', needUser, member(), wrap(async (req, res) => {
    const b = body(req), t = text(b.text, 200, { required: true }), lanes = b.lanes === undefined || b.lanes === '' ? '' : String(b.lanes).trim().replace(/\s*[-–&/]\s*/g, '-');
    if (!t) return bad(res, 'note text required (1-200 characters)');
    if (lanes && !PAIR_RE.test(lanes)) return bad(res, 'lanes look like 5-6');
    const n = (await pool.query('SELECT count(*)::int AS n FROM team_notes WHERE team_id=$1', [req.params.tid])).rows[0].n;
    if (n >= CAPS.notesPerTeam) return res.status(409).json({ error: `this team has ${CAPS.notesPerTeam} notes; delete old ones first` });
    if (rl(res, 'tn:' + req.member.id, RL.note)) return;
    const r = await pool.query('INSERT INTO team_notes (team_id, member_id, lanes, text) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [req.params.tid, req.member.id, lanes, t]);
    res.status(201).json({ id: String(r.rows[0].id), memberId: req.member.id, lanes, text: t, createdAt: r.rows[0].created_at });
  }));
  app.delete(P + '/:tid/notes/:nid', needUser, member(), wrap(async (req, res) => {
    const nid = /^\d{1,15}$/.test(req.params.nid) ? req.params.nid : null; if (!nid) return bad(res, 'invalid note id');
    const sec = req.member.role === 'secretary';
    const r = await pool.query(`DELETE FROM team_notes WHERE id=$1 AND team_id=$2 ${sec ? '' : 'AND member_id=$3'}`, sec ? [nid, req.params.tid] : [nid, req.params.tid, req.member.id]);
    if (!r.rowCount) return res.status(sec ? 404 : 403).json({ error: sec ? 'note not found' : 'only the author or the secretary can delete this note' });
    res.json({ deleted: 1 });
  }));
  // Reports go to the secretary only; the secretary removes the member or the note, or dismisses the report.
  app.post(P + '/:tid/reports', needUser, member(), wrap(async (req, res) => {
    const b = body(req), reason = text(b.reason, 200); if (reason === null) return bad(res, 'reason is at most 200 characters');
    const about = b.memberId ? String(b.memberId) : null, note = b.noteId ? String(b.noteId) : null;
    if (!about && !note) return bad(res, 'say which member or note');
    if (about && (!ID_RE.test(about) || !(await pool.query('SELECT 1 FROM team_members WHERE id=$1 AND team_id=$2', [about, req.params.tid])).rowCount)) return bad(res, 'member not on this team');
    if (about === req.member.id) return bad(res, 'you cannot report yourself');
    if (note && (!/^\d{1,15}$/.test(note) || !(await pool.query('SELECT 1 FROM team_notes WHERE id=$1 AND team_id=$2', [note, req.params.tid])).rowCount)) return bad(res, 'note not on this team');
    const n = (await pool.query('SELECT count(*)::int AS n FROM team_reports WHERE team_id=$1', [req.params.tid])).rows[0].n;
    if (n >= CAPS.reportsPerTeam) return res.status(409).json({ error: 'too many open reports on this team' });
    if (rl(res, 'tr:' + req.member.id, RL.report)) return;
    const r = await pool.query('INSERT INTO team_reports (team_id, reporter, about_member, note_id, reason) VALUES ($1,$2,$3,$4,$5) RETURNING id', [req.params.tid, req.member.id, about, note, reason]);
    res.status(201).json({ id: String(r.rows[0].id) });
  }));
  app.delete(P + '/:tid/reports/:rid', needUser, member({ sec: true }), wrap(async (req, res) => {
    const id = /^\d{1,15}$/.test(req.params.rid) ? req.params.rid : null; if (!id) return bad(res, 'invalid report id');
    res.json({ dismissed: (await pool.query('DELETE FROM team_reports WHERE id=$1 AND team_id=$2', [id, req.params.tid])).rowCount });
  }));
  // Leave ("me") or remove (secretary). Removing takes the member's shares and notes with them.
  app.delete(P + '/:tid/members/:mid', needUser, member(), wrap(async (req, res) => {
    const self = req.params.mid === 'me' || req.params.mid === req.member.id;
    if (!self && req.member.role !== 'secretary') return res.status(403).json({ error: 'only the league secretary can remove a member' });
    const out = await tx(async (c) => {
      const m = self ? req.member : (await c.query('SELECT * FROM team_members WHERE id=$1 AND team_id=$2', [String(req.params.mid), req.params.tid])).rows[0];
      if (!m) return null;
      return leave(c, m);
    });
    if (!out) return res.status(404).json({ error: 'member not on this team' });
    res.json({ left: self, removed: !self, ...out });
  }));
  app.delete(P + '/:tid', needUser, member({ sec: true }), wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM teams WHERE id=$1', [req.params.tid]); res.json({ deleted: r.rowCount });
  }));
}

module.exports = { SQL, mount, cleanShare, deleteUserTeams, exportUserTeams, newCode, normCode, TAGS, KINDS, CAPS };
