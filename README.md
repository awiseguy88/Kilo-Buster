# Kilo Buster Cloud

The Railway edition provides individual accounts and API keys for Kilo Buster. The [desktop edition](https://github.com/awiseguy88/Kilo-Buster/tree/main) is maintained on `main`.

## Set up Railway

1. Attach a persistent volume to the service at `/data`. Run one replica. Accounts, sessions, quotas, and usage share the SQLite database on that volume. The server uses Railway's volume mount path by default. If you previously set `PROXY_STATE_FILE`, point it to `/data/proxy-health-state.json`. To retain existing aggregate statistics, move the existing state files there before switching.
2. Set a private `ADMIN_PASSWORD` in Railway Variables (12–256 characters; never commit it or place it in the README). Admin sessions are HttpOnly/SameSite cookies, expire after 12 hours, and are invalidated if the configured password changes. `DEFAULT_REQUESTS_PER_HOUR` sets the suggested hourly limit for new keys (default 30). For usage-request emails, configure `RESEND_API_KEY` and `USAGE_EMAIL_FROM` with a sender verified in Resend.
3. Connect this service to the `railway` branch and deploy. Use Node 22.13 or later and `npm start`. The service listens on Railway's `PORT`; if overriding `HOST`, use `0.0.0.0`.
4. Open `/admin`, sign in, and select **Load proxies** after each service restart. In **API key management**, enter a username, password and hourly limit to create an account with its first key. Copy the full key when shown and give the credentials to the user privately. For an existing account, create additional keys, edit their limits, delete individual keys, or revoke all access.

## Use the API

The public homepage and `/pricing` work without signing in or enabling JavaScript. Standard plans are monthly subscriptions. Users can sign in to view invoices, open Manage billing, and copy their subscription key.

### Self-serve billing rollout

1. In the **same Stripe sandbox** as your Checkout prices, enable **invoice.paid** and **customer.subscription.deleted** on the existing Railway endpoint `/stripe/webhook`. Keep the endpoint signing secret in Railway. Verify all four `STRIPE_PRICE_<hourly limit>` values and `STRIPE_SECRET_KEY` belong to that environment.
2. Configure Stripe's hosted customer portal for invoice history, cancellation and your four recurring prices. For immediate plan changes, invoice prorations immediately and require successful payment. Enable paid-invoice receipt emails in Stripe. Set your business contact and approved refund policy there.
3. Test a new sandbox subscription on a dedicated Railway staging service and volume. A signed paid invoice must activate a **single** subscription key. Verify replaying it does not issue another key, renewal extends the key, and cancellation at the end of the term retains access until then. Cancellation taking effect ends access; a failed renewal cannot extend it.
4. Previously approved manual keys have no subscription linkage. Review existing paid accounts individually at cutover; do not replay historical invoices to create duplicate entitlements. Legacy payment records stay available to admin. New sales reports use verified paid invoices, in UTC, filtered to the current Stripe mode; they show gross collected USD before refunds and fees. Historical records without mode or invoice identity are not counted. Do not reuse a staging database or test secrets for live payments.

Sign in at `/login` with your assigned username and password. Self-registration is also available and creates an account with no keys. The account panel lists assigned keys by suffix, usage and remaining requests. Use the site's `/v1` base URL, an administrator-issued bearer key, and model `kilo-auto/free`. **Need more usage?** lets users send a requested rate and reply email to aaronwise@aaronwiseai.com.

Each accepted chat request counts once against its key’s rolling 60-minute limit, including calls that later fail upstream. Internal retries and model discovery do not consume extra requests. Token and lifetime totals remain with the account when a key is deleted. Revoking an account disables sessions and removes all of its keys. Existing keys from the earlier single-key portal retain their limits and rolling usage on upgrade.

The admin allocation panel compares the sum of active key limits with the number of currently available proxies multiplied by the per-proxy hourly limit. It also shows remaining proxy attempts after actual usage. Overassignment is advisory.

Set `SUPPORT_EMAIL` to the address that should receive customer usage requests and problem reports. If omitted, it defaults to `aaronwise@aaronwiseai.com`.

Set `ALERT_EMAIL` to receive service alerts using the configured Resend sender. The service checks every five minutes for zero available proxies, welcome emails awaiting retry, and Stripe webhook processing errors; alerts are limited to one per hour per running instance. The administrator page also shows these conditions. Configure an independent uptime monitor against `/healthz`: the application cannot send an alert while it is offline, and a health check only confirms the process responds, not that upstream AI requests succeed.

The administrator **Service monitoring** panel can turn monitoring emails on or off immediately. The setting persists in the database and does not disable dashboard indicators or customer emails. An email already being sent may still arrive after disabling alerts.

### Manual database backup

In **Admin → User access**, select **Download database backup**. The snapshot includes account records, sessions, encrypted keys, subscriptions and usage; store it privately. It does not contain the proxy list, Railway environment variables or your encryption secret. Keep a separate secure copy of `KEY_ENCRYPTION_SECRET` (or the existing `ADMIN_PASSWORD` if no separate secret was configured): encrypted keys cannot be recovered without the original secret.

To test a restore, use a separate staging service and volume. Stop that service before placing the downloaded snapshot at the configured database path (`PROXY_STATE_FILE` plus `.tokens.sqlite`, or `/data/proxy-health-state.json.tokens.sqlite` with the default volume configuration). Start staging with the original encryption secret and verify accounts, keys and usage. Never overwrite the production database while the app is running; retain a separate current backup before any production restore.
