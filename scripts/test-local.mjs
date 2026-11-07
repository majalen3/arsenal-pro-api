// Starts only against an explicitly disposable EMPTY loopback PostgreSQL database.
// Does not create/drop a database, fetch credentials, or modify production config.
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { fixtureEnv } from './test-fixture.mjs';
const env = fixtureEnv(process.env), client = new pg.Client({ connectionString:env.DATABASE_URL, ssl:false, connectionTimeoutMillis:5000 });
try {
  await client.connect();
  const {rows} = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  if (rows.length) throw Error('Test database is not empty. Refusing to start or overwrite it; use a new disposable database.');
} finally { await client.end(); }
const server = spawn(process.execPath, ['server.js'], {env,stdio:'inherit'});
const exited = () => server.exitCode !== null || server.signalCode !== null;
let tests;
try {
  let ready = false;
  for (let n=0;n<100;n++) {
    if (exited()) throw Error('Fixture server exited before readiness.');
    try { const r=await fetch(env.BASE+'/api/health'); const j=await r.json(); if (j.db && j.ready) {ready=true;break;} } catch (_) {}
    await wait(100);
  }
  if (!ready) throw Error('Isolated test server did not become ready.');
  tests = spawn('npm', ['test'], {env,stdio:'inherit'});
  const code = await new Promise((resolve,reject)=>{tests.on('error',reject);tests.on('exit',(code)=>resolve(code??1));});
  process.exitCode = code;
} finally {
  if (tests && tests.exitCode === null) tests.kill('SIGTERM');
  server.kill('SIGTERM');
  await new Promise(resolve=>{if(exited())resolve();else server.once('exit',resolve);});
}
