#!/usr/bin/env bash
# Verifies the Channel3 key works and shows what the agent would see.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

curl -s -X POST https://api.trychannel3.com/v1/search \
  -H "x-api-key: $CHANNEL3_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"wireless noise cancelling headphones","limit":6,"config":{"currency":"USD","country":"US"}}' \
  | python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print('non-JSON response:', raw[:300]); sys.exit(1)
if isinstance(d, dict) and ('error' in d or 'detail' in d):
    print('ERROR:', json.dumps(d)[:400]); sys.exit(1)
items = d if isinstance(d, list) else d.get('products') or d.get('results') or []
print(f'{len(items)} products returned\n')
for p in items[:6]:
    offers = p.get('offers') or [{}]
    o = offers[0]
    price = o.get('price')
    if isinstance(price, dict): price = price.get('price') or price.get('amount')
    print(f\"  {str(price):>8}  {(o.get('domain') or '?')[:22]:<22} {p.get('title','')[:52]}\")
"
