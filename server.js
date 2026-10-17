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
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '20kb' }));

// ---- validation helpers
const str = (v, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') return required ? null : '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
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
  const b = req.body || {};
  const ballId = str(b.ballId, 64, { required: true }), name = str(b.name, 60, { required: true });
  if (!ballId) return bad(res, 'ballId required (max 64)');
  if (!name) return bad(res, 'name required (max 60)');
  const release = num(b.release, 0, 40), aim = num(b.aim, -20, 20), speed = num(b.speed, 5, 30), rev = num(b.rev, 0, 800), oil = num(b.oil, 0, 5);
  for (const [k, v] of Object.entries({ release, aim, speed, rev, oil })) if (Number.isNaN(v)) return bad(res, `invalid ${k}`);
  const finish = str(b.finish, 24), pattern = str(b.pattern, 24), note = str(b.note, 200);
  if (finish === null || pattern === null || note === null) return bad(res, 'finish/pattern/note too long or invalid');
  const { rows } = await pool.query(
    `INSERT INTO lines (ball_id,name,release,aim,speed,rev,oil,finish,pattern,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (ball_id,name) DO UPDATE SET release=$3,aim=$4,speed=$5,rev=$6,oil=$7,finish=$8,pattern=$9,note=$10,updated_at=now()
     RETURNING *`, [ballId, name, release, aim, speed, rev, oil, finish, pattern, note]);
  res.status(201).json(lineOut(rows[0]));
}));
app.get('/api/lines', wrap(async (req, res) => {
  const ballId = str(req.query.ballId, 64);
  if (ballId === null) return bad(res, 'invalid ballId');
  const { rows } = ballId
    ? await pool.query('SELECT * FROM lines WHERE ball_id=$1 ORDER BY updated_at DESC LIMIT 100', [ballId])
    : await pool.query('SELECT * FROM lines ORDER BY updated_at DESC LIMIT 200');
  res.json(rows.map(lineOut));
}));
app.delete('/api/lines/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return bad(res, 'invalid id');
  const r = await pool.query('DELETE FROM lines WHERE id=$1', [id]);
  res.json({ deleted: r.rowCount });
}));

app.post('/api/surface-log', wrap(async (req, res) => {
  const b = req.body || {};
  const ballId = str(b.ballId, 64, { required: true }), finish = str(b.finish, 24, { required: true }), date = str(b.date, 10, { required: true });
  if (!ballId || !finish) return bad(res, 'ballId and finish required');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return bad(res, 'date must be YYYY-MM-DD');
  const { rows } = await pool.query('INSERT INTO surface_log (ball_id,date,finish) VALUES ($1,$2,$3) RETURNING *', [ballId, date, finish]);
  const r = rows[0];
  res.status(201).json({ id: r.id, ballId: r.ball_id, date: String(b.date), finish: r.finish });
}));
app.get('/api/surface-log', wrap(async (req, res) => {
  const ballId = str(req.query.ballId, 64);
  if (ballId === null) return bad(res, 'invalid ballId');
  const q = `SELECT id, ball_id, to_char(date,'YYYY-MM-DD') AS date, finish FROM surface_log`;
  const { rows } = ballId
    ? await pool.query(q + ' WHERE ball_id=$1 ORDER BY date DESC, id DESC LIMIT 50', [ballId])
    : await pool.query(q + ' ORDER BY date DESC, id DESC LIMIT 100');
  res.json(rows.map((r) => ({ id: r.id, ballId: r.ball_id, date: r.date, finish: r.finish })));
}));

app.post('/api/pattern-notes', wrap(async (req, res) => {
  const b = req.body || {};
  const lane = str(b.lane, 10, { required: true }), oil = str(b.oil, 40, { required: true }), adjustment = str(b.adjustment, 300, { required: true });
  if (!lane || !oil || !adjustment) return bad(res, 'lane (<=10), oil (<=40), adjustment (<=300) required');
  const { rows } = await pool.query('INSERT INTO pattern_notes (lane,oil,adjustment) VALUES ($1,$2,$3) RETURNING *', [lane, oil, adjustment]);
  const r = rows[0];
  res.status(201).json({ id: r.id, lane: r.lane, oil: r.oil, adjustment: r.adjustment, createdAt: r.created_at });
}));
app.get('/api/pattern-notes', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM pattern_notes ORDER BY id DESC LIMIT 50');
  res.json(rows.map((r) => ({ id: r.id, lane: r.lane, oil: r.oil, adjustment: r.adjustment, createdAt: r.created_at })));
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'body too large' });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'invalid JSON' });
  console.error(err); res.status(500).json({ error: 'server error' });
});

app.listen(PORT, '0.0.0.0', () => console.log('listening on', PORT));
initDb();
