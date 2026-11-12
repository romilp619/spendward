#!/usr/bin/env bash
# The dashboard on a public address, with PayPal webhooks, without touching the
# deployed site's webhook.
#
#   npm run tunnel
#
# 1. Starts a Cloudflare quick tunnel to this machine.
# 2. Points this machine's own PayPal webhook (PAYPAL_WEBHOOK_ID_LOCAL) at it,
#    creating that webhook the first time and saving its id to .env.
#    PAYPAL_WEBHOOK_ID, the deployed site's webhook, is never changed here.
# 3. Starts the dashboard with that address and that webhook. Ctrl+C stops both.
#
# .env is not given the tunnel address, so plain `npm run web` keeps using
# localhost after the tunnel is gone.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env here; run npm run setup first"; exit 1; }
set -a; . ./.env; set +a
PORT="${PORT:-3000}"
API="${PAYPAL_API_BASE:-https://api-m.sandbox.paypal.com}"

LOG="$(mktemp)"
CONF="$(mktemp --suffix=.yml)"   # empty config: ignore any ~/.cloudflared/config.yml
echo "starting a tunnel to port $PORT..."
npx --yes cloudflared tunnel --config "$CONF" --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID 2>/dev/null || true; rm -f "$CONF" "$LOG"' EXIT
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "the tunnel did not report an address:"; cat "$LOG"; exit 1; }
echo "public address: $URL"

TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$API/v1/oauth2/token" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
[ -n "$TOKEN" ] || { echo "PayPal refused the credentials in .env"; exit 1; }

HOOK_URL="$URL/paypal/webhook"
LOCAL_ID="${PAYPAL_WEBHOOK_ID_LOCAL:-}"
if [ -n "$LOCAL_ID" ] && [ "$LOCAL_ID" = "${PAYPAL_WEBHOOK_ID:-}" ]; then
  echo "PAYPAL_WEBHOOK_ID_LOCAL is the same webhook as PAYPAL_WEBHOOK_ID (the deployed site's)."
  echo "Remove PAYPAL_WEBHOOK_ID_LOCAL from .env and run this again; a separate one will be created."
  exit 1
fi

if [ -n "$LOCAL_ID" ]; then
  RES=$(curl -s -X PATCH "$API/v1/notifications/webhooks/$LOCAL_ID" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "[{\"op\":\"replace\",\"path\":\"/url\",\"value\":\"$HOOK_URL\"}]")
  if echo "$RES" | python3 -c "import json,sys; sys.exit(0 if json.load(sys.stdin).get('url') else 1)"; then
    echo "local webhook $LOCAL_ID -> $HOOK_URL"
  else
    echo "the saved local webhook is gone; creating a new one"
    LOCAL_ID=""
  fi
fi

if [ -z "$LOCAL_ID" ]; then
  RES=$(curl -s -X POST "$API/v1/notifications/webhooks" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"url\":\"$HOOK_URL\",\"event_types\":[{\"name\":\"*\"}]}")
  LOCAL_ID=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  [ -n "$LOCAL_ID" ] || { echo "PayPal did not create the webhook: $RES"; exit 1; }
  python3 - "$LOCAL_ID" <<'PY'
import re, sys, pathlib
p = pathlib.Path(".env"); t = p.read_text()
line = f"PAYPAL_WEBHOOK_ID_LOCAL={sys.argv[1]}"
t = re.sub(r"^PAYPAL_WEBHOOK_ID_LOCAL=.*$", line, t, flags=re.M) if re.search(r"^PAYPAL_WEBHOOK_ID_LOCAL=", t, re.M) \
    else t.rstrip("\n") + "\n# This machine's own PayPal webhook, used by npm run tunnel.\n" + line + "\n"
p.write_text(t)
PY
  echo "created local webhook $LOCAL_ID -> $HOOK_URL (saved to .env)"
fi
[ -n "${PAYPAL_WEBHOOK_ID:-}" ] && echo "deployed site's webhook $PAYPAL_WEBHOOK_ID: not changed"

echo
echo "dashboard: http://localhost:$PORT   (public: $URL)"
echo "Ctrl+C stops the dashboard and the tunnel."
echo
# Environment values win over --env-file, so this run alone uses the tunnel and
# the local webhook.
PUBLIC_URL="$URL" PAYPAL_WEBHOOK_ID="$LOCAL_ID" PORT="$PORT" npx tsx --env-file=.env src/web/server.ts
