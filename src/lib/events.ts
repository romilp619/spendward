import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { dataPath } from "./data.js";

/**
 * A webhook PayPal sent us. Kept separately from the audit log: the audit log
 * records what Spendward decided, and these record what PayPal independently
 * reports happened. Conflating them would let an outside party write into the
 * record of our own decisions.
 */
export interface PayPalEvent {
  at: string;
  type: string;
  resourceId: string | null;
  /** SUCCESS, FAILURE, or why verification could not be performed. */
  verification: string;
  summary: string | null;
}

const path = () => process.env.SPENDWARD_EVENTS ?? dataPath("paypal-events.jsonl");

export function recordEvent(event: PayPalEvent): void {
  appendFileSync(path(), JSON.stringify(event) + "\n");
}

export function recentEvents(limit = 20): PayPalEvent[] {
  const p = path();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PayPalEvent)
    .slice(-limit)
    .reverse();
}
