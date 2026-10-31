'use strict';
// Account crypto helpers. Node built-ins only (no native deps, no new service).
// Passwords and recovery keys: scrypt (N=16384, r=8, p=1, 32-byte key, 16-byte salt), compared in constant time.
// Sessions: 32 random bytes sent once to the app as a bearer token; the DB keeps only HMAC-SHA256(token, SESSION_PEPPER),
// so a database leak alone does not yield usable tokens. Losing or rotating the pepper only signs everyone out.
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
const scrypt = (pw, salt, o = SCRYPT) => new Promise((res, rej) => crypto.scrypt(pw, salt, KEYLEN, o, (e, k) => (e ? rej(e) : res(k))));

async function hashSecret(pw) {
  const salt = crypto.randomBytes(16);
  const k = await scrypt(String(pw).normalize('NFKC'), salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${k.toString('base64')}`;
}
async function verifySecret(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') { await scrypt('x', 'dummy-salt-dummy'); return false; }
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// Equalise timing when the email is unknown (no account enumeration by response time).
let DUMMY = null;
async function burn(pw) { if (!DUMMY) DUMMY = await hashSecret('not-a-real-password'); await verifySecret(pw, DUMMY); }

const newToken = () => crypto.randomBytes(32).toString('base64url');
const newUserId = () => crypto.randomBytes(12).toString('hex');
const tokenHash = (token, pepper) => crypto.createHmac('sha256', pepper).update(String(token)).digest('hex');
// Recovery key: 20 chars from an unambiguous alphabet, shown once at sign-up, grouped for copying (ABCD-EFGH-...).
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryKey() {
  const b = crypto.randomBytes(20); let s = '';
  for (let i = 0; i < 20; i++) s += ALPHA[b[i] % ALPHA.length];
  return s.match(/.{4}/g).join('-');
}
const normRecovery = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
function normEmail(e) {
  if (typeof e !== 'string') return null;
  const s = e.trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) && !s.includes('\u0000') ? s : null;
}
// NIST 800-63B style: length is what matters; no composition rules. 8..200 chars.
function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'password required';
  if (pw.includes('\u0000')) return 'invalid password';
  if ([...pw].length < 8) return 'password must be at least 8 characters';
  if (pw.length > 200) return 'password must be at most 200 characters';
  return null;
}
const bearer = (req) => { const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || ''); return m ? m[1] : null; };

module.exports = { hashSecret, verifySecret, burn, newToken, newUserId, tokenHash, newRecoveryKey, normRecovery, normEmail, passwordProblem, bearer };
