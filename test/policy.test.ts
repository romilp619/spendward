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
  const forged = { ...good, mandate: { ...good.mandate, maxTransactionAmount: 99999 } };
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
  const r = await guardedPurchase(signMandate(mandate(), process.env.MANDATE_PRIVATE_KEY!), req({ amount: 378 }), { spent: 0 },
    { returnUrl: "http://x", cancelUrl: "http://x" });
  assert.equal(r.decision.outcome, "BLOCK");
  assert.equal(r.order, null);
});

test("a revoked mandate refuses even a purchase that is otherwise fine", () => {
  const d = evaluate(signed(), req(), { spent: 0, revokedAt: "2026-11-07T10:00:00.000Z" });
  assert.equal(d.outcome, "BLOCK");
  assert.deepEqual(rules(d), ["MANDATE_REVOKED"]);
});

test("an escalation cannot be approved once the mandate is revoked", () => {
  // What the approve endpoint re-runs at the moment of approval.
  const parked = req({ merchant: "macys.com", recipient: "macys.com", amount: 39.95 });
  assert.equal(evaluate(signed(), parked, { spent: 0 }).outcome, "REQUIRE_APPROVAL");
  assert.equal(evaluate(signed(), parked, { spent: 0, revokedAt: "2026-11-07T10:00:00.000Z" }).outcome, "BLOCK");
});

test("an escalation cannot be approved once the budget has filled", () => {
  const parked = req({ amount: 289 });
  assert.equal(evaluate(signed(), parked, { spent: 100 }).outcome, "REQUIRE_APPROVAL");
  assert.equal(evaluate(signed(), parked, { spent: 800 }).outcome, "BLOCK");
});

test("a category matches as whole words inside the shop's own name", async () => {
  const { categoryAllowed } = await import("../src/lib/policy.js");
  assert.ok(categoryAllowed(["headphones"], "In-Ear Headphones"));
  assert.ok(categoryAllowed(["in-ear headphones"], "In-Ear Headphones"));
  assert.ok(!categoryAllowed(["headphones"], "Headphone Stands"));
  assert.ok(!categoryAllowed(["electronics"], "jewellery"));
  assert.ok(!categoryAllowed([""], "anything"));
});
