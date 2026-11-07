import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signMandate, type Mandate } from "../src/lib/mandate.js";
import type { PaymentRequest } from "../src/lib/policy.js";

process.env.MANDATE_SIGNING_KEY = "test-key-not-a-secret";

export const KEY = process.env.MANDATE_SIGNING_KEY;

export function mandate(over: Partial<Mandate> = {}): Mandate {
  return {
    id: "mnd_test", principal: "tester", agent: "shopper-01",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    currency: "USD", maxTransactionAmount: 250, maxTotalAmount: 1000, approvalCeiling: 300, maxQuantity: 1,
    allowedMerchants: ["bestbuy.com"], allowedCategories: [], allowSubscriptions: false,
    allowedTools: ["search_products", "create_order", "get_order", "pay_order"],
    ...over,
  };
}
export const signed = (over: Partial<Mandate> = {}) => signMandate(mandate(over), KEY);

export function req(over: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    tool: "create_order", amount: 59.99, currency: "USD", quantity: 1,
    merchant: "bestbuy.com", category: "In-Ear Headphones", recipient: "bestbuy.com", isSubscription: false,
    ...over,
  };
}

/** A fresh, empty audit log for one test. */
export function freshLog() {
  const dir = mkdtempSync(path.join(tmpdir(), "spendward-test-"));
  process.env.SPENDWARD_AUDIT_LOG = path.join(dir, "audit.jsonl");
  return process.env.SPENDWARD_AUDIT_LOG;
}
