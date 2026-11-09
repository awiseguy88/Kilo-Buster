import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sameSecret, validLimit } from './accounts.mjs';

const html = await readFile(new URL('./portal.html', import.meta.url));
const artwork = await readFile(new URL('./assets/Kilo Buster_ Breaking Network Chains.png',import.meta.url));
const cookie = '__Host-kb_session';
const trialCookie = '__Host-kb_trial';
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
function trialToken(req) { return (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(trialCookie+'='))?.slice(trialCookie.length+1) || ''; }

export function browserWrite(req) {
  try {
    return req.headers['content-type']?.split(';')[0]==='application/json' &&
      (!req.headers.origin || new URL(req.headers.origin).host===req.headers.host) &&
      req.headers['sec-fetch-site']!=='cross-site';
  } catch { return false; }
}

export async function portal(req,res,path,store,readJson,json) {
  const token=sessionToken(req);
  const session=token && store.session(token);
  const fail=(status,message)=>json(res,status,{error:{message}});
  const send=data=>json(res,200,data);
  const redirect=location=>{res.writeHead(303,{location});res.end();};
  if(path==='/portal/art.png' && req.method==='GET') {
    res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=86400'});
    return res.end(artwork);
  }
  if(path==='/portal/trial' && req.method==='POST') {
    if(!browserWrite(req)) return fail(403,'A same-site JSON request is required.');
    const claim=trialToken(req) || createHash('sha256').update((req.headers['user-agent']||'')+'|'+(req.socket?.remoteAddress||'')).digest('hex');
    const trial=await store.createTrial(claim) || store.getTrial(claim);
    if(!trial) return fail(409,'A trial key has already been issued for this browser.');
    res.setHeader('set-cookie',trialCookie+'='+claim+cookieOptions+'; Max-Age=259200');
    const protocol=req.headers['x-forwarded-proto']?.split(',')[0] || 'https';
    return send({key:trial.key,expires:trial.expires,endpoint:`${protocol}://${req.headers.host}/v1`});
  }
  if (req.method==='GET' && ['/','/login','/register','/admin','/account','/admin/users','/setup'].includes(path)) {
    if (path==='/admin/users' && !session?.admin) return redirect('/admin');
    if (path==='/account' && !session?.uid) return redirect('/login');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);
  }
  if(req.method==='GET' && path==='/portal/me') return session?.uid ? send(store.user(session.uid)) : fail(401,'Sign in required.');
  if(req.method==='GET' && path==='/portal/users') return session?.admin ? send(store.list()) : fail(403,'Admin sign-in required.');
  if(req.method==='GET' && path==='/portal/payments') return session?.admin ? send(store.payments()) : fail(403,'Admin sign-in required.');
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
      if(process.env.ADMIN_PASSWORD.length<12 || process.env.ADMIN_PASSWORD.length>256) return fail(503,'ADMIN_PASSWORD must be 12–256 characters.');
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
  if(path==='/portal/usage-request') {
    if(!session?.uid) return fail(403,'User sign-in required.');
    const {rate,email}=data;
    if(![2500,5000,10000,25000].includes(rate) || typeof email!=='string' || email.length>254 ||
       !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email) || /\s/.test(email)) {
      return fail(400,'Choose a listed hourly limit and enter a valid contact email.');
    }
    if(!process.env.RESEND_API_KEY || !process.env.USAGE_EMAIL_FROM) return fail(503,'Email delivery is not configured yet.');
    if(limited('usage:'+session.uid,3)) return fail(429,'Please wait a minute before sending another request.');
    const user=store.user(session.uid);
    const stamp=new Date().toISOString().slice(0,10);
    const id=createHash('sha256').update(JSON.stringify([user.id,email,rate,stamp])).digest('hex');
    try {
      const sent=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.RESEND_API_KEY,'Idempotency-Key':id},
        body:JSON.stringify({from:process.env.USAGE_EMAIL_FROM,to:['aaronwise@aaronwiseai.com'],reply_to:email,
          subject:'Kilo Buster usage request from '+user.username,
          text:`Account: ${user.username}\nRequested limit: ${rate} requests per hour\nContact: ${email}`})});
      if(!sent.ok || !(await sent.json()).id) throw Error('Delivery failed');
      return send({accepted:true});
    } catch {return fail(502,'Email delivery could not be confirmed. Please try again.');}
  }
  if(path==='/portal/checkout') {
    if(!session?.uid) return fail(403,'User sign-in required.');
    if(!process.env.STRIPE_SECRET_KEY) return fail(503,'Stripe is not configured yet.');
    const prices={2500:process.env.STRIPE_PRICE_2500,5000:process.env.STRIPE_PRICE_5000,7500:process.env.STRIPE_PRICE_7500,10000:process.env.STRIPE_PRICE_10000};
    const price=prices[data.price]; if(!price) return fail(400,'Invalid plan.');
    const origin=`${req.headers['x-forwarded-proto']?.split(',')[0]||'https'}://${req.headers.host}`;
    const form=new URLSearchParams({mode:'subscription','success_url':origin+'/account?billing=success','cancel_url':origin+'/account?billing=cancelled','client_reference_id':String(session.uid),'line_items[0][price]':price,'line_items[0][quantity]':'1','subscription_data[metadata][uid]':String(session.uid),'subscription_data[metadata][quota]':String(data.price)});
    const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY,'Content-Type':'application/x-www-form-urlencoded'},body:form});
    const result=await response.json(); if(!response.ok||!result.url) { console.error('[stripe] checkout failed',response.status,result?.error?.type||'unknown',result?.error?.message||'no checkout URL'); return fail(502,'Stripe Checkout could not be created: '+(result?.error?.message||'check Stripe configuration.')); }
    return send({url:result.url});
  }
  if(!session?.admin) return fail(403,'Admin sign-in required.');
  const paymentAction=path.match(/^\/portal\/payments\/(\d+)\/approve$/);
  if(paymentAction) return store.approvePayment(Number(paymentAction[1])) ? send({}) : fail(404,'Payment not found.');
  if(path==='/portal/users/create-with-key') {
    const {username,password,quota}=data;
    if(typeof username!=='string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return fail(400,'Use 3–32 letters, numbers, underscores or hyphens for the username.');
    if(typeof password!=='string' || password.length<10 || password.length>256) return fail(400,'Use a password between 10 and 256 characters.');
    if(!validLimit(quota)) return fail(400,'Enter a whole number from 0 to 1,000,000.');
    const key=await store.createWithKey(username,password,quota);
    return key ? send({key}) : fail(409,'Username already exists. Use the existing account to add another key.');
  }
  const keyAction=path.match(/^\/portal\/keys\/(\d+)\/(quota|delete)$/);
  if(keyAction) {
    const id=Number(keyAction[1]);
    if(!Number.isSafeInteger(id)) return fail(404,'Key not found.');
    if(keyAction[2]==='quota' && !validLimit(data.quota)) return fail(400,'Enter a whole number from 0 to 1,000,000.');
    const changed=keyAction[2]==='delete' ? store.deleteKey(id) : store.setKeyQuota(id,data.quota);
    return changed ? send({}) : fail(404,'Key not found.');
  }
  const match=path.match(/^\/portal\/users\/(\d+)\/(key|revoke|enable)$/);
  if(!match) return fail(404,'Action not found.');
  const id=Number(match[1]);
  if(!Number.isSafeInteger(id) || !store.user(id)) return fail(404,'User not found.');
  switch(match[2]) {
    case 'revoke': store.revoke(id); break;
    case 'enable': store.enable(id); break;
    case 'key': {
      if(!validLimit(data.quota)) return fail(400,'Enter a whole number from 0 to 1,000,000.');
      const key=store.issue(id,data.quota);
      return key ? send({key}) : fail(409,'Restore access before generating a key.');
    }
  }
  return send(store.user(id));
}
