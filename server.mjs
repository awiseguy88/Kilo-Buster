import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProxyAgent } from 'undici';
import { accounts } from './accounts.mjs';
import { browserWrite, portal, sessionToken } from './portal.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 43817), HOST = process.env.HOST || '0.0.0.0';
const MODEL = 'kilo-auto/free', UPSTREAM = 'https://ai-gateway.kilo.ai/api/v1/chat/completions';
const KILO_API_KEY = process.env.KILO_API_KEY || '';
const STATE_FILE = process.env.PROXY_STATE_FILE || join(process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT, 'proxy-health-state.json');
const PROXY_SOURCE = 'https://aaronwiseai.com/aidocs/prox.txt';
let importing = false;
let proxies = [], saveTimer = null;
let batchProxy, batchRemaining = 0;
const agents = new Map();
const HOUR = 60 * 60 * 1000;
const requestedLimit = Number(process.env.PROXY_REQUESTS_PER_HOUR ?? 149);
if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw Error('PROXY_REQUESTS_PER_HOUR must be a positive integer.');
const MAX_PER_HOUR = Math.min(149, requestedLimit);
const BACKOFF_BASE = Number(process.env.PROXY_BACKOFF_SECONDS || 5) * 1000;
const tokenDb = new DatabaseSync(STATE_FILE + '.tokens.sqlite');
const store = accounts(tokenDb,Number(process.env.DEFAULT_REQUESTS_PER_HOUR ?? 30));
tokenDb.exec('CREATE TABLE IF NOT EXISTS totals (id INTEGER PRIMARY KEY, input INTEGER NOT NULL, output INTEGER NOT NULL); INSERT OR IGNORE INTO totals VALUES (1,0,0)');
const addUsage = tokenDb.prepare('UPDATE totals SET input=input+?, output=output+? WHERE id=1');
const getUsage = tokenDb.prepare('SELECT input, output FROM totals WHERE id=1');
tokenDb.exec('CREATE TABLE IF NOT EXISTS proxy_window (address TEXT PRIMARY KEY, attempts TEXT NOT NULL)');
const readWindow = tokenDb.prepare('SELECT attempts FROM proxy_window WHERE address=?');
const writeWindow = tokenDb.prepare('INSERT OR REPLACE INTO proxy_window VALUES (?,?)');

function reserveAttempt(proxy, now) {
  const address = proxy.url.host;
  tokenDb.exec('BEGIN IMMEDIATE');
  try {
    const row = readWindow.get(address);
    const attempts = (row ? JSON.parse(row.attempts) : proxy.requests).filter(t => t > now - HOUR);
    const allowed = attempts.length < MAX_PER_HOUR;
    if (allowed) attempts.push(now);
    writeWindow.run(address, JSON.stringify(attempts));
    tokenDb.exec('COMMIT');
    proxy.requests = attempts;
    return allowed;
  } catch (error) {
    tokenDb.exec('ROLLBACK');
    throw error;
  }
}

