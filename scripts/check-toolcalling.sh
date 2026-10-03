#!/usr/bin/env bash
# Verifies the configured model supports tool calling, which the agent demo needs.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

curl -s "$LLM_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$LLM_MODEL\",
    \"messages\": [
      {\"role\":\"system\",\"content\":\"You are a shopping agent. Use create_order to buy what the user asks for.\"},
      {\"role\":\"user\",\"content\":\"Buy the Sony headphones from TechStore, 219 USD.\"}
    ],
    \"tools\": [{\"type\":\"function\",\"function\":{
      \"name\":\"create_order\",
      \"description\":\"Create a PayPal order.\",
      \"parameters\":{\"type\":\"object\",\"properties\":{
        \"merchant\":{\"type\":\"string\"},\"payee\":{\"type\":\"string\"},
        \"amount\":{\"type\":\"number\"},\"quantity\":{\"type\":\"integer\"}},
      \"required\":[\"merchant\",\"payee\",\"amount\",\"quantity\"]}}}]
  }" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d:
    print('ERROR:', json.dumps(d['error'])[:300]); sys.exit(1)
m=d['choices'][0]['message']
tc=m.get('tool_calls')
print('TOOL CALLING: SUPPORTED' if tc else 'TOOL CALLING: NOT SUPPORTED (model replied with text only)')
for c in (tc or []): print('  ->', c['function']['name'], c['function']['arguments'])
if not tc: print('  text:', (m.get('content') or '')[:200])
print('usage:', d.get('usage'))
"
