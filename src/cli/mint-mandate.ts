/**
 * Mints a signed mandate. The signing key never leaves the machine that runs
 * this, which is what prevents an agent from issuing itself a wider grant.
 * Usage: npm run mint -- src/mandates/demo.json
 */
import { writeFileSync } from "node:fs";
import { signMandate, type Mandate } from "../lib/mandate.js";

/**
 * Two presets. The fixed catalogue uses an invented merchant so the benchmark
 * is reproducible; the live one allows a real retailer, because against
 * Channel3's 25,000 sellers a merchant allowlist is doing real work.
 */
const live = process.argv.includes("--live");
const out = process.argv.find((a) => a.endsWith(".json")) ?? (live ? "src/mandates/live.json" : "src/mandates/demo.json");
const key = process.env.MANDATE_SIGNING_KEY;
if (!key) throw new Error("MANDATE_SIGNING_KEY is not set");

const mandate: Mandate = {
  id: live ? "mnd_live_001" : "mnd_demo_001",
  principal: "romil",
  agent: "shopper-01",
  issuedAt: new Date().toISOString(),
  // Demo mandates outlive hackathon judging. A real grant should be much
  // shorter -- expiry is what bounds the damage of a mandate nobody revoked.
  expiresAt: new Date(Date.now() + Number(process.env.MANDATE_DAYS ?? 120) * 864e5).toISOString(),
  currency: "USD",
  maxTransactionAmount: 250,
  maxTotalAmount: 1000,
  approvalCeiling: 300,
  maxQuantity: 1,
  allowedMerchants: live ? ["bestbuy.com"] : ["TechStore"],
  // Channel3 categorises by its own taxonomy, so a live mandate cannot assume
  // the word "electronics". Category is enforced only for the fixed catalogue.
  allowedCategories: live ? [] : ["electronics"],
  allowSubscriptions: false,
  allowedTools: ["search_products", "create_order", "get_order", "pay_order"],
};

writeFileSync(out, JSON.stringify(signMandate(mandate, key), null, 2) + "\n");
console.log(`Signed mandate written to ${out}`);
console.log(`  ${mandate.currency} ${mandate.maxTransactionAmount} per transaction, ${mandate.maxTotalAmount} total`);
console.log(`  merchants: ${mandate.allowedMerchants.join(", ")}`);
console.log(`  tools: ${mandate.allowedTools.join(", ")}`);
