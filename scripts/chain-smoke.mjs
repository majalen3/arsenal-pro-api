// Live smoke of the source chain (network, no DB): node scripts/chain-smoke.mjs "Brand|Name|https://maker/url-to-try-in-the-archive" ...
// Polite: the same guarded fetch the server uses (robots.txt, per-host gaps). Prints per-field source types. Writes nothing.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CH = require('../lib/specchain.js');
for (const arg of process.argv.slice(2)) {
  const [brand, name, url] = arg.split('|');
  const r = await CH.runChain({ brand, name, maker: { status: 'not-found', why: 'smoke: maker step skipped', tried: url }, makerUrls: url ? [url] : [] });
  console.log(`\n== ${brand} ${name}  status=${r.status}  types=${(r.sourceTypes || []).join(',')}`);
  console.log(r.chain.map(c => `${c.step}:${c.outcome}${c.why ? ' (' + c.why + ')' : ''}`).join('  |  '));
  for (const [k, f] of Object.entries(r.fields || {})) console.log(`  ${k} = ${JSON.stringify(f.v)}  [${f.src.type}] ${f.src.url}`);
  if (r.weights) console.log('  weights', JSON.stringify(r.weights), r.weightsSrc && r.weightsSrc.type);
  if (r.usbc) console.log('  usbc', r.usbc.v, r.usbc.dates.join(','));
}
