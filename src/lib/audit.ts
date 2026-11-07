import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import type { BudgetPeriod } from "./mandate.js";
import type { Decision, PaymentRequest } from "./policy.js";

export interface AuditEntry {
  seq: number;
  at: string;
  agent: string;
  mandateId: string | null;
  tool: string;
  outcome: Decision["outcome"];
  amount: number | null;
  currency: string | null;
  quantity: number | null;
  merchant: string | null;
  recipient: string | null;
  category: string | null;
  isSubscription: boolean | null;
  violations: Decision["violations"];
  paypalOrderId: string | null;
  /** Where the agent's instruction came from, when it is known. */
  sourceContext: string | null;
  /**
   * The PayPal account the money was sent to, as Spendward set it on the order
   * (not as the agent described it). Null when no payment was made.
   */
  payeeAccount: string | null;
  /**
   * Set when Spendward allowed the call but PayPal refused it. Such a call
   * still belongs in the record: it was authorized and it was attempted.
   */
  error: string | null;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const path = () => process.env.SPENDWARD_AUDIT_LOG ?? "audit.jsonl";

/**
 * With AUDIT_KEY set each link is an HMAC, so someone who can edit the file
 * but does not hold the key cannot rewrite history and recompute a valid
 * chain. A plain hash only catches edits made by someone who did not bother
 * to recompute. The dashboard says which of the two is in force.
 */
export const chainKeyed = () => Boolean(process.env.AUDIT_KEY);
function digest(entry: Omit<AuditEntry, "hash">): string {
  const key = process.env.AUDIT_KEY;
  return (key ? createHmac("sha256", key) : createHash("sha256")).update(JSON.stringify(entry)).digest("hex");
}

function readAll(): AuditEntry[] {
  const p = path();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEntry);
}

/**
 * Appends a decision to the log, chaining it to the previous entry's hash.
 * Editing or removing any earlier line breaks every hash after it, so the log
 * is tamper-evident without needing to be tamper-proof.
 */
export function record(input: {
  agent: string;
  tool: string;
  decision: Decision;
  request: PaymentRequest | null;
  paypalOrderId: string | null;
  error?: string | null;
  payeeAccount?: string | null;
}): AuditEntry {
  const existing = readAll();
  const prev = existing[existing.length - 1];

  const body: Omit<AuditEntry, "hash"> = {
    seq: existing.length + 1,
    at: new Date().toISOString(),
    agent: input.agent,
    mandateId: input.decision.mandateId,
    tool: input.tool,
    outcome: input.decision.outcome,
    amount: input.request?.amount ?? null,
    currency: input.request?.currency ?? null,
    quantity: input.request?.quantity ?? null,
    merchant: input.request?.merchant ?? null,
    recipient: input.request?.recipient ?? null,
    category: input.request?.category ?? null,
    isSubscription: input.request?.isSubscription ?? null,
    violations: input.decision.violations,
    paypalOrderId: input.paypalOrderId,
    sourceContext: input.request?.sourceContext ?? null,
    payeeAccount: input.payeeAccount ?? null,
    error: input.error ?? null,
    prevHash: prev?.hash ?? GENESIS,
  };

  const entry: AuditEntry = { ...body, hash: digest(body) };
  appendFileSync(path(), JSON.stringify(entry) + "\n");
  return entry;
}

export function entries(): AuditEntry[] {
  return readAll();
}

/**
 * How long an order that nobody has paid for keeps holding budget. PayPal does
 * not report abandoned checkouts, so a reservation that never lapsed would let
 * one unpaid order use up a mandate for good. SPENDWARD_RESERVE_HOURS overrides.
 */
const reserveMs = () => Number(process.env.SPENDWARD_RESERVE_HOURS ?? 3) * 3_600_000;

export interface OrderState {
  orderId: string;
  mandateId: string | null;
  agent: string;
  amount: number;
  currency: string | null;
  merchant: string | null;
  at: string;
  /** The money has moved: a pay_order was recorded for this order. */
  captured: boolean;
  /** Not yet paid, but recent enough to still hold budget. */
  held: boolean;
  /** The create_order entry, so a capture can be recorded against the same request. */
  source: AuditEntry;
}

/**
 * Every order Spendward let through to PayPal, whatever path it took: allowed
 * outright, or approved after an escalation. Orders PayPal rejected are not
 * here -- they committed no money.
 */
export function orders(now = Date.now()): OrderState[] {
  const all = readAll();
  const paid = new Set(
    all.filter((e) => e.tool === "pay_order" && e.outcome === "ALLOW" && !e.error && e.paypalOrderId).map((e) => e.paypalOrderId),
  );
  return all
    .filter((e) => e.tool === "create_order" && e.outcome === "ALLOW" && !e.error && e.paypalOrderId)
    .map((e) => {
      const captured = paid.has(e.paypalOrderId);
      return {
        orderId: e.paypalOrderId!, mandateId: e.mandateId, agent: e.agent, amount: e.amount ?? 0,
        currency: e.currency, merchant: e.merchant, at: e.at, captured,
        held: !captured && now - Date.parse(e.at) < reserveMs(), source: e,
      };
    });
}

export interface Spend {
  /** Paid for: money that has actually moved. */
  collected: number;
  /** Ordered, not yet paid, still holding budget. */
  held: number;
}

/** Start of the budget period containing `now`, in UTC. Weeks start on Monday. */
export function periodStart(period: BudgetPeriod | undefined, now = Date.now()): number {
  const d = new Date(now);
  switch (period ?? "none") {
    case "day": return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "week": return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    case "month": return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    default: return 0;
  }
}

export function spend(mandateId: string, now = Date.now(), period?: BudgetPeriod): Spend {
  const from = periodStart(period, now);
  const mine = orders(now).filter((o) => o.mandateId === mandateId && Date.parse(o.at) >= from);
  return {
    collected: mine.filter((o) => o.captured).reduce((s, o) => s + o.amount, 0),
    held: mine.filter((o) => o.held).reduce((s, o) => s + o.amount, 0),
  };
}

/**
 * What the cumulative cap is enforced against: money that moved plus orders
 * still waiting to be paid. Each order counts once, however it is captured.
 */
export function spentUnder(mandateId: string, now = Date.now(), period?: BudgetPeriod): number {
  const s = spend(mandateId, now, period);
  return Math.round((s.collected + s.held) * 100) / 100;
}

export interface ChainCheck {
  valid: boolean;
  /** Whether links are keyed (HMAC) or plain hashes. */
  keyed?: boolean;
  brokenAt: number | null;
  reason: string | null;
}

/** Walks the chain and reports the first entry that does not verify. */
export function verifyChain(): ChainCheck {
  let prevHash = GENESIS;
  for (const entry of readAll()) {
    const { hash, ...body } = entry;
    if (body.prevHash !== prevHash) {
      return { valid: false, keyed: chainKeyed(), brokenAt: entry.seq, reason: "prevHash does not match the preceding entry" };
    }
    if (digest(body) !== hash) {
      return { valid: false, keyed: chainKeyed(), brokenAt: entry.seq, reason: "entry contents do not match its hash" };
    }
    prevHash = hash;
  }
  return { valid: true, keyed: chainKeyed(), brokenAt: null, reason: null };
}
