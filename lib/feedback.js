'use strict';
// First-party feedback (2026-11-21, owner t163u "Yes, build the in-app feedback tools"). Additive tables only; nothing existing changes.
// What this file accepts, and nothing else:
//  - POST /api/feedback        type (bug|idea|praise), optional text (<= 1000 chars), optional screenshot (JPEG/PNG/WebP, <= 200 KB),
//                              app build, route (path only), device class. Returns a random receipt the phone keeps so the bowler can
//                              delete what they sent (DELETE /api/feedback with {receipts}). Only an HMAC of the receipt is stored.
//  - POST /api/survey          useful 1-5 and an optional one-liner (<= 140 chars). Same receipt rule.
//  - POST /api/usage           opt-in aggregate counters: {counts:{<allow-listed key>: n}}. Summed into (day, key, build) rows; the
//                              request itself is not stored, so a row cannot be traced to a phone.
//  - POST /api/errors          opt-in crash reports, already scrubbed on the phone, scrubbed again here; aggregated by fingerprint per day.
// No device id, account, email, IP or user agent is stored by any of these routes (the in-memory rate limiter keys on IP and forgets
// it within the window). Free text is scrubbed of anything that looks like an email, phone number or URL before it is stored.
// Owner read (GET /api/owner/*) needs FEEDBACK_ADMIN_TOKEN (>= 32 chars) set in the Render dashboard. When it is unset every
// owner route answers 404, i.e. the read side is off. The repo never holds a value for it.
const crypto = require('crypto');

const SQL = `
  CREATE TABLE IF NOT EXISTS fb_feedback (
    id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', build TEXT NOT NULL DEFAULT '', route TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '', receipt_hash TEXT, has_shot BOOLEAN NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS fb_feedback_created ON fb_feedback (created_at);
  CREATE INDEX IF NOT EXISTS fb_feedback_receipt ON fb_feedback (receipt_hash);
  CREATE TABLE IF NOT EXISTS fb_shots (
    feedback_id BIGINT PRIMARY KEY REFERENCES fb_feedback(id) ON DELETE CASCADE, mime TEXT NOT NULL, bytes BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS fb_survey (
    id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), useful SMALLINT NOT NULL,
    note TEXT NOT NULL DEFAULT '', build TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', receipt_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS fb_survey_created ON fb_survey (created_at);
  CREATE INDEX IF NOT EXISTS fb_survey_receipt ON fb_survey (receipt_hash);
  CREATE TABLE IF NOT EXISTS fb_usage (
    day DATE NOT NULL, key TEXT NOT NULL, build TEXT NOT NULL DEFAULT '', n BIGINT NOT NULL DEFAULT 0, reports INT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key, build)
  );
  CREATE TABLE IF NOT EXISTS fb_errors (
    day DATE NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '',
    build TEXT NOT NULL DEFAULT '', route TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '', n INT NOT NULL DEFAULT 0,
    first_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (day, fingerprint)
  );
`;

const KINDS = ['bug', 'idea', 'praise'];
const DEVICES = ['phone', 'tablet', 'desktop', 'phone-app', 'tablet-app', 'desktop-app', ''];
// Keep in step with the app's js/cc/feedback.js USAGE_KEYS. Anything else in a usage report is ignored.
const USAGE_KEYS = ['bag.built', 'optimize.used', 'game.logged', 'feedback.sent', 'survey.answered',
  'screen.bag', 'screen.arsenal', 'screen.lane', 'screen.results', 'screen.team', 'screen.me', 'screen.add-ball'];
const CAPS = {
  text: 1000, note: 140, shotBytes: 200 * 1024, shotsTotal: +(process.env.FB_SHOTS_MAX || 300), feedbackTotal: +(process.env.FB_FEEDBACK_MAX || 5000),
  surveyTotal: +(process.env.FB_SURVEY_MAX || 20000), errorRowsPerDay: 200, usageN: 1000, message: 200, stack: 1500,
};
const LIMITS = { feedback: +(process.env.RL_FEEDBACK || 8), survey: +(process.env.RL_SURVEY || 6), usage: +(process.env.RL_USAGE || 12), errors: +(process.env.RL_ERRORS || 30), del: 10 };
const HOUR = 3600e3;

