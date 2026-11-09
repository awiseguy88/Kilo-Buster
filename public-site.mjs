const plans = [
  ['Starter', 2500, '7.99'], ['Builder', 5000, '12.99'],
  ['Studio', 7500, '19.99'], ['Team', 10000, '29.99']
];

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
    <nav aria-label="Main"><a href="/pricing">Pricing</a><a href="/setup">Setup guide</a><a href="/login">Sign in</a><a href="/register">Create account</a></nav></header>
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
    </main><footer>Operated by Aaron Wise AI · Independent of Kilo, OpenAI and Anthropic. <a href="mailto:aaronwise@aaronwiseai.com">Contact support</a></footer>
    <script>
    const choices = [...document.querySelectorAll('[data-plan]')];
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
