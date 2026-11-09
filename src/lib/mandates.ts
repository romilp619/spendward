import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dataPath } from "./data.js";
import { join } from "node:path";
import type { SignedMandate } from "./mandate.js";
import { spentUnder } from "./audit.js";
import { revokedAt } from "./revocations.js";
import type { LedgerState, PaymentRequest } from "./policy.js";
import { lookup } from "./listings.js";
import { resolvePayee } from "./merchants.js";

/**
 * Every mandate the principal has signed, plus which one is in force.
 *
 * The enforcement point reads the active mandate on every call rather than
 * once at startup, so a mandate the principal signs or switches to in the
 * dashboard governs the very next request, without restarting the agent.
 */
const dir = () => process.env.SPENDWARD_MANDATES ?? dataPath("mandates");
const activeFile = () => join(dir(), "active.json");
const safe = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);

export function save(signed: SignedMandate): void {
  if (!safe(signed.mandate.id)) throw new Error(`invalid mandate id: ${signed.mandate.id}`);
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${signed.mandate.id}.json`), JSON.stringify(signed, null, 2) + "\n");
}

export function all(): SignedMandate[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith(".json") && f !== "active.json")
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir(), f), "utf8")) as SignedMandate; } catch { return null; }
    })
    .filter((m): m is SignedMandate => m !== null && typeof m.mandate?.id === "string")
    .sort((a, b) => b.mandate.issuedAt.localeCompare(a.mandate.issuedAt));
}

export function byId(id: string | null | undefined): SignedMandate | null {
  if (!id || !safe(id)) return null;
  const override = fromEnv();
  if (override?.mandate.id === id) return override;
  const p = join(dir(), `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as SignedMandate) : null;
}

/** SPENDWARD_MANDATE pins one file, which the benchmark uses to stay isolated. */
function fromEnv(): SignedMandate | null {
  const p = process.env.SPENDWARD_MANDATE;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SignedMandate;
}

export function active(): SignedMandate | null {
  const pinned = fromEnv();
  if (pinned) return pinned;
  if (!existsSync(activeFile())) return null;
  try {
    return byId((JSON.parse(readFileSync(activeFile(), "utf8")) as { id: string }).id);
  } catch {
    return null;
  }
}

export function activate(id: string): SignedMandate {
  const m = byId(id);
  if (!m) throw new Error(`no mandate ${id}`);
  mkdirSync(dir(), { recursive: true });
  writeFileSync(activeFile(), JSON.stringify({ id, since: new Date().toISOString() }) + "\n");
  return m;
}

/**
 * Everything the rules need besides the mandate and the request. One function
 * so the agent's path and the approval path cannot disagree about what has
 * been spent or where money would go.
 */
export function ledgerFor(signed: SignedMandate, request: PaymentRequest | null): LedgerState {
  const m = signed.mandate;
  const buying = request?.tool === "create_order";
  return {
    spent: spentUnder(m.id, Date.now(), m.budgetPeriod),
    revokedAt: revokedAt(m.id),
    ...(buying ? {
      payeeAccount: resolvePayee(m, request.merchant)?.account ?? null,
      listings: lookup((request.items ?? []).map((i) => i.productId).filter((x): x is string => Boolean(x))),
    } : {}),
  };
}
