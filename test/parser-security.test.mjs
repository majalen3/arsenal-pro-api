import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {gzipSync,deflateSync} from 'node:zlib';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('supported body-parser patch preserves valid compressed JSON/20kb limit and survives malformed trailing bytes',{timeout:15000},async()=>{
 const expressRequire=createRequire(require.resolve('express'));
 const version=expressRequire('body-parser/package.json').version.split('.').map(Number);
 assert.ok(version[0]===1 && (version[1]>20 || version[1]===20 && version[2]>=9),'patched supported1.x, not a forced major upgrade');
 const child=fork(new URL('../scripts/parser-fixture.mjs',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});
 try {
  const [{port}]=await once(child,'message');const base='http://127.0.0.1:'+port;
  const send=(body,encoding='gzip')=>fetch(base+'/parse',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':encoding},body});
  for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync]]){
   const r=await send(compress(Buffer.from('{"synthetic":"ok"}')),encoding);assert.equal(r.status,200);assert.deepEqual(await r.json(),{synthetic:'ok'});
  }
  assert.equal((await send(gzipSync(Buffer.from(JSON.stringify({text:'x'.repeat(21000)}))))).status,413);
  for(const body of [Buffer.from('not gzip'),Buffer.concat([gzipSync(Buffer.from('{}')),Buffer.from('trailing-invalid-bytes')])]){
   const r=await send(body);assert.ok(r.status>=400 && r.status<500);await r.text();
   assert.equal((await fetch(base+'/health')).status,200,'parser process remains responsive');assert.equal(child.exitCode,null);
  }
 } finally {const exit=once(child,'exit');child.send('stop');await exit;}
});
