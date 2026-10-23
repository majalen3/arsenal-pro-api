'use strict';
// Guarded, server-side fetch of manufacturer spec pages. Allowlisted hosts only, https only, redirects re-checked,
// size + time caps, robots.txt honoured (incl. Crawl-delay), one identifying User-Agent, nothing stored but parsed fields.
const dns = require('dns').promises;
const net = require('net');

const UA = 'ArsenalProSpecLookup/1.0 (+https://majalen3.github.io/arsenal-pro-bowling/; ball spec lookup on user request)';
const UA_TOKEN = 'arsenalprospeclookup';
const MAX_BYTES = 1_500_000, TIMEOUT_MS = 8000, MAX_REDIRECTS = 3, MAX_DELAY_WAIT = 10_000;

// Brand → host + discovery strategy. Hosts here are the ONLY hosts the API will ever fetch.
const BRANDS = [
  { key: 'storm', names: ['storm'], host: 'www.stormbowling.com', strategy: 'storm', prefix: 'storm' },
  { key: 'roto grip', names: ['roto grip', 'rotogrip', 'roto-grip'], host: 'www.stormbowling.com', strategy: 'storm', prefix: 'roto-grip' },
  { key: '900 global', names: ['900 global', '900global', '900-global'], host: 'www.stormbowling.com', strategy: 'storm', prefix: '900-global' },
  { key: 'brunswick', names: ['brunswick'], host: 'brunswickbowling.com', strategy: 'craft' },
  { key: 'radical', names: ['radical'], host: 'radicalbowling.com', strategy: 'craft' },
  { key: 'dv8', names: ['dv8'], host: 'dv8bowling.com', strategy: 'craft' },
  { key: 'hammer', names: ['hammer'], host: 'hammerbowling.com', strategy: 'shopify' },
  { key: 'ebonite', names: ['ebonite'], host: 'ebonite.com', strategy: 'shopify' },
  { key: 'track', names: ['track'], host: 'trackbowling.com', strategy: 'shopify' },
  { key: 'columbia 300', names: ['columbia 300', 'columbia', 'columbia300'], host: 'columbia300.com', strategy: 'shopify' },
  { key: 'motiv', names: ['motiv'], host: null, strategy: 'unsupported', why: "Motiv's site refuses automated requests (HTTP 403), so specs can't be looked up there." },
];
const ALLOWED_HOSTS = new Set(BRANDS.filter((b) => b.host).flatMap((b) => [b.host, b.host.replace(/^www\./, '')]));
const brandOf = (s) => { const k = String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); return BRANDS.find((b) => b.names.includes(k)) || null; };
const brandForHost = (host) => BRANDS.find((b) => b.host && (b.host === host || b.host.replace(/^www\./, '') === host)) || null;

function checkUrl(u) {
  let url; try { url = new URL(u); } catch (e) { return { ok: false, why: 'not a URL' }; }
  if (url.protocol !== 'https:') return { ok: false, why: 'https only' };
  if (url.username || url.password) return { ok: false, why: 'credentials in URL' };
  if (url.port && url.port !== '443') return { ok: false, why: 'non-standard port' };
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, why: 'host not on the manufacturer allowlist' };
  return { ok: true, url };
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

// ---- robots.txt (cached 24 h per host)
const robotsCache = new Map(), lastHit = new Map();
function parseRobots(txt) {
  const groups = []; let cur = null, lastWasUA = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasUA || !cur) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasUA = true; continue; }
    lastWasUA = false; if (!cur) continue;
    if (k === 'disallow' || k === 'allow') cur.rules.push({ allow: k === 'allow', path: v });
    else if (k === 'crawl-delay') { const d = parseFloat(v); if (Number.isFinite(d)) cur.delay = Math.max(cur.delay || 0, d); }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { rules: use.flatMap((g) => g.rules), delay: use.reduce((d, g) => Math.max(d, g.delay || 0), 0) };
}
function robotsAllows(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function rawFetch(url, { accept = 'text/html,application/xhtml+xml,application/xml;q=0.9' } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: accept } });
    let body = '';
    if (r.status >= 200 && r.status < 300 && r.body) {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let n = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX_BYTES) { ctl.abort(); throw Object.assign(new Error('response too large'), { code: 'TOO_LARGE' }); } body += dec.decode(value, { stream: true }); }
    } else if (r.body) { try { await r.body.cancel(); } catch (e) {} }
    return { status: r.status, location: r.headers.get('location'), type: r.headers.get('content-type') || '', body };
  } finally { clearTimeout(t); }
}

