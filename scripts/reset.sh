#!/usr/bin/env bash
# Clears demo state: the audit trail, parked approvals, and webhook events.
# Mandates are left alone -- mint a new one only if you change its terms.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f audit.jsonl approvals.json paypal-events.jsonl revoked.json
# The saved wallet and signed mandates are kept: they are set up once, not per demo.
echo "Demo state cleared. Run 'npm run demo' to repopulate."
