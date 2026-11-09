#!/usr/bin/env bash
# Starts a tunnel, then points .env and PayPal's webhook at it.
#
# Quick cloudflared tunnels get a fresh hostname every run, and PayPal's
# dashboard strips the path when a URL is saved there -- so doing this by hand
# means two edits every single time, and forgetting either one breaks checkout
# or webhooks silently.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
LOG="$(mktemp)"
# An empty config of its own. Without it, cloudflared also reads
# ~/.cloudflared/config.yml, which belongs to any named tunnel on this machine;
# that file's catch-all rule then answers every request here with a 404.
CONF="$(mktemp --suffix=.yml)"
echo "starting tunnel on port $PORT..."
npx cloudflared tunnel --config "$CONF" --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true; rm -f "$CONF"' EXIT

for _ in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "${URL:-}" ] || { echo "tunnel did not report a URL"; cat "$LOG"; exit 1; }
echo "tunnel: $URL"

python3 - "$URL" <<'PY'
import re, sys, pathlib
url = sys.argv[1]
p = pathlib.Path('.env'); t = p.read_text()
t = re.sub(r'^PUBLIC_URL=.*$', f'PUBLIC_URL={url}', t, flags=re.M) if re.search(r'^PUBLIC_URL=', t, re.M) \
    else t.rstrip('\n') + f'\nPUBLIC_URL={url}\n'
p.write_text(t)
print("  .env updated")
PY

set -a; . ./.env; set +a
if [ -n "${PAYPAL_WEBHOOK_ID:-}" ]; then
  TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials \
    "$PAYPAL_API_BASE/v1/oauth2/token" | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")
  curl -s -X PATCH "$PAYPAL_API_BASE/v1/notifications/webhooks/$PAYPAL_WEBHOOK_ID" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "[{\"op\":\"replace\",\"path\":\"/url\",\"value\":\"$URL/paypal/webhook\"}]" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print('  PayPal webhook ->', d.get('url') or 'FAILED')"
else
  echo "  PAYPAL_WEBHOOK_ID not set; skipping webhook update"
fi

echo ""
echo "Restart 'npm run web' so it picks up the new PUBLIC_URL."
echo "Leave this terminal open. Ctrl-C stops the tunnel."
wait $TUNNEL_PID