async function forwardBody(upstream, res, uid) {
  let pending = '', usage;
  const decoder = new TextDecoder();
  const stream = upstream.headers.get('content-type')?.includes('text/event-stream');
  function inspect(line) {
    if (!line.includes('"usage"')) return;
    try {
      const value = JSON.parse(line).usage;
      if (value && Number.isSafeInteger(value.prompt_tokens) && value.prompt_tokens >= 0 &&
          Number.isSafeInteger(value.completion_tokens) && value.completion_tokens >= 0) usage = value;
    } catch {}
  }
  function parseLines() {
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.startsWith('data:')) inspect(line.slice(5));
    }
  }
  for await (const chunk of upstream.body) {
    res.write(chunk);
    pending += decoder.decode(chunk, {stream:true});
    if (stream) parseLines();
  }
  pending += decoder.decode();
  if (stream) { pending += '\n'; parseLines(); } else inspect(pending);
  if (usage) {
    try { addUsage.run(usage.prompt_tokens, usage.completion_tokens); store.recordTokens(uid,usage.prompt_tokens,usage.completion_tokens); }
    catch (error) { console.error('[tokens] unable to persist usage:', error.message); }
  }
}
function parseProxy(line) {
  const value = line.trim();
  if (!value || value.startsWith('#')) return null;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && url.port && !url.pathname.replace('/', '') && !url.search && !url.hash ? url : null;
  } catch { return null; }
}
async function importProxies() {
  if (importing) throw new Error('A proxy import is already in progress.');
  importing = true;
  try {
    const response = await fetch(PROXY_SOURCE, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Proxy source returned HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error('Proxy list is too large.');
    let saved = {}; try { saved = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch {}
    const old = new Map((saved.proxies || []).map(p => [p.address, p]));
    const seen = new Set(proxies.map(p => p.url.host));
    let added = 0, duplicates = 0, invalid = 0;
    for (const line of text.split(/\r\n|[\r\n]/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const url = parseProxy(line);
      if (!url) { invalid++; continue; }
      if (seen.has(url.host)) { duplicates++; continue; }
      const previous = old.get(url.host) || {};
      const p = { id: proxies.length + 1, active: 0, url, latencyMs: Number(previous.latencyMs) || 0, requests: Array.isArray(previous.requests) ? previous.requests.filter(t => Date.now() - t < HOUR) : [], successes: Number(previous.successes) || 0, failures: Number(previous.failures) || 0, consecutiveFailures: Number(previous.consecutiveFailures) || 0, backoffUntil: Number(previous.backoffUntil) || 0, lastError: previous.lastError || '', lastUsed: Number(previous.lastUsed) || 0 };
      const row = readWindow.get(url.host); if (row) p.requests = JSON.parse(row.attempts);
      agents.set(url.href, new ProxyAgent(url.href));
      proxies.push(p); seen.add(url.host); added++;
    }
    return { added, duplicates, invalid, total: proxies.length };
  } finally { importing = false; }
}
function scheduleSave() { if (saveTimer) return; saveTimer = setTimeout(async () => { saveTimer = null; const data = { savedAt: new Date().toISOString(), proxies: proxies.map(p => ({ address: `${p.url.hostname}:${p.url.port || 80}`, latencyMs: p.latencyMs, requests: p.requests, successes: p.successes, failures: p.failures, consecutiveFailures: p.consecutiveFailures, backoffUntil: p.backoffUntil, lastError: p.lastError, lastUsed: p.lastUsed })) }; const temp = `${STATE_FILE}.tmp`; try { await writeFile(temp, JSON.stringify(data), 'utf8'); await rename(temp, STATE_FILE); } catch (e) { console.error(`[state] unable to save ${STATE_FILE}: ${e.message}`); } }, 100); }
function prune(proxy, now = Date.now()) { proxy.requests = proxy.requests.filter(t => now - t < HOUR); }
function available(proxy, now = Date.now()) { prune(proxy, now); return proxy.backoffUntil <= now && proxy.requests.length < MAX_PER_HOUR; }
function proxyStats(proxy) { const now = Date.now(); prune(proxy, now); return { id: proxy.id, active: proxy.active, latencyMs: proxy.latencyMs || null, address: `${proxy.url.hostname}:${proxy.url.port || 80}`, requestsLastHour: proxy.requests.length, remaining: Math.max(0, MAX_PER_HOUR - proxy.requests.length), successes: proxy.successes, failures: proxy.failures, consecutiveFailures: proxy.consecutiveFailures, backoffSeconds: Math.max(0, Math.ceil((proxy.backoffUntil - now) / 1000)), lastError: proxy.lastError, lastUsed: proxy.lastUsed ? new Date(proxy.lastUsed).toISOString() : null }; }
function pickProxy() {
  const now = Date.now();
  let next, current;
  let lowestLoad = Infinity;
  for (const proxy of proxies) {
    if (proxy.backoffUntil > now) continue;
    if (proxy.requests.length >= MAX_PER_HOUR && !available(proxy, now)) continue;
    if (proxy.active > lowestLoad) continue;
    if (proxy.active < lowestLoad) {
      lowestLoad = proxy.active;
      next = current = undefined;
    }
    if (proxy === batchProxy) current = proxy;
    else if (!next || proxy.lastUsed < next.lastUsed ||
      (proxy.lastUsed === next.lastUsed && (proxy.latencyMs || Infinity) < (next.latencyMs || Infinity))) next = proxy;
  }
  const selected = current && batchRemaining > 0 ? current : next || current;
  if (!selected) return null;
  if (!reserveAttempt(selected, now)) return pickProxy();
  if (selected !== batchProxy || batchRemaining === 0) {
    batchProxy = selected;
    batchRemaining = 25 + Math.floor(Math.random() * 6);
  }
  batchRemaining--;
  prune(selected, now);
  selected.active++;
  selected.lastUsed = now;
  scheduleSave();
  return selected;
}
function markSuccess(proxy) { proxy.successes++; proxy.consecutiveFailures = 0; proxy.backoffUntil = 0; proxy.lastError = ''; scheduleSave(); }
function markFailure(proxy, error) { proxy.failures++; proxy.consecutiveFailures++; proxy.backoffUntil = Date.now() + Math.min(15 * 60 * 1000, BACKOFF_BASE * 2 ** Math.min(proxy.consecutiveFailures - 1, 8)); proxy.lastError = String(error?.message || error).slice(0, 240); scheduleSave(); }
function cors(res) { res.setHeader('access-control-allow-origin','*'); res.setHeader('access-control-allow-methods','GET, POST, OPTIONS'); res.setHeader('access-control-allow-headers','Content-Type, Authorization'); }
function json(res, status, data) { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(data)); }
async function readJson(req,limit=4*1024*1024) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    const buf=Buffer.from(chunk); size+=buf.length;
    if(size>limit) throw Error('Body too large');
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function readRaw(req,limit=2*1024*1024) { const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('Body too large');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks); }
function stripeSignatureValid(raw,header,secret){ if(!header||!secret)return false;const values=Object.fromEntries(header.split(',').map(x=>x.split('=')));const expected=createHmac('sha256',secret).update(`${values.t}.${raw.toString()}`).digest('hex');try{return timingSafeEqual(Buffer.from(expected),Buffer.from(values.v1||''));}catch{return false;} }
async function handler(req, res) {
  const requestUrl = new URL(req.url,'http://localhost'), path = requestUrl.pathname;
  res.setHeader('cache-control','no-store');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-frame-options','DENY');
  if(path==='/stripe/webhook' && req.method==='POST') {
    const raw=await readRaw(req); if(!stripeSignatureValid(raw,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET)) return json(res,400,{error:{message:'Invalid Stripe signature.'}});
    let event;try{event=JSON.parse(raw)}catch{return json(res,400,{error:{message:'Invalid webhook payload.'}})}
    if(event.type==='checkout.session.completed' || event.type==='customer.subscription.updated' || event.type==='customer.subscription.deleted') {
      const object=event.data.object, meta=object.metadata||object.subscription_details?.metadata||{}; const uid=Number(meta.uid), quota=Number(meta.quota); if(Number.isSafeInteger(uid)&&Number.isSafeInteger(quota)&&quota>0) store.recordPayment(event.id,uid,quota,object.amount_total||object.items?.data?.[0]?.price?.unit_amount,'usd');
    }
    return json(res,200,{received:true});
  }
  if(req.method==='GET' && /^\/(?:admin\/)?theme\.(css|js)$/.test(path)){
    const file=path.split('/').pop();
    res.writeHead(200,{'content-type':file.endsWith('.css')?'text/css':'text/javascript'});
    return res.end(await readFile(join(ROOT,file)));
  }
  if (['/','/admin','/account','/admin/users','/login','/register','/setup'].includes(path) || path.startsWith('/portal/')) {
    return portal(req,res,path,store,readJson,json);
  }
  const adminRoute=['/dashboard','/api/proxies/import','/health/stats','/admin/allocation'].includes(path);
  let key,user;
  if(adminRoute) {
    if(!store.session(sessionToken(req))?.admin) {
      if(path==='/dashboard') return res.writeHead(303,{location:'/admin'}).end();
      return json(res,403,{error:{message:'Admin sign-in required.'}});
    }
    if(req.method==='POST' && !browserWrite(req)) return json(res,403,{error:{message:'Same-site JSON required.'}});
    if(path==='/admin/allocation' && req.method==='GET') {
      const active=proxies.filter(p=>available(p));
      const capacity=active.length*MAX_PER_HOUR;
      const assigned=store.assigned();
      return json(res,200,{active:active.length,perProxy:MAX_PER_HOUR,capacity,assigned,
        balance:capacity-assigned,defaultLimit:store.defaultLimit,remainingNow:active.reduce((n,p)=>n+MAX_PER_HOUR-p.requests.length,0)});
    }
  } else {
    cors(res);
    if(req.method==='OPTIONS') return res.writeHead(204).end();
    key=/^Bearer (kb_[\w-]+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    user=store.byKey(key);
    if(!user) return json(res,401,{error:{message:'Invalid or revoked API key.',type:'authentication_error'}});
  }
  if (path === '/dashboard' && req.method === 'GET') { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); return res.end(await readFile(join(ROOT, 'dashboard.html'), 'utf8')); }
  if (path === '/api/proxies/import' && req.method === 'POST') { try { return json(res, 200, await importProxies()); } catch (error) { return json(res, 502, { error: { message: error.message } }); } }
  if (path === '/health/stats' && req.method === 'GET') { const stats = proxies.map(proxyStats).sort((a,b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)); return json(res, 200, { tokens: getUsage.get(), total: stats.length, available: stats.filter(p => p.backoffSeconds === 0 && p.remaining > 0).length, quota: MAX_PER_HOUR, proxies: stats }); }
  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return json(res,200,{object:'list',data:[{id:MODEL,object:'model',created:0,owned_by:'kilo'}]});
  if (path !== '/v1/chat/completions' && path !== '/chat/completions') return json(res,404,{error:{message:'Endpoint not found.'}});
  if (req.method !== 'POST') return json(res,405,{error:{message:'Method not allowed.'}});
  let body; try { body = await readJson(req); } catch { return json(res,400,{error:{message:'Request body must be valid JSON.'}}); }
  if (!body || !Array.isArray(body.messages)) return json(res,400,{error:{message:'messages must be an array.'}}); body.model = MODEL;
  if (body.stream === true && body.stream_options === undefined) body.stream_options = { include_usage: true };
  if (!proxies.length) return json(res, 503, { error: { message: 'No proxies loaded. Open the dashboard and click Load proxies.', type: 'api_connection_error' } });
  if (!proxies.some(p=>available(p))) return json(res,429,{error:{message:'No proxy capacity available.',type:'rate_limit_error'}});
  const admission=store.reserve(key);
  if(admission!==200) return json(res,admission,{error:admission===429
    ? {message:'This API key has reached its rolling hourly request limit.',type:'rate_limit_error'}
    : {message:'Invalid or revoked API key.',type:'authentication_error'}});
  let last; const attempts = Math.min(proxies.length, Number(process.env.PROXY_RETRIES || 3));
  for (let i=0; i<attempts; i++) { const proxy = pickProxy(); if (!proxy) return json(res, 429, { error: { message: 'All proxies are at their hourly quota or cooling down.', type: 'rate_limit_error' } }); const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try { if (res.destroyed) return; const headers = {'content-type':'application/json',accept:req.headers.accept || 'application/json','x-kilocode-mode':req.headers['x-kilocode-mode'] || 'coding'}; if (KILO_API_KEY) headers.authorization = `Bearer ${KILO_API_KEY}`; const started = performance.now(); const upstream = await fetch(UPSTREAM,{method:'POST',signal:controller.signal,headers,body:JSON.stringify(body),dispatcher:agents.get(proxy.url.href)}); if (upstream.ok) { const ms = Math.max(1, performance.now() - started); proxy.latencyMs = Math.round(proxy.latencyMs ? 0.7 * proxy.latencyMs + 0.3 * ms : ms); } console.log(`[request] proxy=${proxy.id} status=${upstream.status} tools=${Array.isArray(body.tools) ? body.tools.length : 0} stream=${Boolean(body.stream)}`); if (upstream.status >= 500) { markFailure(proxy, `Kilo returned HTTP ${upstream.status}`); await upstream.body?.cancel(); last = new Error(`Kilo returned HTTP ${upstream.status}`); continue; } markSuccess(proxy); res.writeHead(upstream.status,Object.fromEntries(upstream.headers)); if (upstream.body) await forwardBody(upstream, res, user.id); return res.end(); } catch (e) { if (controller.signal.aborted) return; markFailure(proxy, e); if (res.headersSent) return res.destroy(); last=e;
    } finally {
      res.off("close", cancel);
      proxy.active--;
    }
  }
  return json(res,502,{error:{message:`All proxy attempts failed: ${last?.message || 'unknown error'}`,type:'api_connection_error'}});
}
if (process.env.KILO_BUSTER_TEST !== '1') http.createServer((req,res)=>handler(req,res).catch(error=> {
  console.error('[http] request failed:',error?.stack||error);
  if(res.headersSent) return res.destroy();
  json(res,500,{error:{message:'Internal server error.'}});
})).listen(PORT,HOST,()=>console.log(`API listening on ${HOST}:${PORT}`));
export { handler, tokenDb }; 

