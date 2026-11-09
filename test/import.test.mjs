import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('hosted users, limits, proxy imports, admin allocation and revocation', async ()=>{
  const dir=await mkdtemp(join(tmpdir(),'kb-hosted-'));
  Object.assign(process.env,{KILO_BUSTER_TEST:'1',PROXY_STATE_FILE:join(dir,'state'),ADMIN_PASSWORD:'admin-test-only',DEFAULT_REQUESTS_PER_HOUR:'1'});
  const {handler,tokenDb}=await import('../server.mjs');
  const server=http.createServer(handler).listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const realFetch=globalThis.fetch;
  const call=(url,body,headers={})=>realFetch(origin+url,{redirect:'manual',headers:{'Content-Type':'application/json',...headers},
    ...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  try {
    const dashboard=await call('/dashboard?token=old-secret');
    assert.equal(dashboard.headers.get('location'),'/admin');
    const login=await call('/portal/admin',{password:process.env.ADMIN_PASSWORD});
    const admin={cookie:login.headers.get('set-cookie').split(';')[0]};
    const identity={username:'tester',password:'test-password'};
    const signed=await call('/portal/register',identity);
    const member={cookie:signed.headers.get('set-cookie').split(';')[0]};
    assert.equal((await call('/portal/register',identity)).status,409);
    assert.equal((await call('/portal/login',identity)).status,200);
    assert.equal((await call('/portal/users',undefined,member)).status,403);
    assert.equal((await call('/api/proxies/import',{},member)).status,403);
    assert.equal((await call('/api/proxies/import',{}, {...admin,origin:'https://elsewhere.invalid'})).status,403);
    const issue=async(path,headers)=>({authorization:'Bearer '+(await (await call(path,{},headers)).json()).key});
    const key=await issue('/portal/key',member);
    const chat=(headers)=>call('/v1/chat/completions',{messages:[]},headers);
    assert.equal((await chat(key)).status,503);
    assert.equal((await call('/health/stats',undefined,key)).status,403);
    globalThis.fetch=async()=>new Response('user:pass@example.com:8080\rhttp://user:pass@example.com:8080\rinvalid\rother.example:3128\r');
    assert.deepEqual(await (await call('/api/proxies/import',{},admin)).json(),{added:2,duplicates:1,invalid:1,total:2});
    assert.equal((await (await call('/api/proxies/import',{},admin)).json()).duplicates,3);
    globalThis.fetch=async()=>new Response(JSON.stringify({usage:{prompt_tokens:3,completion_tokens:2}}));
    const results=await Promise.all([chat(key),chat(key)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);
    const me=async()=> (await call('/portal/me',undefined,member)).json();
    const u=await me(), base='/portal/users/'+u.id+'/';
    assert.deepEqual([u.total,u.used,u.remaining,u.input,u.output],[1,1,0,3,2]);
    const rotated=await issue(base+'key',admin);
    assert.equal((await chat(key)).status,401);
    assert.equal((await chat(rotated)).status,429);
    assert.equal((await call(base+'quota',{quota:500},admin)).status,200);
    const allocation=async()=> (await call('/admin/allocation',undefined,admin)).json();
    const v=await allocation();
    assert.deepEqual([v.active,v.capacity,v.assigned,v.balance,v.remainingNow],[2,298,500,-202,297]);
    assert.equal((await chat(rotated)).status,200);
    tokenDb.prepare('UPDATE requests SET at=at-3600001').run();
    assert.equal((await me()).remaining,500);
    assert.equal((await me()).total,2);
    await call(base+'revoke',{},admin);
    assert.equal((await chat(rotated)).status,401);
    assert.equal((await call('/portal/me',undefined,member)).status,401);
    assert.equal((await call('/portal/login',identity)).status,401);
    assert.equal((await allocation()).assigned,0);
    await call(base+'enable',{},admin);
    assert.equal((await chat(rotated)).status,401);
    assert.equal((await call('/portal/login',identity)).status,200);
  } finally {
    globalThis.fetch=realFetch;
    await new Promise(done=>server.close(done));
    await new Promise(done=>setTimeout(done,150)); // flush the proxy health save timer
    tokenDb.close(); await rm(dir,{recursive:true,force:true});
  }
});
