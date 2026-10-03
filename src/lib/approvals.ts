import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Decision, PaymentRequest } from "./policy.js";

/**
 * A payment the mandate would not allow outright but which the principal is
 * entitled to permit. It is parked here until they decide, and PayPal is not
 * contacted either way until they do.
 */
export interface PendingApproval {
  id: string;
  createdAt: string;
  agent: string;
  mandateId: string | null;
  request: PaymentRequest;
  violations: Decision["violations"];
  status: "PENDING" | "APPROVED" | "REJECTED";
  decidedAt: string | null;
  /** Set once an approved request has been sent to PayPal. */
  paypalOrderId: string | null;
  approveUrl: string | null;
}

const path = () => process.env.PAYGUARD_APPROVALS ?? "approvals.json";

function readAll(): PendingApproval[] {
  const p = path();
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as PendingApproval[];
}

function writeAll(list: PendingApproval[]): void {
  writeFileSync(path(), JSON.stringify(list, null, 2) + "\n");
}

export function park(input: {
  agent: string;
  decision: Decision;
  request: PaymentRequest;
}): PendingApproval {
  const entry: PendingApproval = {
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    agent: input.agent,
    mandateId: input.decision.mandateId,
    request: input.request,
    violations: input.decision.violations,
    status: "PENDING",
    decidedAt: null,
    paypalOrderId: null,
    approveUrl: null,
  };
  writeAll([...readAll(), entry]);
  return entry;
}

export function list(): PendingApproval[] {
  return readAll();
}

export function get(id: string): PendingApproval | undefined {
  return readAll().find((a) => a.id === id);
}

export function decide(
  id: string,
  status: "APPROVED" | "REJECTED",
  order?: { id: string; approveUrl: string | null },
): PendingApproval | undefined {
  const all = readAll();
  const entry = all.find((a) => a.id === id);
  if (!entry || entry.status !== "PENDING") return undefined;

  entry.status = status;
  entry.decidedAt = new Date().toISOString();
  if (order) {
    entry.paypalOrderId = order.id;
    entry.approveUrl = order.approveUrl;
  }
  writeAll(all);
  return entry;
}
