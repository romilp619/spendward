/**
 * Signs a demo mandate with the principal's key and makes it the active one.
 * Usage: npm run mint            (fixed catalogue)
 *        npm run mint:live       (live catalogue)
 */
import { principalKey, signMandate } from "../lib/mandate.js";
import { activate, save } from "../lib/mandates.js";
import { preset } from "./presets.js";

const live = process.argv.includes("--live");
const mandate = preset(live, process.env.SPENDWARD_PRINCIPAL ?? "you");
save(signMandate(mandate, principalKey()));
activate(mandate.id);

console.log(`Signed and activated ${mandate.id}`);
console.log(`  ${mandate.currency} ${mandate.maxTransactionAmount} per transaction, ${mandate.maxTotalAmount} per ${mandate.budgetPeriod}`);
console.log(`  merchants: ${mandate.allowedMerchants.map((m) => `${m} -> ${mandate.payees[m]}`).join(", ")}`);
console.log(`  tools: ${mandate.allowedTools.join(", ")}`);