async function getRobots(host) {
  const c = robotsCache.get(host); if (c && Date.now() - c.at < 86_400_000) return c.robots;
  let robots = { rules: [], delay: 0 };
  try { const r = await rawFetch(`https://${host}/robots.txt`, { accept: 'text/plain' }); if (r.status === 200) robots = parseRobots(r.body); else if (r.status === 401 || r.status === 403) robots = { rules: [{ allow: false, path: '/' }], delay: 0 }; } catch (e) {}
  robotsCache.set(host, { at: Date.now(), robots }); return robots;
}

// Fetch one allowlisted URL. Every hop is re-checked against the allowlist, DNS must resolve to public addresses,
// robots.txt must allow the path, and Crawl-delay is honoured per host (waits up to 10 s, else "busy").
async function guardedFetch(u, opts = {}) {
  let cur = u;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const c = checkUrl(cur); if (!c.ok) return { ok: false, status: 'blocked', why: c.why, url: cur };
    const host = c.url.hostname.toLowerCase();
    const addrs = await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return { ok: false, status: 'blocked', why: 'host did not resolve to a public address', url: cur };
    const robots = await getRobots(host);
    if (!robotsAllows(robots, c.url.pathname + c.url.search)) return { ok: false, status: 'blocked', why: "the maker's robots.txt disallows this page", url: cur };
    const wait = (lastHit.get(host) || 0) + robots.delay * 1000 - Date.now();
    if (wait > MAX_DELAY_WAIT) return { ok: false, status: 'busy', why: 'maker site asks for a slower pace; try again shortly', url: cur, retryAfter: Math.ceil(wait / 1000) };
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(host, Date.now());
    const r = await rawFetch(c.url.href, opts);
    if (r.status >= 300 && r.status < 400 && r.location) { cur = new URL(r.location, c.url).href; continue; }
    return { ok: r.status === 200, status: r.status, url: c.url.href, body: r.body, type: r.type };
  }
  return { ok: false, status: 'blocked', why: 'too many redirects', url: cur };
}

// ---- discovery: name → candidate product URLs on the maker's own site
const NOISE = new Set(['bowling', 'ball', 'balls', 'retired', 'products', 'the', 'storm', 'roto', 'grip', '900', 'global', 'brunswick', 'radical', 'dv8', 'hammer', 'ebonite', 'track', 'columbia', '300', 'and']);
const tokens = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t && !NOISE.has(t));
function score(qt, ct) {
  if (!qt.length || !ct.length) return 0;
  if (qt.join(' ') === ct.join(' ')) return 1;
  const pool = ct.slice(); let inter = 0; for (const t of qt) { const i = pool.indexOf(t); if (i >= 0) { inter++; pool.splice(i, 1); } }
  return Math.min(0.99, (2 * inter) / (qt.length + ct.length)); // multiset Dice; only an exact ordered match scores 1
}
const sitemapCache = new Map();
async function sitemapUrls(brand) {
  const c = sitemapCache.get(brand.key); if (c && Date.now() - c.at < 86_400_000) return c.urls;
  const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  let urls = [];
  if (brand.strategy === 'craft') {
    const r = await guardedFetch(`https://${brand.host}/sitemaps-1-section-bowlerProducts-1-sitemap.xml`, { accept: 'application/xml' });
    if (r.ok) urls = locs(r.body).filter((u) => /\/balls?\//.test(u));
  } else if (brand.strategy === 'shopify') {
    const idx = await guardedFetch(`https://${brand.host}/sitemap.xml`, { accept: 'application/xml' });
    if (idx.ok) for (const sm of locs(idx.body).filter((u) => /sitemap_products_\d+\.xml/.test(u)).slice(0, 3)) {
      const r = await guardedFetch(sm, { accept: 'application/xml' }); if (r.ok) urls.push(...locs(r.body).filter((u) => /\/products\//.test(u)));
    }
  }
  if (urls.length) sitemapCache.set(brand.key, { at: Date.now(), urls });
  return urls;
}
const slugOf = (u) => decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
async function discover(brand, name) {
  const qt = tokens(name);
  if (brand.strategy === 'storm') {
    const slug = qt.join('-');
    return [{ url: `https://${brand.host}/${brand.prefix}-${slug}-bowling-ball`, label: name, score: 1, template: true }];
  }
  const urls = await sitemapUrls(brand);
  return urls.map((u) => ({ url: u, label: slugOf(u).replace(/-/g, ' '), score: score(qt, tokens(slugOf(u))) }))
    .filter((c) => c.score >= 0.4).sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, 6);
}

module.exports = { BRANDS, ALLOWED_HOSTS, UA, brandOf, brandForHost, checkUrl, isPrivateIp, parseRobots, robotsAllows, guardedFetch, discover, tokens, score, _caches: { robotsCache, lastHit, sitemapCache } };
