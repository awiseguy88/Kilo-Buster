import { readFile } from 'node:fs/promises';
import { createHash,randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { sameSecret, validLimit } from './accounts.mjs';
import { siteOrigin } from './welcome.mjs';

const html = await readFile(new URL('./portal.html', import.meta.url));
const artwork = await readFile(new URL('./assets/Kilo Buster_ Breaking Network Chains.png',import.meta.url));
const cookie = '__Host-kb_session';
const trialCookie = '__Host-kb_trial';
const orderCookie = '__Host-kb_order';
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
function clientIp(req) {
  if(process.env.TRUST_PROXY==='1'){
    const chain=String(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);
    if(chain.at(-1)&&isIP(chain.at(-1)))return chain.at(-1);
  }
  return req.socket?.remoteAddress || 'unknown';
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
  const priorClaim=trialToken(req), secureClaim=/^v2_[A-Za-z0-9_-]{43}$/.test(priorClaim);
  if(path==='/portal/trial/current' && req.method==='GET')return send(secureClaim?store.getTrial(priorClaim)||{}:{});
  if(path==='/portal/trial/migrate' && req.method==='POST'){
    if(!browserWrite(req)||!priorClaim||secureClaim)return fail(403,'Trial proof required.');
    const old=store.getTrial(priorClaim), supplied=req.headers.authorization;
    if(!old||!sameSecret(supplied||'','Bearer '+old.key))return fail(403,'Trial proof required.');
    const fresh='v2_'+randomBytes(32).toString('base64url');
    store.moveTrial(priorClaim,fresh);
    res.setHeader('set-cookie',trialCookie+'='+fresh+cookieOptions+'; Max-Age='+Math.ceil((old.expires-Date.now())/1000));
    return send(old);
  }
  if(path==='/portal/trial' && req.method==='POST') {
    if(!browserWrite(req)) return fail(403,'A same-site JSON request is required.');
    if(secureClaim){const existing=store.getTrial(priorClaim);return existing?send(existing):fail(409,'Your trial has ended. Sign in to choose a plan.');}
    if(limited('trial:'+clientIp(req),4))return fail(429,'Too many new trial requests. Try again in a minute.');
    const claim='v2_'+randomBytes(32).toString('base64url');
    const trial=await store.createTrial(claim);
    if(!trial) return fail(409,'A trial key has already been issued for this browser.');
    res.setHeader('set-cookie',trialCookie+'='+claim+cookieOptions+'; Max-Age=259200');
    const protocol=req.headers['x-forwarded-proto']?.split(',')[0] || 'https';
    return send({key:trial.key,expires:trial.expires,endpoint:`${protocol}://${req.headers.host}/v1`});
  }
  if (req.method==='GET' && ['/','/login','/register','/reset','/admin','/account','/admin/users','/setup','/welcome'].includes(path)) {
    if ((path==='/login'||path==='/register') && session?.uid) return redirect('/account');
    if (path==='/admin/users' && !session?.admin) return redirect('/admin');
    if (path==='/account' && !session?.uid) return redirect('/login');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);
  }
  const live=Number(/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY||''));
  const setMemberSession=value=>res.setHeader('set-cookie',cookie+'='+value+cookieOptions.replace('Strict','Lax')+'; Max-Age=43200');
  if(req.method==='GET' && path==='/portal/session') return send({signedIn:Boolean(session),admin:Boolean(session?.admin)});
  if(req.method==='GET' && path==='/portal/me') {
    if(!session?.uid)return fail(401,'Sign in required.');
    const {subscription,invoices}=store.billing(session.uid,live);
    return send({...store.user(session.uid),temporary:session.temporary,paidUntil:subscription?.paid_until||null,invoices});
  }
  if(req.method==='GET' && path==='/portal/users') return session?.admin ? send(store.list()) : fail(403,'Admin sign-in required.');
  if(req.method==='GET' && path==='/portal/payments') return session?.admin ? send(store.payments()) : fail(403,'Admin sign-in required.');
  if(req.method==='GET' && path==='/portal/sales') return session?.admin ? send(store.salesStats()) : fail(403,'Admin sign-in required.');
  if(req.method!=='POST') return fail(404,'Page not found.');
  if(!browserWrite(req)) return fail(403,'A same-site JSON request is required.');
  let data;
  try {data=await readJson(req,2048);} catch {return fail(400,'Invalid or oversized JSON.');}
  if (!data || typeof data!=='object') return fail(400,'Invalid request.');
  if(path==='/portal/reset-request'){
    if(limited('reset:'+clientIp(req),5))return fail(429,'Please wait before trying again.');
    if(typeof data.email!=='string'||data.email.length>254||!/^\S+@\S+\.\S+$/.test(data.email))return fail(400,'Enter a valid email address.');
    if(!process.env.RESEND_API_KEY||!process.env.USAGE_EMAIL_FROM)return fail(503,'Password reset email is unavailable. Contact support.');
    if(typeof data.username!=='string'||!/^[a-zA-Z0-9_-]{3,32}$/.test(data.username))return fail(400,'Enter your username.');
    const email=data.email.trim().toLowerCase(), reset=store.createReset(email,data.username);
    if(reset){try{const response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.RESEND_API_KEY},body:JSON.stringify({from:process.env.USAGE_EMAIL_FROM,to:[email],subject:'Reset your Kilo Buster password',text:'Reset your password within 30 minutes: '+siteOrigin()+'/reset?token='+encodeURIComponent(reset)+'\nIf you did not request this, ignore this email.'})});if(!response.ok)console.error('[reset] email delivery failed',response.status)}catch{console.error('[reset] email delivery failed')}}
    return send({message:'If an account exists for that email, a reset link has been sent.'});
  }
  if(path==='/portal/reset-password'){
    if(limited('reset-confirm:'+clientIp(req),10))return fail(429,'Please wait before trying again.');
    if(typeof data.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.token)||typeof data.password!=='string'||data.password.length<10||data.password.length>256)return fail(400,'Invalid reset link or password.');
    return await store.resetPassword(data.token,data.password)?send({}):fail(400,'Reset link is invalid or expired.');
  }
  if(path==='/portal/account-trial'){
    if(!session?.uid)return fail(401,'Sign in required.');
    if(limited('trial:'+clientIp(req),4))return fail(429,'Too many new trial requests. Try again in a minute.');
    const trial=store.createAccountTrial(session.uid);
    return trial?send(trial):fail(409,'This account has already used its trial.');
  }
  const orderProof=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(orderCookie+'='))?.slice(orderCookie.length+1);
  if(path==='/portal/checkout-return'){
    if(!orderProof||typeof data.checkout!=='string'||data.checkout.length>255)return send({status:'unavailable'});
    const claim=store.claimCheckout(orderProof,data.checkout);
    if(claim.token)setMemberSession(claim.token);
    return send({status:claim.status});
  }
  if(path==='/portal/change-password'){
    if(!session?.uid)return fail(401,'Sign in required.');
    if(limited('password:'+session.uid,5))return fail(429,'Too many attempts. Try again in a minute.');
    if(typeof data.current!=='string'||data.current.length>256||typeof data.password!=='string'||data.password.length<10||data.password.length>256)return fail(400,'Enter your current password and a new password of 10–256 characters.');
    const fresh=await store.changePassword(session.uid,data.current,data.password);
    if(!fresh)return fail(401,'Current password is incorrect.');
    setMemberSession(fresh);return send({});
  }
  if(path==='/portal/password'){
    if(!session?.temporary)return fail(403,'A new account sign-in is required.');
    if(typeof data.password!=='string'||data.password.length<10||data.password.length>256)return fail(400,'Use a password between 10 and 256 characters.');
    const fresh=await store.setFirstPassword(session.uid,data.password);
    if(!fresh)return fail(409,'Sign in with your updated password.');
    setMemberSession(fresh);return send({});
  }
  if(path==='/portal/logout') {
    store.logout(token); res.setHeader('set-cookie',cookie+'='+cookieOptions+'; Max-Age=0'); return send({});
  }
  if(['/portal/login','/portal/register','/portal/admin'].includes(path)) {
    const {username,password}=data;
    const ip=clientIp(req);
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
        if(data.email!==undefined&&(typeof data.email!=='string'||data.email.length>254||!/^\S+@\S+\.\S+$/.test(data.email)))return fail(400,'Enter a valid email address.');
        if(!await store.register(username,password,data.email?.trim().toLowerCase())) return fail(409,'Username unavailable.');
      }
      uid=await store.login(username,password);
      if(!uid) return fail(401,'Sign-in failed.');
    }
    res.setHeader('set-cookie',cookie+'='+store.newSession(uid)+(uid===null?cookieOptions:cookieOptions.replace('Strict','Lax'))+'; Max-Age=43200');
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
  if(path==='/portal/checkout'||path==='/portal/billing-portal') {
    // A signed-in administrator should still be able to buy a guest plan from
    // the public pricing page; only the billing-management action requires a
    // customer session.
    if(path==='/portal/billing-portal'&&!session?.uid)return fail(403,'Sign in with a customer account.');
    if(!process.env.STRIPE_SECRET_KEY) return fail(503,'Stripe is not configured yet.');
    const prices={2500:process.env.STRIPE_PRICE_2500,5000:process.env.STRIPE_PRICE_5000,7500:process.env.STRIPE_PRICE_7500,10000:process.env.STRIPE_PRICE_10000};
    const origin=siteOrigin();
    const sub=session?.uid && store.billing(session.uid,live).subscription;
    if(path==='/portal/billing-portal'){
      if(!sub?.customer)return fail(409,'No linked subscription.');
      const result=await fetch('https://api.stripe.com/v1/billing_portal/sessions',{method:'POST',headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY},body:new URLSearchParams({customer:sub.customer,return_url:origin+'/account'}),signal:AbortSignal.timeout(12000)});
      if(!result.ok)return fail(502,'Billing management is temporarily unavailable. Contact support.');
      return send({url:(await result.json()).url});
    }
    if(sub)return fail(409,'Use Manage billing for your existing subscription.');
    const price=Object.hasOwn(prices,data.price)&&prices[data.price]; if(!price) return fail(400,'Invalid plan.');
    if(!process.env.RESEND_API_KEY||!process.env.USAGE_EMAIL_FROM)return fail(503,'Checkout is unavailable while purchase email is being configured.');
    const form=new URLSearchParams({mode:'subscription','line_items[0][price]':price,'line_items[0][quantity]':'1','subscription_data[metadata][quota]':String(data.price)});
    let order;
    if(session?.uid){
      form.set('subscription_data[metadata][uid]',String(session.uid));
      form.set('client_reference_id',String(session.uid));
      form.set('success_url',origin+'/account?billing=success');
      form.set('cancel_url',origin+'/account?billing=cancelled');
    }else{
      if(limited('checkout:'+clientIp(req),30))return fail(429,'Please wait a minute before starting another checkout.');
      const proof=/^[A-Za-z0-9_-]{43}$/.test(orderProof||'')?orderProof:randomBytes(32).toString('base64url');
      order=store.startGuestOrder(proof,Number(data.price));
      form.set('subscription_data[metadata][guest_order]',order);
      form.set('success_url',origin+'/welcome?checkout={CHECKOUT_SESSION_ID}');
      form.set('cancel_url',origin+'/pricing');
      res.setHeader('set-cookie',orderCookie+'='+proof+cookieOptions.replace('Strict','Lax')+'; Max-Age=172800');
    }
    const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY,'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(12000)});
    const result=await response.json(); if(!response.ok||!result.url) { console.error('[stripe] checkout failed',response.status,result?.error?.code||result?.error?.type||'unknown',response.headers.get('request-id')); return fail(502,'Checkout is unavailable. Please try again or contact support.'); }
    if(order)store.bindCheckout(order,result.id);
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
