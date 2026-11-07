import type { Mandate } from "../lib/mandate.js";
import { directory } from "../lib/merchants.js";

/**
 * The two demo mandates. The fixed catalogue uses invented merchants so the
 * benchmark is reproducible; the live one allows a real retailer, because
 * against Channel3's index of sellers a merchant allowlist is doing real work.
 */
export function preset(live: boolean, principal = "you"): Mandate {
  const allowedMerchants = live ? ["bestbuy.com"] : ["TechStore"];
  return {
    id: live ? "mnd_live_001" : "mnd_demo_001",
    principal,
    agent: "shopper-01",
    issuedAt: new Date().toISOString(),
    // Demo mandates outlive hackathon judging. A real grant should be much
    // shorter -- expiry is what bounds the damage of a mandate nobody revoked.
    expiresAt: new Date(Date.now() + Number(process.env.MANDATE_DAYS ?? 120) * 864e5).toISOString(),
    currency: "USD",
    maxTransactionAmount: 250,
    maxTotalAmount: 1000,
    budgetPeriod: "month",
    approvalCeiling: 300,
    maxQuantity: 1,
    allowedMerchants,
    payees: pinPayees(allowedMerchants),
    // Channel3 categorises by its own taxonomy, so a live mandate cannot assume
    // the word "electronics". Category is enforced only for the fixed catalogue.
    allowedCategories: live ? [] : ["electronics"],
    allowSubscriptions: false,
    allowedTools: ["search_products", "create_order", "get_order", "pay_order"],
  };
}

/** Copies each allowed merchant's PayPal account into the mandate, so the signature covers it. */
export function pinPayees(merchants: string[]): Record<string, string> {
  const dir = directory();
  const missing = merchants.filter((m) => !dir[m]);
  if (missing.length) {
    throw new Error(
      `No PayPal account on record for ${missing.join(", ")}. Add it to merchants.json ` +
        `(see merchants.example.json) or run \`npm run setup\`.`,
    );
  }
  return Object.fromEntries(merchants.map((m) => [m, dir[m]!.payee]));
}
