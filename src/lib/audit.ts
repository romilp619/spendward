import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
  violations: Decision["violations"];
  paypalOrderId: string | null;
  /** Where the agent's instruction came from, when it is known. */
  sourceContext: string | null;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const path = () => process.env.PAYGUARD_AUDIT_LOG ?? "audit.jsonl";

function digest(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
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
    violations: input.decision.violations,
    paypalOrderId: input.paypalOrderId,
    sourceContext: input.request?.sourceContext ?? null,
    prevHash: prev?.hash ?? GENESIS,
  };

  const entry: AuditEntry = { ...body, hash: digest(body) };
  appendFileSync(path(), JSON.stringify(entry) + "\n");
  return entry;
}

export function entries(): AuditEntry[] {
  return readAll();
}

/** Total allowed spend recorded so far, which is what the policy engine caps. */
export function spentUnder(mandateId: string): number {
  return readAll()
    .filter((e) => e.mandateId === mandateId && e.outcome === "ALLOW")
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
}

export interface ChainCheck {
  valid: boolean;
  brokenAt: number | null;
  reason: string | null;
}

/** Walks the chain and reports the first entry that does not verify. */
export function verifyChain(): ChainCheck {
  let prevHash = GENESIS;
  for (const entry of readAll()) {
    const { hash, ...body } = entry;
    if (body.prevHash !== prevHash) {
      return { valid: false, brokenAt: entry.seq, reason: "prevHash does not match the preceding entry" };
    }
    if (digest(body) !== hash) {
      return { valid: false, brokenAt: entry.seq, reason: "entry contents do not match its hash" };
    }
    prevHash = hash;
  }
  return { valid: true, brokenAt: null, reason: null };
}
