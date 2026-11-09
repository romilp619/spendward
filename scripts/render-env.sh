#!/usr/bin/env bash
# Writes render.env: exactly the settings the hosted dashboard needs, ready to
# paste into Render's "Add from .env". The file holds secrets and is git-ignored.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env here; run npm run setup first"; exit 1; }
python3 - <<'PY'
import json, re, pathlib
env = {}
for line in pathlib.Path(".env").read_text().splitlines():
    m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
    if m: env[m.group(1)] = m.group(2)
want = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE", "PAYPAL_WEBHOOK_ID",
        "MANDATE_PRIVATE_KEY", "MANDATE_PUBLIC_KEY", "AUDIT_KEY",
        "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "CHANNEL3_API_KEY"]
missing = [k for k in want if not env.get(k)]
out = [f"{k}={env[k]}" for k in want if env.get(k)]
merchants = pathlib.Path("merchants.json")
if merchants.exists():
    out.append("MERCHANTS_JSON=" + json.dumps(json.loads(merchants.read_text()), separators=(",", ":")))
else:
    missing.append("MERCHANTS_JSON (no merchants.json)")
out.append("SPENDWARD_DATA_DIR=/var/data")
p = pathlib.Path("render.env"); p.write_text("\n".join(out) + "\n"); p.chmod(0o600)
print(f"wrote render.env with {len(out)} settings")
if missing: print("missing:", ", ".join(missing))
PY
