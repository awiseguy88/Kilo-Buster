import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {accounts} from '../accounts.mjs';
import {applyStripeEvent} from '../billing.mjs';
import {publicPage} from '../public-site.mjs';

test('public content exposes the trial, model and four prices without JavaScript',()=>{
  for(const route of ['/','/pricing']){
    const html=publicPage(route);
    for(const price of ['7.99','12.99','19.99','29.99'])assert.ok(html.includes('$'+price));
    assert.match(html,/href="\/setup"/);assert.match(html,/href="\/register"/);
  }
});

test('monitoring alerts have independent 25-minute quiet periods',()=>{
  const db=new DatabaseSync(':memory:'),s=accounts(db,30);
  try{const now=2000000000;assert.equal(s.alertDue('no_proxies',now),true);s.alertSent(['no_proxies'],now);
    assert.equal(s.alertDue('no_proxies',now+25*60000-1),false);
    assert.equal(s.alertDue('welcome_failed',now+1),true);
    assert.equal(s.alertDue('no_proxies',now+25*60000),true);
  }finally{db.close()}
});

test('password reset requires matching email and username, expires and is single-use',async()=>{
  const db=new DatabaseSync(':memory:'),s=accounts(db,30);
  try{
    await s.register('recovery-user','old-password-123','owner@example.com');
    assert.equal(s.createReset('wrong@example.com','recovery-user'),null);
    assert.equal(s.createReset('owner@example.com','wrong-user'),null);
    const expired=s.createReset('owner@example.com','recovery-user');
    db.prepare('UPDATE password_resets SET expires=0').run();
    assert.equal(await s.resetPassword(expired,'new-password-123'),false);
    const token=s.createReset('owner@example.com','recovery-user');
    const session=s.newSession(1);
    assert.equal(await s.resetPassword(token,'new-password-123'),true);
    assert.equal(await s.resetPassword(token,'another-password'),false);
    assert.equal(s.session(session),null);
    assert.equal(await s.login('recovery-user','old-password-123'),null);
    assert.equal(await s.login('recovery-user','new-password-123'),1);
  }finally{db.close()}
});

test('recovery email changes require password and a single-use confirmation for the correct account',async()=>{
  const db=new DatabaseSync(':memory:'),s=accounts(db,30);
  try{
    await s.register('member-one','original-password','old@example.com');
    await s.register('member-two','second-password','other@example.com');
    assert.equal(await s.requestRecoveryEmail(1,'new@example.com','incorrect'),null);
    const token=await s.requestRecoveryEmail(1,'new@example.com','original-password');
    assert.equal(s.recoveryEmail(1),'old@example.com');
    assert.equal(s.confirmRecoveryEmail(2,token),false);
    assert.equal(s.confirmRecoveryEmail(1,token),true);
    assert.equal(s.recoveryEmail(1),'new@example.com');
    assert.equal(s.confirmRecoveryEmail(1,token),false);
    const expired=await s.requestRecoveryEmail(1,'later@example.com','original-password');
    db.prepare('UPDATE email_verifications SET expires=0').run();
    assert.equal(s.confirmRecoveryEmail(1,expired),false);
    assert.equal(s.recoveryEmail(1),'new@example.com');
  }finally{db.close()}
});

test('an account trial is issued once and expires after three days',async()=>{
  const db=new DatabaseSync(':memory:'),s=accounts(db,30);
  try{
    await s.register('trial-member','test-password-123');
    const trial=s.createAccountTrial(1);
    assert.ok(trial.key.startsWith('kb_'));
    assert.equal(s.byKey(trial.key).quota,750);
    assert.equal(s.createAccountTrial(1),null);
    db.prepare('UPDATE api_keys SET expires=? WHERE uid=?').run(Date.now()-1,1);
    assert.equal(s.byKey(trial.key),undefined);
    assert.equal(s.createAccountTrial(1),null);
  }finally{db.close()}
});

test('only a paid, matching invoice grants a single expiring key; retries, renewals and cancellation',async()=>{
  process.env.STRIPE_SECRET_KEY='sk_test_fixture';
  const env={STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_PRICE_2500:'price_fixture'};
  const db=new DatabaseSync(':memory:'),s=accounts(db,30);
  try{
    await s.register('member','a-test-password');
    const end=Math.floor(Date.now()/1000)+86400;
    const invoice={id:'in_first',status:'paid',currency:'usd',customer:'cus_test',amount_paid:799,billing_reason:'subscription_create',
      parent:{subscription_details:{subscription:'sub_test',metadata:{uid:'1'}}},
      lines:{data:[{pricing:{price_details:{price:'price_fixture'}},period:{end}}]}};
    const pay=(obj,override={})=>applyStripeEvent({created:end-86400,livemode:false,type:'invoice.paid',data:{object:obj},...override},s,env);
    pay({...invoice,status:'open'});pay(invoice,{livemode:true});pay({...invoice,lines:{data:[]}});
    assert.equal(s.user(1).keys.length,0);
    pay(invoice);pay(invoice);
    const key=s.user(1).keys[0].key;
    assert.equal(s.byKey(key).quota,2500);assert.equal(s.user(1).keys.length,1);
    const keyId=s.user(1).keys[0].id;
    assert.equal(s.rotateKey(999,keyId),null);
    const replacement=s.rotateKey(1,keyId);
    assert.equal(s.byKey(key),undefined);assert.equal(s.byKey(replacement).quota,2500);
    assert.equal(s.salesStats().total.cents,799);
    pay({...invoice,id:'in_next',billing_reason:'subscription_cycle',lines:{data:[{price:{id:'price_fixture'},period:{end:end+86400}}]}});
    assert.equal(s.user(1).keys[0].key,replacement);assert.equal(s.salesStats().customers[0].renewals,1);
    assert.equal(s.billing(1,0).invoices.length,2);
    assert.equal(s.reserve(replacement,(end+86400)*1000),401);
    applyStripeEvent({type:'customer.subscription.deleted',livemode:false,data:{object:{id:'sub_test'}}},s,env);
    pay(invoice);assert.equal(s.byKey(key),undefined);
  }finally{db.close();}
});
