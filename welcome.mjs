export function siteOrigin() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 'kilo-buster-production.up.railway.app';
  return new URL(process.env.PUBLIC_BASE_URL || 'https://' + domain).origin;
}

export function welcomeMailer(store) {
  let running = false;
  return async function deliver() {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < 10; i++) {
        const job = store.nextWelcome();
        if (!job) break;
        try {
          const {email, username, temporaryPassword, key, quota} = job.message;
          const origin = siteOrigin();
          const text = [
            'Your Kilo Buster Cloud subscription is ready.',
            'Hourly request limit: ' + quota.toLocaleString('en-US'),
            '', 'Username: ' + username,
            temporaryPassword ? 'Temporary password: ' + temporaryPassword + '\nChoose a new password on your first sign-in. If you already changed it, use your new password.' : 'Use your existing account password.',
            'Sign in: ' + origin + '/login', 'Dashboard: ' + origin + '/account',
            '', 'API key: ' + key, 'API base URL: ' + origin + '/v1',
            'Model: kilo-auto/free', 'Setup guide: ' + origin + '/setup',
            '', 'Keep this email private. Anyone with the API key can use your quota.'
          ].join('\n');
          const response = await fetch('https://api.resend.com/emails', {
            method:'POST', signal:AbortSignal.timeout(10000),
            headers:{Authorization:'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type':'application/json', 'Idempotency-Key':'kb-welcome/' + job.sub},
            body:JSON.stringify({from:process.env.USAGE_EMAIL_FROM, to:[email], subject:'Your Kilo Buster Cloud account and API key', text})
          });
          if (!response.ok || !(await response.json()).id) throw Error('Provider did not accept message');
          store.welcomeSent(job.sub);
        } catch {
          store.welcomeFailed(job.sub,job.attempts);
          console.error('[welcome] Delivery deferred for subscription', job.sub);
        }
      }
    } catch { console.error('[welcome] Unable to read delivery queue'); }
    finally { running = false; }
  };
}
