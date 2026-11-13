#!/usr/bin/env node
// Refresh data/usbc_approved.json from the USBC Approved Ball List PDF (https://bowl.com/approved-ball-list; robots allows it).
// Usage: pdftotext -layout approved_balllist_CURRENT.pdf list.txt && node scripts/usbc_refresh.mjs list.txt 2026-11-10
// Run by hand (the PDF is updated weekly; the lookup only needs it roughly current). Never run from the web server.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseUsbc } from './usbc_parse.mjs';
const [txt, listDate] = process.argv.slice(2);
if (!txt || !/^\d{4}-\d{2}-\d{2}$/.test(listDate || '')) { console.error('usage: usbc_refresh.mjs list.txt YYYY-MM-DD(list date printed on the PDF)'); process.exit(1); }
const rows = parseUsbc(readFileSync(txt, 'utf8')); if (rows.length < 3000) { console.error('parsed only', rows.length, 'rows; refusing to overwrite'); process.exit(1); }
writeFileSync(new URL('../data/usbc_approved.json', import.meta.url), JSON.stringify({ source: 'https://bowl.com/getmedia/8b570e80-761c-4486-8628-9d50d718dd60/approved_balllist_CURRENT.pdf', page: 'https://bowl.com/approved-ball-list', listDate,
  readOn: new Date().toISOString().slice(0, 10), note: 'USBC Approved Ball List: brand, ball name, date approved (ISO; month-only dates stay YYYY-MM). Facts only. Refresh with scripts/usbc_refresh.mjs.', rows: rows.map(x => [x.brand, x.name, x.approved]) }));
console.log('wrote', rows.length, 'rows');
