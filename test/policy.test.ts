import { test } from "node:test";
import assert from "node:assert/strict";
import { req, signed, mandate } from "./helpers.js";
import { evaluate } from "../src/lib/policy.js";
import { signMandate } from "../src/lib/mandate.js";
import { guardedPurchase } from "../src/lib/guard.js";

const rules = (d: ReturnType<typeof evaluate>) => d.violations.map((v) => v.rule).sort();

test("a purchase inside the mandate is allowed", () => {
  const d = evaluate(signed(), req(), { spent: 0 });
  assert.equal(d.outcome, "ALLOW");
  assert.deepEqual(d.violations, []);
});

test("over the limit but under the ceiling asks the principal", () => {
  const d = evaluate(signed(), req({ amount: 289 }), { spent: 0 });
  assert.equal(d.outcome, "REQUIRE_APPROVAL");
  assert.deepEqual(rules(d), ["MANDATE_MAX_AMOUNT"]);
});

test("above the approval ceiling is refused outright", () => {
  const d = evaluate(signed(), req({ amount: 378 }), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
});

test("a merchant off the allowlist is escalated, not refused", () => {
  const d = evaluate(signed(), req({ merchant: "macys.com", recipient: "macys.com", amount: 39.95 }), { spent: 0 });
  assert.equal(d.outcome, "REQUIRE_APPROVAL");
  assert.deepEqual(rules(d), ["MERCHANT_NOT_ALLOWED"]);
});

test("a tool outside the grant is refused", () => {
  const d = evaluate(signed(), req({ tool: "create_refund" }), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
  assert.ok(rules(d).includes("TOOL_NOT_PERMITTED"));
});

test("a display name in the payee field is refused (the Best Buy run)", () => {
  const d = evaluate(signed(), req({ recipient: "Best Buy" }), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
  assert.deepEqual(rules(d), ["UNAUTHORIZED_RECIPIENT"]);
});

test("an edited mandate fails its signature and nothing else is consulted", () => {
  const good = signed();
  const forged = { mandate: { ...good.mandate, maxTransactionAmount: 99999 }, signature: good.signature };
  const d = evaluate(forged, req({ amount: 5000 }), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
  assert.deepEqual(rules(d), ["MANDATE_SIGNATURE_INVALID"]);
});

test("an expired mandate refuses everything", () => {
  const d = evaluate(signed({ expiresAt: "2020-01-01T00:00:00.000Z" }), req(), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
  assert.ok(rules(d).includes("MANDATE_EXPIRED"));
});

test("the total cap cannot be waived by approval", () => {
  const d = evaluate(signed(), req({ amount: 200 }), { spent: 900 });
  assert.equal(d.outcome, "BLOCK");
  assert.ok(rules(d).includes("CUMULATIVE_LIMIT"));
});

test("a subscription under a one-time mandate is refused", () => {
  const d = evaluate(signed(), req({ isSubscription: true }), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
  assert.ok(rules(d).includes("SUBSCRIPTION_NOT_ALLOWED"));
});

test("an empty category list leaves category unconstrained", () => {
  assert.equal(evaluate(signed({ allowedCategories: [] }), req({ category: "anything" }), { spent: 0 }).outcome, "ALLOW");
  const d = evaluate(signed({ allowedCategories: ["electronics"] }), req({ category: "anything" }), { spent: 0 });
  assert.ok(rules(d).includes("CATEGORY_NOT_ALLOWED"));
});

test("a refused purchase never reaches PayPal", async () => {
  // Credentials are deliberately absent: any PayPal call would throw.
  delete process.env.PAYPAL_CLIENT_ID;
  const r = await guardedPurchase(signMandate(mandate(), process.env.MANDATE_SIGNING_KEY!), req({ amount: 378 }), { spent: 0 },
    { returnUrl: "http://x", cancelUrl: "http://x" });
  assert.equal(r.decision.outcome, "BLOCK");
  assert.equal(r.order, null);
});
