#!/usr/bin/env node
// Weekly feedback digest as Markdown (counts, themes, top bugs, survey, opt-in usage, crash clusters).
//   FEEDBACK_ADMIN_TOKEN=<token set on Render> node scripts/feedback-digest.mjs [--days 7] [--base https://arsenal-pro-api.onrender.com] [--out digest.md]
//   node scripts/feedback-digest.mjs --from saved.json      (offline: {summary, feedback} as the two owner endpoints return them)
// Read-only: it calls GET /api/owner/summary and GET /api/owner/feedback and writes nothing to the server.
// The token comes from the environment only; it is never printed or written to the digest.
import { readFileSync, writeFileSync } from 'node:fs';

const THEMES = [
  ['Bag building', /\b(bag|pack(ed|ing)?|tonight|bring|shake)\b/i],
  ['Lane view / Optimize', /\b(lane|optimi[sz]e|line|target|aim|arrows?|board|breakpoint)\b/i],
  ['Scoring', /\b(scor(e|ing)|frames?|spares?|strikes?|pins?|split|foul)\b/i],
  ['Arsenal / Add a ball', /\b(arsenal|balls?|specs?|catalog|add a ball|rg|diff(erential)?|cover|core)\b/i],
  ['Log book', /\b(log ?book|history|average|results|nights?|session)\b/i],
  ['My Team', /\b(team(mate)?s?|league|secretary|invite)\b/i],
  ['Speed / crashes', /\b(slow|lag(gy)?|load(ing)?|freez(e|es|ing)|crash(es|ed)?|stuck|hang|blank)\b/i],
  ['Sync / account / backup', /\b(sync|backup|account|log ?in|sign ?in|password|restore)\b/i],
  ['Layout / readability', /\b(button|tap|text|font|small|scroll|dark|light|hard to (see|read)|confus(ing|ed))\b/i],
];
const esc = (s) => String(s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').replace(/[<>]/g, '').trim();
const quote = (s, n = 140) => { const t = esc(s); return t.length > n ? t.slice(0, n - 1) + '\u2026' : t; };

export function themesOf(texts) {
  const out = THEMES.map(([name, re]) => ({ name, n: 0, example: '' }));
  for (const t of texts) {
    if (!t) continue;
    out.forEach((th, i) => { if (THEMES[i][1].test(t)) { th.n++; if (!th.example) th.example = t; } });
  }
  return out.filter((t) => t.n).sort((a, b) => b.n - a.n);
}

export function digest(summary, list, { now = new Date() } = {}) {
  const fb = (list && list.feedback) || [], notes = (list && list.surveyNotes) || [];
  const byKind = summary.feedbackByKind || {};
  const survey = summary.survey || [];
  const answers = survey.reduce((a, r) => a + r.n, 0), avg = answers ? survey.reduce((a, r) => a + r.useful * r.n, 0) / answers : null;
  const L = [];
  L.push(`# Arsenal Pro feedback digest`, '');
  L.push(`Window: ${summary.since} to ${now.toISOString()}. Generated from the first-party feedback API (no third-party analytics).`, '');
  L.push('## Counts', '');
  L.push('| What | Count |', '|---|---|');
  L.push(`| Bug reports | ${byKind.bug || 0} |`, `| Ideas | ${byKind.idea || 0} |`, `| Praise | ${byKind.praise || 0} |`);
  L.push(`| Post-game survey answers | ${answers} |`);
  L.push(`| Crash clusters (distinct) | ${(summary.errors || []).length} |`);
  if (summary.totals) L.push(`| Stored overall: feedback / screenshots / survey | ${summary.totals.feedback} / ${summary.totals.shots} / ${summary.totals.survey} |`);
  L.push('');
  L.push('## Post-game survey: "How useful was tonight?"', '');
  if (!answers) L.push('No answers this window.', '');
  else {
    L.push(`Average ${avg.toFixed(2)} of 5 from ${answers} answer${answers === 1 ? '' : 's'}.`, '');
    L.push('| Rating | Answers |', '|---|---|', ...[1, 2, 3, 4, 5].map((u) => `| ${u} | ${(survey.find((r) => r.useful === u) || { n: 0 }).n} |`), '');
  }
  L.push('## Themes', '');
  const th = themesOf([...fb.map((f) => f.text), ...notes.map((n) => n.note)]);
  if (!th.length) L.push('No free text this window.', '');
  else { L.push('Keyword buckets over feedback text and survey one-liners (a note can land in more than one).', '', '| Theme | Mentions | Example |', '|---|---|---|', ...th.map((t) => `| ${t.name} | ${t.n} | "${quote(t.example)}" |`), ''); }
  L.push('## Top bugs', '');
  const bugs = fb.filter((f) => f.kind === 'bug');
  if (!bugs.length) L.push('No bug reports this window.', '');
  else {
    const byRoute = {};
    for (const b of bugs) (byRoute[b.route || '(unknown screen)'] ||= []).push(b);
    const rows = Object.entries(byRoute).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    L.push('| Screen | Reports | Latest | Builds | Screenshot |', '|---|---|---|---|---|');
    for (const [r, xs] of rows) L.push(`| ${esc(r)} | ${xs.length} | "${quote(xs[0].text || '(no text)')}" | ${[...new Set(xs.map((x) => x.build || '?'))].join(', ')} | ${xs.filter((x) => x.has_shot).map((x) => '#' + x.id).join(' ') || '-'} |`);
    L.push('');
  }
  L.push('## Crash clusters (opt-in reports)', '');
  const er = summary.errors || [];
  if (!er.length) L.push('No crash reports this window.', '');
  else { L.push('| Count | Kind | Message | Top frame | Screens | Builds |', '|---|---|---|---|---|---|');
    for (const e of er.slice(0, 10)) L.push(`| ${e.n} | ${e.kind} | ${quote(e.message, 100)} | ${quote((e.stack || '').split('\n')[0], 80) || '-'} | ${(e.routes || []).filter(Boolean).join(', ') || '-'} | ${(e.builds || []).filter(Boolean).join(', ') || '-'} |`);
    L.push(''); }
  L.push('## Opt-in usage counts', '');
  const us = summary.usage || [];
  if (!us.length) L.push('No opted-in counts this window.', '');
  else { L.push('Totals from phones that turned on anonymous usage counts (off by default). Reports = upload batches, not people.', '', '| Action | Count | Reports |', '|---|---|---|', ...us.map((u) => `| ${u.key} | ${u.n} | ${u.reports} |`), ''); }
  L.push('## Latest ideas and praise', '');
  const other = fb.filter((f) => f.kind !== 'bug' && f.text).slice(0, 10);
  if (!other.length) L.push('None this window.', '');
  else L.push(...other.map((f) => `- ${f.kind === 'idea' ? 'Idea' : 'Praise'} (${esc(f.route) || 'unknown screen'}): "${quote(f.text, 200)}"`), '');
  L.push('---', 'Screenshots: `GET /api/owner/feedback/<id>/screenshot` with the owner token. This digest contains no names, emails or device ids; the API never stores them.');
  return L.join('\n') + '\n';
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  let summary, list;
  const from = arg('--from');
  if (from) ({ summary, feedback: list } = JSON.parse(readFileSync(from, 'utf8')));
  else {
    const token = process.env.FEEDBACK_ADMIN_TOKEN;
    if (!token) { console.error('Set FEEDBACK_ADMIN_TOKEN in your shell (the same value as on Render). Nothing was fetched.'); process.exit(2); }
    const base = (arg('--base', process.env.FEEDBACK_API || 'https://arsenal-pro-api.onrender.com')).replace(/\/$/, '');
    const since = new Date(Date.now() - (+arg('--days', 7) || 7) * 86400e3).toISOString();
    const get = async (p) => { const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + token } }); if (!r.ok) throw Error(`${p}: HTTP ${r.status}${r.status === 404 ? ' (owner read is off: FEEDBACK_ADMIN_TOKEN is not set on the server)' : ''}`); return r.json(); };
    [summary, list] = await Promise.all([get('/api/owner/summary?since=' + encodeURIComponent(since)), get('/api/owner/feedback?limit=500&since=' + encodeURIComponent(since))]);
  }
  const md = digest(summary, list);
  const out = arg('--out');
  if (out) { writeFileSync(out, md); console.error('wrote ' + out); } else process.stdout.write(md);
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
