import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { freshLog, req } from "./helpers.js";
import { record, verifyChain, orders, spend, spentUnder } from "../src/lib/audit.js";

const allow = { outcome: "ALLOW" as const, violations: [], mandateId: "mnd_test" };
const block = { outcome: "BLOCK" as const, violations: [], mandateId: "mnd_test" };

test("an untouched chain verifies, and editing one entry breaks it there", () => {
  const log = freshLog();
  record({ agent: "a", tool: "create_order", decision: allow, request: req(), paypalOrderId: "O1" });
  record({ agent: "a", tool: "create_order", decision: block, request: req({ amount: 378 }), paypalOrderId: null });
  record({ agent: "a", tool: "create_order", decision: allow, request: req({ amount: 39.95 }), paypalOrderId: "O2" });
  assert.equal(verifyChain().valid, true);

  const lines = readFileSync(log, "utf8").trim().split("\n");
  lines[1] = lines[1]!.replace('"amount":378', '"amount":3.78');
  writeFileSync(log, lines.join("\n") + "\n");
  const check = verifyChain();
  assert.equal(check.valid, false);
  assert.equal(check.brokenAt, 2);
});

test("an allowed order holds budget until it is paid, then counts once", () => {
  freshLog();
  record({ agent: "a", tool: "create_order", decision: allow, request: req({ amount: 59.99 }), paypalOrderId: "O1" });
  assert.deepEqual(spend("mnd_test"), { collected: 0, held: 59.99 });
  assert.equal(orders()[0]!.captured, false);

  record({ agent: "a", tool: "pay_order", decision: allow, request: req({ tool: "pay_order", amount: 59.99 }), paypalOrderId: "O1" });
  assert.deepEqual(spend("mnd_test"), { collected: 59.99, held: 0 });
  assert.equal(spentUnder("mnd_test"), 59.99);
});

test("a capture recorded without an amount still counts the order's amount", () => {
  freshLog();
  record({ agent: "a", tool: "create_order", decision: allow, request: req({ amount: 39.95 }), paypalOrderId: "O9" });
  // The agent's own pay_order tool records no request.
  record({ agent: "a", tool: "pay_order", decision: allow, request: null, paypalOrderId: "O9" });
  assert.deepEqual(spend("mnd_test"), { collected: 39.95, held: 0 });
});

test("an unpaid order stops holding budget after the reservation window", () => {
  freshLog();
  record({ agent: "a", tool: "create_order", decision: allow, request: req({ amount: 100 }), paypalOrderId: "O1" });
  const later = Date.now() + 4 * 3_600_000;
  assert.equal(spentUnder("mnd_test", later), 0);
  assert.equal(orders(later)[0]!.held, false);
});

test("an order PayPal rejected spends nothing", () => {
  freshLog();
  record({ agent: "a", tool: "create_order", decision: allow, request: req({ amount: 100 }), paypalOrderId: null, error: "PayPal 422" });
  assert.equal(spentUnder("mnd_test"), 0);
  assert.equal(orders().length, 0);
});
