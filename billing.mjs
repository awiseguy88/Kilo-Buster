// A subscription update is not proof of payment. Fulfill only a paid invoice
// for this service's configured price, owner and Stripe environment.
export function applyStripeEvent(event,store,env=process.env){
  const item=event.data?.object;
  const live=/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY||'');
  if(!item || event.livemode!==live)return;
  if(event.type==='customer.subscription.deleted'){store.endSubscription(item.id);return;}
  if(event.type!=='invoice.paid'||item.status!=='paid'||item.currency!=='usd')return;
  const details=item.parent?.subscription_details||item.subscription_details;
  const uid=Number(details?.metadata?.uid), sub=details?.subscription||item.subscription;
  if(!uid||!Number.isSafeInteger(uid)||typeof sub!=='string'||!item.id)return;
  const plans=[2500,5000,7500,10000];
  const matches=(item.lines?.data||[]).filter(line=>!(line.amount<0)).map(line=>{
    const price=line.pricing?.price_details?.price||line.price?.id;
    return {quota:price&&plans.find(n=>env['STRIPE_PRICE_'+n]===price),end:line.period?.end};
  }).filter(x=>x.quota&&Number.isSafeInteger(x.end));
  if(matches.length!==1||!Number.isSafeInteger(item.amount_paid)||item.amount_paid<0)return;
  store.paidInvoice({uid,sub,customer:item.customer,invoice:item.id,quota:matches[0].quota,end:matches[0].end*1000,
    amount:item.amount_paid,paid:(item.status_transitions?.paid_at||event.created)*1000,
    url:item.hosted_invoice_url||null,live:Number(live),renewal:Number(item.billing_reason==='subscription_cycle')});
}
