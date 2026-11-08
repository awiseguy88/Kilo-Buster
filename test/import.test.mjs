import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'kilo-buster-'));
process.env.KILO_BUSTER_TEST='1'; process.env.PROXY_STATE_FILE=join(dir,'state.json'); process.env.API_AUTH_TOKEN='test';
const {handler,tokenDb}=await import('../server.mjs');
async function request(method,url,body='') { const req=Readable.from(body?[body]:[]); req.method=method; req.url=url; req.headers={authorization:'Bearer test'}; let output=''; const res={headers:{},setHeader(k,v){this.headers[k]=v},writeHead(status){this.status=status;return this},end(s=''){output+=s;return this}}; await handler(req,res); return {status:res.status,body:JSON.parse(output)}; }
test('starts empty and imports only new proxy addresses',async()=>{
  const original=globalThis.fetch;
  try {
    assert.equal((await request('GET','/health/stats')).body.total,0);
    assert.equal((await request('POST','/v1/chat/completions','{"messages":[]}')).status,503);
    globalThis.fetch=async()=>new Response('user:pass@example.com:8080\rhttp://user:pass@example.com:8080\rinvalid\rother.example:3128\r');
    const first=await request('POST','/api/proxies/import'); assert.deepEqual(first.body,{added:2,duplicates:1,invalid:1,total:2});
    const second=await request('POST','/api/proxies/import'); assert.equal(second.body.added,0); assert.equal(second.body.total,2);
    globalThis.fetch=async()=>new Response('unavailable',{status:503});
    assert.equal((await request('POST','/api/proxies/import')).status,502);
    assert.equal((await request('GET','/health/stats')).body.total,2);
  } finally {globalThis.fetch=original;tokenDb.close();rmSync(dir,{recursive:true,force:true})}
});