// ---- pure helpers (unit-tested in test/feedback.unit.test.mjs)
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URLISH = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE = /(?:\+?\d[\s().-]*){9,}\d/g;
function scrubText(s, max) {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(EMAIL, '[email removed]').replace(URLISH, '[link removed]').replace(PHONE, '[number removed]');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max) : t;
}
// Error text from the phone is already scrubbed; do it again so a modified client cannot store a URL, query string or quoted user text.
function scrubError(s, max) {
  if (typeof s !== 'string') return '';
  let t = s.replace(/(["'`])(?:(?!\1)[^\\\n]|\\.){0,400}\1/g, '\u2026')
    .replace(/\b(?:https?|file|blob|chrome-extension|moz-extension):\/\/[^\s)]*?([\w.-]+\.m?js)(?:\?[^\s):]*)?(:\d+:\d+)?/gi, '$1$2')
    .replace(/\b(?:https?|file|blob):\/\/\S+/gi, '[url]').replace(/\?[^\s):]*/g, '').replace(EMAIL, '[email]').replace(/\d{6,}/g, '#');
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return t.length > max ? t.slice(0, max) : t;
}
const BUILD_RE = /^v\d{1,4}$/;
const cleanBuild = (v) => (typeof v === 'string' && BUILD_RE.test(v) ? v : '');
// A route is a path shape like /bag or /ball/:id. Anything else (query strings, ids, free text) is dropped.
function cleanRoute(v) {
  if (typeof v !== 'string') return '';
  const p = v.split(/[?#]/)[0].slice(0, 40);
  return /^\/[a-z0-9\-/:]*$/.test(p) ? p : '';
}
const cleanDevice = (v) => (DEVICES.includes(v) ? v : '');
const hmac = (secret, v) => crypto.createHmac('sha256', secret).update(String(v)).digest('hex');
const newReceipt = () => crypto.randomBytes(16).toString('base64url');
const RECEIPT_RE = /^[A-Za-z0-9_-]{22}$/;
// data:image/jpeg;base64,... -> { mime, bytes } or an error string
function decodeShot(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return 'screenshot must be a data URL';
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return 'screenshot must be a JPEG, PNG or WebP data URL';
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > CAPS.shotBytes) return 'screenshot too large (200 KB max)';
  const sig = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] }[m[1]];
  if (!sig.every((b, i) => bytes[i] === b)) return 'screenshot bytes do not match its type';
  return { mime: m[1], bytes };
}
function cleanCounts(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (!USAGE_KEYS.includes(k)) continue;
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out[k] = Math.min(n, CAPS.usageN);
  }
  return out;
}
// Owner token: compare hashes in constant time. Unset or short token = owner routes off.
function ownerOk(header, token) {
  if (!token || token.length < 32) return false;
  const m = /^Bearer\s+(\S{1,256})$/.exec(header || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest(), b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

// The screenshot needs a bigger body than the global 20 kB, so POST /api/feedback is rate-limited first and then parses its own body
// (<= 300 kB). server.js mounts this BEFORE the global JSON parser.
let big = null;
function pre(req, res, next, { hit, limited, express }) {
  if (req.method !== 'POST' || req.path !== '/') return next();
  const w = hit(`fb:feedback:${req.ip}`, LIMITS.feedback, HOUR); if (w) return limited(res, w);
  (big || (big = express.json({ limit: '300kb' })))(req, res, next);
}

function mount(app, { pool, wrap, hit, limited, bad, body, secret }) {
  const ipWait = (req, name, n, windowMs = HOUR) => hit(`fb:${name}:${req.ip}`, n, windowMs);
  const obj = (req, res) => { const b = body(req); if (b !== req.body) { bad(res, 'JSON object body required'); return null; } return b; };
  const total = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  app.post('/api/feedback', wrap(async (req, res) => {
    const b = obj(req, res); if (!b) return;
    if (!KINDS.includes(b.type)) return bad(res, 'type must be bug, idea or praise');
    if (b.text != null && typeof b.text !== 'string') return bad(res, 'text must be a string');
    if (typeof b.text === 'string' && b.text.length > CAPS.text * 2) return bad(res, 'text too long (1000 characters max)');
    const shot = decodeShot(b.screenshot); if (typeof shot === 'string') return bad(res, shot);
    if (await total('fb_feedback') >= CAPS.feedbackTotal) return res.status(507).json({ error: 'feedback inbox is full; try again later' });
    const keepShot = shot && (await total('fb_shots')) < CAPS.shotsTotal;
    const receipt = newReceipt();
    const { rows } = await pool.query('INSERT INTO fb_feedback (kind,text,build,route,device,receipt_hash,has_shot) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [b.type, scrubText(b.text || '', CAPS.text), cleanBuild(b.build), cleanRoute(b.route), cleanDevice(b.device), hmac(secret(), receipt), !!keepShot]);
    if (keepShot) await pool.query('INSERT INTO fb_shots (feedback_id,mime,bytes) VALUES ($1,$2,$3)', [rows[0].id, shot.mime, shot.bytes]);
    res.status(201).json({ ok: true, receipt, screenshot: shot ? (keepShot ? 'stored' : 'dropped: screenshot storage is full') : 'none' });
  }));
  app.post('/api/survey', wrap(async (req, res) => {
    const w = ipWait(req, 'survey', LIMITS.survey); if (w) return limited(res, w);
    const b = obj(req, res); if (!b) return;
    const u = Number(b.useful);
    if (!Number.isInteger(u) || u < 1 || u > 5) return bad(res, 'useful must be 1 to 5');
    if (b.note != null && typeof b.note !== 'string') return bad(res, 'note must be a string');
    if (typeof b.note === 'string' && b.note.length > CAPS.note * 2) return bad(res, 'note too long (140 characters max)');
    if (await total('fb_survey') >= CAPS.surveyTotal) return res.status(507).json({ error: 'survey inbox is full; try again later' });
    const receipt = newReceipt();
    await pool.query('INSERT INTO fb_survey (useful,note,build,device,receipt_hash) VALUES ($1,$2,$3,$4,$5)',
      [u, scrubText(b.note || '', CAPS.note), cleanBuild(b.build), cleanDevice(b.device), hmac(secret(), receipt)]);
    res.status(201).json({ ok: true, receipt });
  }));
  app.post('/api/usage', wrap(async (req, res) => {
    const w = ipWait(req, 'usage', LIMITS.usage); if (w) return limited(res, w);
    const b = obj(req, res); if (!b) return;
    const c = cleanCounts(b.counts); if (!c) return bad(res, 'counts object required');
    const keys = Object.keys(c);
    if (!keys.length) return res.status(202).json({ ok: true, stored: 0 });
    const build = cleanBuild(b.build);
    await pool.query(`INSERT INTO fb_usage (day,key,build,n,reports) SELECT CURRENT_DATE, k, $3, v, 1 FROM unnest($1::text[], $2::bigint[]) AS t(k, v)
      ON CONFLICT (day,key,build) DO UPDATE SET n = fb_usage.n + EXCLUDED.n, reports = fb_usage.reports + 1`, [keys, keys.map((k) => c[k]), build]);
    res.status(202).json({ ok: true, stored: keys.length });
  }));
  app.post('/api/errors', wrap(async (req, res) => {
    const w = ipWait(req, 'errors', LIMITS.errors); if (w) return limited(res, w);
    const b = obj(req, res); if (!b) return;
    const kind = ['error', 'rejection', 'sw'].includes(b.kind) ? b.kind : null; if (!kind) return bad(res, 'kind must be error, rejection or sw');
    const message = scrubError(b.message, CAPS.message); if (!message) return bad(res, 'message required');
    const stack = scrubError(typeof b.stack === 'string' ? b.stack : '', CAPS.stack);
    const fp = crypto.createHash('sha256').update(kind + '\n' + message + '\n' + stack.split('\n').slice(0, 2).join('\n')).digest('hex').slice(0, 16);
    const day = await pool.query('SELECT count(*)::int AS n FROM fb_errors WHERE day = CURRENT_DATE');
    const exists = await pool.query('SELECT 1 FROM fb_errors WHERE day = CURRENT_DATE AND fingerprint=$1', [fp]);
    if (!exists.rowCount && day.rows[0].n >= CAPS.errorRowsPerDay) return res.status(202).json({ ok: true, stored: false, why: 'daily error cap reached' });
    await pool.query(`INSERT INTO fb_errors (day,fingerprint,kind,message,stack,build,route,device,n) VALUES (CURRENT_DATE,$1,$2,$3,$4,$5,$6,$7,1)
      ON CONFLICT (day,fingerprint) DO UPDATE SET n = fb_errors.n + 1, last_at = now()`, [fp, kind, message, stack, cleanBuild(b.build), cleanRoute(b.route), cleanDevice(b.device)]);
    res.status(202).json({ ok: true, stored: true, fingerprint: fp });
  }));
  // The bowler deletes what they sent, using the receipts their phone kept. No receipt, no delete (and no way to list).
  app.delete('/api/feedback', wrap(async (req, res) => {
    const w = ipWait(req, 'del', LIMITS.del); if (w) return limited(res, w);
    const b = obj(req, res); if (!b) return;
    const r = Array.isArray(b.receipts) ? b.receipts.filter((x) => typeof x === 'string' && RECEIPT_RE.test(x)).slice(0, 100) : [];
    if (!r.length) return bad(res, 'receipts required');
    const hs = r.map((x) => hmac(secret(), x));
    const f = await pool.query('DELETE FROM fb_feedback WHERE receipt_hash = ANY($1::text[])', [hs]);
    const s = await pool.query('DELETE FROM fb_survey WHERE receipt_hash = ANY($1::text[])', [hs]);
    res.json({ deleted: { feedback: f.rowCount, survey: s.rowCount } });
  }));

  // ---- owner read side (off unless FEEDBACK_ADMIN_TOKEN is set on the server)
  const owner = (req, res, next) => {
    const tok = process.env.FEEDBACK_ADMIN_TOKEN || '';
    if (tok.length < 32) return res.status(404).json({ error: 'not found' });
    const w = hit('fb:owner:' + req.ip, 60, 60000); if (w) return limited(res, w);
    if (!ownerOk(req.get('authorization'), tok)) return res.status(401).json({ error: 'owner token required' });
    next();
  };
  const since = (req) => { const d = Date.parse(req.query.since || ''); return new Date(Number.isFinite(d) ? d : Date.now() - 7 * 86400e3); };
  app.get('/api/owner/summary', owner, wrap(async (req, res) => {
    const s = since(req);
    const [fk, sv, us, er, fbn] = await Promise.all([
      pool.query('SELECT kind, count(*)::int AS n FROM fb_feedback WHERE created_at >= $1 GROUP BY kind', [s]),
      pool.query('SELECT useful, count(*)::int AS n FROM fb_survey WHERE created_at >= $1 GROUP BY useful ORDER BY useful', [s]),
      pool.query('SELECT key, sum(n)::bigint AS n, sum(reports)::int AS reports FROM fb_usage WHERE day >= $1::date GROUP BY key ORDER BY key', [s]),
      pool.query(`SELECT fingerprint, kind, message, min(stack) AS stack, sum(n)::int AS n, max(last_at) AS last_at, array_agg(DISTINCT build) AS builds, array_agg(DISTINCT route) AS routes
        FROM fb_errors WHERE day >= $1::date GROUP BY fingerprint, kind, message ORDER BY sum(n) DESC LIMIT 20`, [s]),
      pool.query('SELECT (SELECT count(*)::int FROM fb_feedback) AS feedback, (SELECT count(*)::int FROM fb_shots) AS shots, (SELECT count(*)::int FROM fb_survey) AS survey'),
    ]);
    res.json({ since: s.toISOString(), feedbackByKind: Object.fromEntries(fk.rows.map((r) => [r.kind, r.n])), survey: sv.rows,
      usage: us.rows.map((r) => ({ key: r.key, n: Number(r.n), reports: r.reports })), errors: er.rows, totals: fbn.rows[0], caps: CAPS });
  }));
  app.get('/api/owner/feedback', owner, wrap(async (req, res) => {
    const s = since(req), lim = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const [f, sv] = await Promise.all([
      pool.query('SELECT id, created_at, kind, text, build, route, device, has_shot FROM fb_feedback WHERE created_at >= $1 ORDER BY id DESC LIMIT $2', [s, lim]),
      pool.query("SELECT id, created_at, useful, note, build, device FROM fb_survey WHERE created_at >= $1 AND note <> '' ORDER BY id DESC LIMIT $2", [s, lim])]);
    res.json({ since: s.toISOString(), feedback: f.rows, surveyNotes: sv.rows });
  }));
  app.get('/api/owner/feedback/:id/screenshot', owner, wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10); if (!Number.isInteger(id) || id < 1) return bad(res, 'invalid id');
    const r = await pool.query('SELECT mime, bytes FROM fb_shots WHERE feedback_id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', r.rows[0].mime).set('Content-Disposition', `inline; filename="feedback-${id}"`).send(r.rows[0].bytes);
  }));
}

module.exports = { SQL, mount, pre, LIMITS, KINDS, USAGE_KEYS, CAPS, scrubText, scrubError, cleanRoute, cleanBuild, cleanDevice, cleanCounts, decodeShot, ownerOk };
