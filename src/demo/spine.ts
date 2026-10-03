/**
 * Stage 1 demo: proves the enforcement point gates a real PayPal call.
 * Run with: npm run demo:spine
 */
import { signMandate, type Mandate } from "../lib/mandate.js";
import type { PaymentRequest } from "../lib/policy.js";
import { guardedPurchase } from "../lib/guard.js";

const mandate: Mandate = {
  id: "mnd_001",
  principal: "romil",
  agent: "shopper-01",
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 864e5).toISOString(),
  currency: "USD",
  maxTransactionAmount: 250,
  maxTotalAmount: 500,
  approvalCeiling: 300,
  maxQuantity: 1,
  allowedMerchants: ["TechStore"],
  allowedCategories: ["electronics"],
  allowSubscriptions: false,
  allowedTools: ["search_products", "create_order", "capture_order"],
};

const key = process.env.MANDATE_SIGNING_KEY;
if (!key) throw new Error("MANDATE_SIGNING_KEY is not set");
const signed = signMandate(mandate, key);

const urls = {
  returnUrl: "http://localhost:3000/paypal/return",
  cancelUrl: "http://localhost:3000/paypal/cancel",
};

const legitimate: PaymentRequest = {
  tool: "create_order",
  amount: 219,
  currency: "USD",
  quantity: 1,
  merchant: "TechStore",
  category: "electronics",
  recipient: "TechStore",
  isSubscription: false,
};

const injected: PaymentRequest = {
  ...legitimate,
  amount: 1057,
  quantity: 3,
  recipient: "account-XYZ",
  sourceContext: "product description on malicious listing",
};

const cases: Array<readonly [string, PaymentRequest]> = [
  ["LEGITIMATE PURCHASE", legitimate],
  ["INJECTED PURCHASE", injected],
];

for (const [label, request] of cases) {
  const result = await guardedPurchase(signed, request, { spent: 0 }, urls);
  console.log(`\n=== ${label} ===`);
  console.log("decision:", result.decision.outcome);
  for (const v of result.decision.violations) {
    console.log(`  ${v.severity.padEnd(8)} ${v.rule}`);
    console.log(`           ${v.evidence}`);
  }
  console.log("paypal:", result.order ? `order ${result.order.id} (${result.order.status})` : "NO CALL MADE");
  if (result.order?.approveUrl) console.log("checkout:", result.order.approveUrl);
}
