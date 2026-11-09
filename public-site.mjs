const plans = [
  ['Starter', 2500, '7.99'], ['Builder', 5000, '12.99'],
  ['Studio', 7500, '19.99'], ['Team', 10000, '29.99']
];
const github = '<svg aria-hidden="true" viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.14c-3.12.68-3.78-1.33-3.78-1.33-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.63 1.22 3.27.93.1-.73.4-1.22.72-1.5-2.49-.29-5.11-1.25-5.11-5.54 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.71.78 1.14 1.78 1.14 3.01 0 4.3-2.62 5.24-5.12 5.52.4.35.76 1.03.76 2.08v3.09c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg>';
const repo = 'https://github.com/awiseguy88/Kilo-Buster';

function planCard([name, quota, amount]) {
  return `<article class="plan">
    <h3>${name}</h3><p class="price"><strong>$${amount}</strong> / month</p>
    <p class="allowance"><b>${quota.toLocaleString('en-US')}</b> requests per rolling hour</p>
    <button type="button" data-plan="${quota}">Buy ${name}</button>
    </article>`;
}

export function publicPage(path) {
  const pricing = path === '/pricing';
  const hero = `<section class="front-hero"><div><h1>One API for your AI tools.</h1>
    <p>Connect your editor or agent to Kilo’s free model through an OpenAI-compatible endpoint. See requests and tokens in your dashboard.</p>
    <div class="actions"><a class="primary" href="/pricing">See plans</a><a href="/setup">Try it free</a></div></div>
    <img src="/portal/cover.jpg" alt="Kilo Buster artwork" width="1200" height="675"></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${pricing?'Monthly API plans':'An API endpoint for your AI tools'} | Kilo Buster Cloud</title>
    <meta name="description" content="Choose a monthly API plan, receive your personal API key by email and connect your AI tools."><link rel="icon" href="/favicon.ico">
    <link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/cloud.css"><script defer src="/theme.js"></script></head>
    <body class="public"><header><a class="brand" href="/">Kilo Buster <span>Cloud</span></a>
    <nav aria-label="Main"><a href="/pricing">Pricing</a><a href="/setup">Setup guide</a><a href="${repo}" class="github-link">${github} Self-host on GitHub</a><a href="/login">Sign in</a><a href="/register">Create account</a></nav></header>
    <main>${pricing?'':hero}<section class="plan-section"><${pricing?'h1':'h2'}>Monthly plans</${pricing?'h1':'h2'}>
    <p>Choose your hourly limit. Pay securely with Stripe and get your API key by email. All prices are in USD and renew monthly.</p>
    <div class="plan-grid">${plans.map(planCard).join('')}</div><p id="checkout-status" role="status"></p>
    <noscript>Enable JavaScript to start Stripe Checkout.</noscript></section>
    <section class="after-purchase"><h2>From purchase to first request</h2><ol>
    <li><strong>Complete checkout</strong><p>Use an email address you can access.</p></li>
    <li><strong>Open your dashboard</strong><p>New customers choose a password after payment. Your email also includes sign-in details.</p></li>
    <li><strong>Connect your tool</strong><p>Paste your API key and endpoint into an OpenAI-compatible client. Select <code>kilo-auto/free</code>.</p></li></ol></section>
    <section><h2>Before you buy</h2><details><summary>Can I try the endpoint first?</summary><p>The setup guide offers a three-day trial with up to 750 requests per rolling hour.</p></details>
    <details><summary>Already have a Kilo Buster account?</summary><p>Sign in before buying to add the subscription to your existing account.</p><a href="/login">Sign in</a></details>
    <details><summary>How does the hourly limit work?</summary><p>The limit applies over the previous 60 minutes. Upstream availability can reduce throughput. Service is best effort.</p></details></section>
    </main><footer>Operated by Aaron Wise AI · Independent of Kilo, OpenAI and Anthropic. <a href="mailto:aaronwise@aaronwiseai.com">Contact support</a> <a href="${repo}" class="github-link">${github} Self-host on GitHub</a></footer>
    <script>
    const choices = [...document.querySelectorAll('[data-plan]')];
    fetch('/portal/session').then(r=>r.json()).then(session=>{if(!session.signedIn)return;const nav=document.querySelector('header nav');nav.querySelectorAll('a[href="/login"],a[href="/register"]').forEach(a=>a.remove());const account=document.createElement('a');account.href=session.admin?'/dashboard':'/account';account.textContent=session.admin?'Admin dashboard':'My account';nav.append(account);const signout=document.createElement('button');signout.type='button';signout.textContent='Sign out';signout.onclick=async()=>{const r=await fetch('/portal/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(r.ok)location.reload()};nav.append(signout);document.querySelectorAll('details a[href="/login"]').forEach(a=>{a.href=account.href;a.textContent=account.textContent})}).catch(()=>{});
    for (const choice of choices) choice.onclick = async () => {
      const status = document.getElementById('checkout-status');
      choices.forEach(b => b.disabled = true);
      status.textContent = 'Opening Stripe Checkout…';
      try {
        const response = await fetch('/portal/checkout', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({price:Number(choice.dataset.plan)})});
        const result = await response.json();
        if (!response.ok) throw Error(result.error?.message || 'Checkout is unavailable.');
        location.assign(result.url);
      } catch (error) {
        status.textContent = error.message;
        choices.forEach(b => b.disabled = false);
      }
    };
    </script></body></html>`;
}
