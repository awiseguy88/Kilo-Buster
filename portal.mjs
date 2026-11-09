import { readFile } from 'node:fs/promises';
import { sameSecret, validLimit } from './accounts.mjs';

const html = await readFile(new URL('./portal.html', import.meta.url));
const artwork = await readFile(new URL('./assets/Kilo Buster_ Breaking Network Chains.png',import.meta.url));
const cookie = '__Host-kb_session';
const cookieOptions = '; Path=/; HttpOnly; SameSite=Strict; Secure';
const attempts = new Map();
const cleanup = setInterval(() => {
  for (const [key,bucket] of attempts) if (bucket.until<=Date.now()) attempts.delete(key);
}, 60000);
cleanup.unref();

function limited(key,max) {
  const now=Date.now();
  let bucket=attempts.get(key);
  if (!bucket || bucket.until<=now) attempts.set(key,bucket={count:0,until:now+60000});
  return ++bucket.count>max;
}

export function sessionToken(req) {
  return (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookie+'='))?.slice(cookie.length+1) || '';
}

export function browserWrite(req) {
  try {
    return req.headers['content-type']?.split(';')[0]==='application/json' &&
      (!req.headers.origin || new URL(req.headers.origin).host===req.headers.host) &&
      req.headers['sec-fetch-site']!=='cross-site';
  } catch { return false; }
}

export async function portal(req,res,path,store,readJson,json) {
  if(path==='/portal/art.png' && req.method==='GET') {
    res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=86400'});
    return res.end(artwork);
  }
  const token=sessionToken(req);
  const session=token && store.session(token);
  const fail=(status,message)=>json(res,status,{error:{message}});
  const send=data=>json(res,200,data);
  const redirect=location=>{res.writeHead(303,{location});res.end();};
  if (req.method==='GET' && ['/','/login','/register','/admin','/account','/admin/users'].includes(path)) {
    if (path==='/admin/users' && !session?.admin) return redirect('/admin');
    if (path==='/account' && !session?.uid) return redirect('/login');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);
  }
  if(req.method==='GET' && path==='/portal/me') return session?.uid ? send(store.user(session.uid)) : fail(401,'Sign in required.');
  if(req.method==='GET' && path==='/portal/users') return session?.admin ? send(store.list()) : fail(403,'Admin sign-in required.');
  if(req.method!=='POST') return fail(404,'Page not found.');
  if(!browserWrite(req)) return fail(403,'A same-site JSON request is required.');
  let data;
  try {data=await readJson(req,2048);} catch {return fail(400,'Invalid or oversized JSON.');}
  if (!data || typeof data!=='object') return fail(400,'Invalid request.');
  if(path==='/portal/logout') {
    store.logout(token); res.setHeader('set-cookie',cookie+'='+cookieOptions+'; Max-Age=0'); return send({});
  }
  if(['/portal/login','/portal/register','/portal/admin'].includes(path)) {
    const {username,password}=data;
    const ip=req.socket?.remoteAddress || 'local';
    if(limited(path+ip,40)) return fail(429,'Too many attempts. Try again in a minute.');
    if(typeof password!=='string' || password.length>256) return fail(400,'Invalid password.');
    let uid=null;
    if(path==='/portal/admin') {
      if(!process.env.ADMIN_PASSWORD) return fail(503,'Configure ADMIN_PASSWORD in Railway first.');
      if(!sameSecret(password,process.env.ADMIN_PASSWORD)) return fail(401,'Invalid administrator password.');
    } else {
      if(typeof username!=='string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return fail(400,'Use 3–32 letters, numbers, underscores or hyphens for your username.');
      if(path==='/portal/register') {
        if(password.length<10) return fail(400,'Use at least 10 characters for your password.');
        if(!await store.register(username,password)) return fail(409,'Username unavailable.');
      }
      uid=await store.login(username,password);
      if(!uid) return fail(401,'Sign-in failed.');
    }
    res.setHeader('set-cookie',cookie+'='+store.newSession(uid)+cookieOptions+'; Max-Age=43200');
    return send({location:uid===null?'/dashboard':'/account'});
  }
  if(path==='/portal/key' && session?.uid) return send({key:store.issue(session.uid)});
  if(!session?.admin) return fail(403,'Admin sign-in required.');
  const match=path.match(/^\/portal\/users\/(\d+)\/(quota|key|revoke|enable)$/);
  if(!match) return fail(404,'Action not found.');
  const id=Number(match[1]);
  if(!Number.isSafeInteger(id) || !store.user(id)) return fail(404,'User not found.');
  switch(match[2]) {
    case 'quota':
      if(!validLimit(data.quota)) return fail(400,'Enter a whole number from 0 to 1,000,000.');
      store.setQuota(id,data.quota); break;
    case 'revoke': store.revoke(id); break;
    case 'enable': store.enable(id); break;
    case 'key': {
      const key=store.issue(id);
      return key ? send({key}) : fail(409,'Restore access before generating a key.');
    }
  }
  return send(store.user(id));
}
