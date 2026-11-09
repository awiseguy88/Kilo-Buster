# Kilo Buster Cloud

The Railway edition provides individual accounts and API keys for Kilo Buster. The [desktop edition](https://github.com/awiseguy88/Kilo-Buster/tree/main) is maintained on `main`.

## Set up Railway

1. Attach a persistent volume to the service at `/data`. Run one replica. Accounts, sessions, quotas, and usage share the SQLite database on that volume. The server uses Railway's volume mount path by default. If you previously set `PROXY_STATE_FILE`, point it to `/data/proxy-health-state.json`. To retain existing aggregate statistics, move the existing state files there before switching.
2. Set a new private `ADMIN_PASSWORD` in the service variables. This replaces the old shared dashboard login. Choose the default account limit with `DEFAULT_REQUESTS_PER_HOUR` (default 30).
3. Connect this service to the `railway` branch and deploy. Use Node 22.13 or later and `npm start`. The service listens on Railway's `PORT`; if overriding `HOST`, use `0.0.0.0`.
4. Open `/admin`, sign in, and select **Load proxies**. Repeat the import after each service restart. Open **User access** to generate keys, update hourly limits, or revoke accounts.

## Use the API

Register at `/register` with a username and password, or sign in at `/login`. Open `/account` and generate a key. Use the site's `/v1` base URL, that key as a bearer credential, and model `kilo-auto/free`. A replacement key immediately invalidates the previous key. Existing clients using the old shared token must switch to an account key.

Each accepted chat request counts once against the account's rolling 60-minute limit, including calls that later fail upstream. Internal retries, model discovery, and rejected calls do not consume extra account requests. Token totals count usage reported by the upstream. Revocation disables the user's sessions and key. Restoring access allows sign-in and issuing a fresh key.

The admin allocation panel compares enabled users' combined hourly limits with the number of currently available proxies multiplied by the per-proxy hourly limit. It also shows the remaining proxy attempts after actual usage. Retries consume proxy attempts and proxies in cooldown are excluded. An overassigned allocation is advisory.
