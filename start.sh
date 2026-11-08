#!/bin/sh
set -eu
cd "$(dirname "$0")"
PORT="${PORT:-43817}"
if [ -x ./runtime/node ]; then NODE=./runtime/node; else NODE=node; fi
API_AUTH_TOKEN="$("$NODE" ./api-key.mjs)"
export PORT API_AUTH_TOKEN
printf 'API key: %s\nAPI: http://127.0.0.1:%s/v1\n' "$API_AUTH_TOKEN" "$PORT"
# The generated key is URL-safe. Custom keys should also use URL-safe characters.
url="http://127.0.0.1:$PORT/dashboard?token=$API_AUTH_TOKEN"
if command -v xdg-open >/dev/null 2>&1; then (sleep 2; xdg-open "$url" >/dev/null 2>&1 || true) &
elif command -v open >/dev/null 2>&1; then (sleep 2; open "$url" || true) & fi
exec "$NODE" ./server.mjs
