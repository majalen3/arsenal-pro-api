'use strict';
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
});
pool.on('error', (e) => console.error('pool error', e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dbReady = false;

async function initDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS lines (
          id SERIAL PRIMARY KEY,
          ball_id TEXT NOT NULL, name TEXT NOT NULL,
          release REAL, aim REAL, speed REAL, rev REAL, oil REAL,
          finish TEXT, pattern TEXT, note TEXT DEFAULT '',
          created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
          UNIQUE (ball_id, name)
        );
        CREATE TABLE IF NOT EXISTS surface_log (
          id SERIAL PRIMARY KEY, ball_id TEXT NOT NULL, date DATE NOT NULL,
          finish TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS pattern_notes (
          id SERIAL PRIMARY KEY, lane TEXT NOT NULL, oil TEXT NOT NULL,
          adjustment TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
        );
        ALTER TABLE lines ADD COLUMN IF NOT EXISTS oil REAL;
        ALTER TABLE lines ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE surface_log ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE pattern_notes ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE lines DROP CONSTRAINT IF EXISTS lines_ball_id_name_key;
        CREATE UNIQUE INDEX IF NOT EXISTS lines_dev_ball_name ON lines (device_id, ball_id, name);
        CREATE INDEX IF NOT EXISTS surface_dev ON surface_log (device_id, ball_id);
        CREATE INDEX IF NOT EXISTS notes_dev ON pattern_notes (device_id, id);
        CREATE TABLE IF NOT EXISTS events (
          device_id TEXT NOT NULL, id TEXT NOT NULL, seq BIGSERIAL, ts BIGINT NOT NULL,
          type TEXT NOT NULL, entity TEXT, entity_id TEXT, schema_v INT, data JSONB,
          src TEXT, prov JSONB, import_id TEXT, created_at TIMESTAMPTZ DEFAULT now(),
          PRIMARY KEY (device_id, id)
        );
        CREATE INDEX IF NOT EXISTS events_dev_seq ON events (device_id, seq);
        ALTER TABLE events ADD COLUMN IF NOT EXISTS src_seq BIGINT;
      `);
      dbReady = true;
      console.log('database ready');
      return;
    } catch (e) {
      console.error(`db init attempt ${attempt} failed: ${e.message}`);
      await sleep(Math.min(30000, 2000 * attempt));
    }
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id',
    'Access-Control-Expose-Headers': 'Retry-After, X-Next-Before',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { if (req.path !== '/api/health') console.log(JSON.stringify({ m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0 })); }); next(); });
app.use(express.json({ limit: '20kb' }));

// ---- per-device identity + rate limiting (in-memory; fine for a single free instance)
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const buckets = new Map();
function hit(key, limit, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now - b.t0 > windowMs) { b = { t0: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= limit ? 0 : Math.ceil((b.t0 + windowMs - now) / 1000);
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t0 > 120000) buckets.delete(k); }, 60000).unref();
const LIMITS = { ip: +(process.env.RL_IP || 600), device: +(process.env.RL_DEVICE || 120), write: +(process.env.RL_WRITE || 40) };
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  let wait = hit('ip:' + req.ip, LIMITS.ip, 60000);
  const dev = req.get('x-device-id');
  if (!wait && dev && DEVICE_RE.test(dev)) {
    wait = hit('d:' + dev, LIMITS.device, 60000);
    if (!wait && req.method !== 'GET') wait = hit('w:' + dev, LIMITS.write, 60000);
  }
  if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: 'too many requests', retryAfter: wait }); }
  next();
});
const needDevice = (req, res, next) => {
  const d = req.get('x-device-id');
  if (!d || !DEVICE_RE.test(d)) return res.status(400).json({ error: 'X-Device-Id header required (8-64 chars A-Za-z0-9_-)' });
  req.device = d; next();
};
app.use('/api/me', needDevice); app.use('/api/lines', needDevice); app.use('/api/surface-log', needDevice); app.use('/api/pattern-notes', needDevice); app.use('/api/events', needDevice);
const QUOTA = { lines: 300, surface: 500, notes: 200, events: +(process.env.EVENT_QUOTA || 5000) };
const EVENT_BATCH_MAX = 500, EVENT_DATA_MAX = 8000;

// ---- validation helpers
const str = (v, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') return required ? null : '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (s.includes('\u0000')) return null;
  if (required && !s) return null;
  return s.length > max ? null : s;
};
const num = (v, min, max) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
};
const bad = (res, msg) => res.status(400).json({ error: msg });
const wrap = (fn) => async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'database not ready, retry shortly' });
  try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
};

app.get('/', (req, res) => res.json({ service: 'arsenal-pro-api', health: '/api/health' }));
app.get('/api/health', async (req, res) => {
  let db = false;
  try { await pool.query('SELECT 1'); db = true; } catch (e) {}
  res.status(200).json({ ok: true, db, ready: dbReady, time: new Date().toISOString() });
});

const lineOut = (r) => ({ id: r.id, ballId: r.ball_id, name: r.name, release: r.release, aim: r.aim, speed: r.speed, rev: r.rev, oil: r.oil, finish: r.finish, pattern: r.pattern, note: r.note, updatedAt: r.updated_at });

app.post('/api/lines', wrap(async (req, res) => {
  const b = req.body; if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(res, 'JSON object body required');
  const ballId = str(b.ballId, 64, { required: true }), name = str(b.name, 60, { required: true });
  if (!ballId) return bad(res, 'ballId required (max 64)');
  if (!name) return bad(res, 'name required (max 60)');
  const release = num(b.release, 0, 40), aim = num(b.aim, -20, 20), speed = num(b.speed, 5, 30), rev = num(b.rev, 0, 800), oil = num(b.oil, 0, 5);
  for (const [k, v] of Object.entries({ release, aim, speed, rev, oil })) if (Number.isNaN(v)) return bad(res, `invalid ${k}`);
  const finish = str(b.finish, 24), pattern = str(b.pattern, 24), note = str(b.note, 200);
  if (finish === null || pattern === null || note === null) return bad(res, 'finish/pattern/note too long or invalid');
  const exists = await pool.query('SELECT 1 FROM lines WHERE device_id=$1 AND ball_id=$2 AND name=$3', [req.device, ballId, name]);
  if (!exists.rowCount) { const c = await pool.query('SELECT count(*)::int AS n FROM lines WHERE device_id=$1', [req.device]); if (c.rows[0].n >= QUOTA.lines) return res.status(429).json({ error: 'saved line limit reached (300); delete some' }); }
  const { rows } = await pool.query(
    `INSERT INTO lines (device_id,ball_id,name,release,aim,speed,rev,oil,finish,pattern,note) VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (device_id,ball_id,name) DO UPDATE SET release=$3,aim=$4,speed=$5,rev=$6,oil=$7,finish=$8,pattern=$9,note=$10,updated_at=now()
     RETURNING *`, [ballId, name, release, aim, speed, rev, oil, finish, pattern, note, req.device]);
  res.status(201).json(lineOut(rows[0]));
}));
app.get('/api/lines', wrap(async (req, res) => {
  const ballId = str(req.query.ballId, 64);
  if (ballId === null) return bad(res, 'invalid ballId');
  const { rows } = ballId
    ? await pool.query('SELECT * FROM lines WHERE device_id=$2 AND ball_id=$1 ORDER BY updated_at DESC LIMIT 100', [ballId, req.device])
    : await pool.query('SELECT * FROM lines WHERE device_id=$1 ORDER BY updated_at DESC LIMIT 200', [req.device]);
  res.json(rows.map(lineOut));
}));
app.delete('/api/lines/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) return bad(res, 'invalid id');
  const r = await pool.query('DELETE FROM lines WHERE id=$1 AND device_id=$2', [id, req.device]);
  res.json({ deleted: r.rowCount });
}));

app.post('/api/surface-log', wrap(async (req, res) => {
  const b = req.body; if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(res, 'JSON object body required');
  const ballId = str(b.ballId, 64, { required: true }), finish = str(b.finish, 24, { required: true }), date = str(b.date, 10, { required: true });
  if (!ballId || !finish) return bad(res, 'ballId and finish required');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return bad(res, 'date must be YYYY-MM-DD');
  const c = await pool.query('SELECT count(*)::int AS n FROM surface_log WHERE device_id=$1', [req.device]);
  if (c.rows[0].n >= QUOTA.surface) return res.status(429).json({ error: 'surface log limit reached (500)' });
  const { rows } = await pool.query('INSERT INTO surface_log (device_id,ball_id,date,finish) VALUES ($4,$1,$2,$3) RETURNING *', [ballId, date, finish, req.device]);
  const r = rows[0];
  res.status(201).json({ id: r.id, ballId: r.ball_id, date: String(b.date), finish: r.finish });
}));
app.get('/api/surface-log', wrap(async (req, res) => {
  const ballId = str(req.query.ballId, 64);
  if (ballId === null) return bad(res, 'invalid ballId');
  const q = `SELECT id, ball_id, to_char(date,'YYYY-MM-DD') AS date, finish FROM surface_log`;
  const { rows } = ballId
    ? await pool.query(q + ' WHERE device_id=$2 AND ball_id=$1 ORDER BY date DESC, id DESC LIMIT 50', [ballId, req.device])
    : await pool.query(q + ' WHERE device_id=$1 ORDER BY date DESC, id DESC LIMIT 100', [req.device]);
  res.json(rows.map((r) => ({ id: r.id, ballId: r.ball_id, date: r.date, finish: r.finish })));
}));

app.post('/api/pattern-notes', wrap(async (req, res) => {
  const b = req.body; if (!b || typeof b !== 'object' || Array.isArray(b)) return bad(res, 'JSON object body required');
  const lane = str(b.lane, 10, { required: true }), oil = str(b.oil, 40, { required: true }), adjustment = str(b.adjustment, 300, { required: true });
  if (!lane || !oil || !adjustment) return bad(res, 'lane (<=10), oil (<=40), adjustment (<=300) required');
  const c = await pool.query('SELECT count(*)::int AS n FROM pattern_notes WHERE device_id=$1', [req.device]);
  if (c.rows[0].n >= QUOTA.notes) return res.status(429).json({ error: 'pattern note limit reached (200)' });
  const { rows } = await pool.query('INSERT INTO pattern_notes (device_id,lane,oil,adjustment) VALUES ($4,$1,$2,$3) RETURNING *', [lane, oil, adjustment, req.device]);
  const r = rows[0];
  res.status(201).json({ id: r.id, lane: r.lane, oil: r.oil, adjustment: r.adjustment, createdAt: r.created_at });
}));
app.get('/api/pattern-notes', wrap(async (req, res) => {
  // Paged: ?before=<id>&limit=<1..200>. With no params the response is the newest 50, as before. Next page: X-Next-Before header.
  const limit = req.query.limit === undefined ? 50 : num(req.query.limit, 1, 200), before = req.query.before === undefined ? null : num(req.query.before, 1, 2147483647);
  if (Number.isNaN(limit) || limit === null || Number.isNaN(before) || !Number.isInteger(limit) || (before !== null && !Number.isInteger(before))) return bad(res, 'limit must be 1-200 and before a note id');
  const { rows } = await pool.query('SELECT * FROM pattern_notes WHERE device_id=$1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [req.device, before, limit + 1]);
  const more = rows.length > limit; if (more) rows.pop();
  if (more) res.set('X-Next-Before', String(rows[rows.length - 1].id));
  res.json(rows.map((r) => ({ id: r.id, lane: r.lane, oil: r.oil, adjustment: r.adjustment, createdAt: r.created_at })));
}));

// ---- v2 event log sync (additive; v1 endpoints unchanged). Idempotent by (device_id, id).
const TYPE_RE = /^[a-zA-Z]+\.[a-zA-Z]+$/;
function eventIn(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (typeof e.id !== 'string' || !e.id || e.id.length > 80 || e.id.includes('\u0000')) return null;
  if (typeof e.type !== 'string' || e.type.length > 60 || !TYPE_RE.test(e.type)) return null;
  if (!Number.isSafeInteger(e.ts) || e.ts < 0) return null;
  const opt = (v, max) => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= max && !v.includes('\u0000') ? v : undefined);
  const entityId = opt(e.entityId, 200), src = opt(e.deviceId, 64), importId = opt(e.importId, 80);
  if (entityId === undefined || src === undefined || importId === undefined) return null;
  const obj = (v) => (v === undefined || v === null ? null : typeof v === 'object' && !Array.isArray(v) ? v : undefined);
  const data = obj(e.data), prov = obj(e.prov);
  if (data === undefined || prov === undefined) return null;
  const dj = JSON.stringify(data); if (dj.length > EVENT_DATA_MAX || dj.includes('\\u0000')) return null;
  const sv = e.schemaV === undefined || e.schemaV === null ? null : Number.isInteger(e.schemaV) && e.schemaV >= 0 && e.schemaV < 1000 ? e.schemaV : undefined;
  if (sv === undefined) return null;
  const srcSeq = e.seq === undefined || e.seq === null ? null : Number.isSafeInteger(e.seq) && e.seq >= 0 ? e.seq : undefined;
  if (srcSeq === undefined) return null;
  return { id: e.id, srcSeq, ts: e.ts, type: e.type, entity: e.type.split('.')[0], entityId, sv, data: dj, src, prov: prov === null ? null : JSON.stringify(prov), importId };
}
// seq = the writing phone's own sequence (part of the envelope, used to order same-ms events); serverSeq = cursor order.
const eventOut = (r) => ({ id: r.id, seq: r.src_seq === null ? undefined : Number(r.src_seq), serverSeq: String(r.seq), ts: Number(r.ts), type: r.type, entity: r.entity, entityId: r.entity_id, schemaV: r.schema_v, data: r.data, deviceId: r.src, prov: r.prov || undefined, importId: r.import_id || undefined });
app.post('/api/events', wrap(async (req, res) => {
  const list = req.body && req.body.events;
  if (!Array.isArray(list) || !list.length) return bad(res, 'body must be {events:[...]} with at least one event');
  if (list.length > EVENT_BATCH_MAX) return bad(res, `at most ${EVENT_BATCH_MAX} events per batch`);
  const evs = list.map(eventIn); const i = evs.indexOf(null);
  if (i >= 0) return bad(res, `event ${i} is invalid (id <=80 chars, type "entity.verb", integer ts, object data <=${EVENT_DATA_MAX} chars)`);
  const ids = [...new Set(evs.map((e) => e.id))];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.device]);
    const known = (await c.query('SELECT id FROM events WHERE device_id=$1 AND id = ANY($2)', [req.device, ids])).rows.map((r) => r.id);
    const fresh = ids.length - known.length;
    const stored = Number((await c.query('SELECT count(*) AS n FROM events WHERE device_id=$1', [req.device])).rows[0].n);
    if (fresh && stored + fresh > QUOTA.events) {
      await c.query('ROLLBACK');
      return res.status(429).json({ error: `event quota reached: this backup code can store ${QUOTA.events} events on the server (${stored} stored). Everything stays on your phone; download a backup from More to keep a copy.`, quota: QUOTA.events, stored });
    }
    let accepted = 0;
    for (const e of evs) {
      const r = await c.query('INSERT INTO events (device_id,id,ts,type,entity,entity_id,schema_v,data,src,prov,import_id,src_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12) ON CONFLICT (device_id,id) DO NOTHING',
        [req.device, e.id, e.ts, e.type, e.entity, e.entityId, e.sv, e.data, e.src, e.prov, e.importId, e.srcSeq]);
      accepted += r.rowCount;
    }
    const cur = (await c.query('SELECT COALESCE(max(seq),0) AS s FROM events WHERE device_id=$1', [req.device])).rows[0].s;
    await c.query('COMMIT');
    res.status(200).json({ accepted, duplicates: evs.length - accepted, cursor: String(cur), stored: stored + accepted, quota: QUOTA.events });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));
app.get('/api/events', wrap(async (req, res) => {
  const after = req.query.after === undefined ? 0 : /^\d{1,18}$/.test(String(req.query.after)) ? String(req.query.after) : null;
  const limit = req.query.limit === undefined ? 500 : num(req.query.limit, 1, 500);
  if (after === null || Number.isNaN(limit) || !Number.isInteger(limit)) return bad(res, 'after must be a cursor from a previous response and limit 1-500');
  const { rows } = await pool.query('SELECT * FROM events WHERE device_id=$1 AND seq > $2 ORDER BY seq LIMIT $3', [req.device, after, limit + 1]);
  const more = rows.length > limit; if (more) rows.pop();
  res.json({ events: rows.map(eventOut), cursor: rows.length ? String(rows[rows.length - 1].seq) : String(after), more });
}));

app.get('/api/me', wrap(async (req, res) => {
  const [l, sl, n, ev] = await Promise.all([
    pool.query('SELECT * FROM lines WHERE device_id=$1 ORDER BY id', [req.device]),
    pool.query("SELECT ball_id, to_char(date,'YYYY-MM-DD') AS date, finish FROM surface_log WHERE device_id=$1 ORDER BY id", [req.device]),
    pool.query('SELECT lane, oil, adjustment FROM pattern_notes WHERE device_id=$1 ORDER BY id', [req.device]),
    pool.query('SELECT * FROM events WHERE device_id=$1 ORDER BY seq', [req.device])]);
  res.json({ exportedAt: new Date().toISOString(), lines: l.rows.map(lineOut), surfaceLog: sl.rows.map((r) => ({ ballId: r.ball_id, date: r.date, finish: r.finish })), patternNotes: n.rows, events: ev.rows.map(eventOut) });
}));
app.delete('/api/me', wrap(async (req, res) => {
  const out = {};
  for (const t of ['lines', 'surface_log', 'pattern_notes', 'events']) out[t] = (await pool.query(`DELETE FROM ${t} WHERE device_id=$1`, [req.device])).rowCount;
  res.json({ deleted: out });
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'invalid JSON' });
  console.error(err); res.status(500).json({ error: 'server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log('listening on', PORT));
process.on('SIGTERM', () => { console.log('SIGTERM, closing'); server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); });
initDb();
