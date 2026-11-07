import { existsSync, readFileSync } from "node:fs";
import type { Mandate } from "./mandate.js";

/**
 * Who each merchant is at PayPal.
 *
 * PayPal's create_order has no notion of "the shop the agent found": an order
 * pays whatever account its payee names. So Spendward keeps the mapping from a
 * merchant to a PayPal account itself and writes the payee onto every order.
 * The agent's own description of who it is paying is checked against the
 * merchant, but it never decides where money goes.
 *
 * Allowed merchants carry their account inside the signed mandate. The
 * directory covers merchants outside the mandate, so that when the principal
 * approves one they see -- and approve -- the actual destination.
 */
export interface MerchantEntry {
  /** Human name shown at approval time. */
  name: string;
  /** PayPal merchant ID (13 characters) or business account email. */
  payee: string;
}

const path = () => process.env.SPENDWARD_MERCHANTS ?? "merchants.json";

export function directory(): Record<string, MerchantEntry> {
  if (!existsSync(path())) return {};
  try {
    return JSON.parse(readFileSync(path(), "utf8")) as Record<string, MerchantEntry>;
  } catch {
    return {};
  }
}

export interface ResolvedPayee {
  account: string;
  name: string;
  /** Where the binding came from: the principal's signature, or the directory. */
  source: "mandate" | "directory";
}

export function resolvePayee(m: Mandate, merchant: string): ResolvedPayee | null {
  const signed = m.payees?.[merchant];
  if (signed) return { account: signed, name: directory()[merchant]?.name ?? merchant, source: "mandate" };
  const listed = directory()[merchant];
  return listed ? { account: listed.payee, name: listed.name, source: "directory" } : null;
}

/** PayPal accepts a payee as either a merchant ID or an email address. */
export function payeeField(account: string): { email_address: string } | { merchant_id: string } {
  return account.includes("@") ? { email_address: account } : { merchant_id: account };
}
