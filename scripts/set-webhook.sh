#!/usr/bin/env bash
# Points the PayPal webhook at a deployed dashboard: npm run webhook -- https://your-app.onrender.com
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${1:?usage: npm run webhook -- https://your-app.onrender.com}"
URL="${URL%/}"
set -a; . ./.env; set +a
[ -n "${PAYPAL_WEBHOOK_ID:-}" ] || { echo "PAYPAL_WEBHOOK_ID is not set in .env"; exit 1; }
TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials \
  "$PAYPAL_API_BASE/v1/oauth2/token" | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")
curl -s -X PATCH "$PAYPAL_API_BASE/v1/notifications/webhooks/$PAYPAL_WEBHOOK_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "[{\"op\":\"replace\",\"path\":\"/url\",\"value\":\"$URL/paypal/webhook\"}]" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('PayPal webhook ->', d.get('url') or d)"
