import { test } from "node:test";
import assert from "node:assert/strict";
import { freshLog, req, signed } from "./helpers.js";
import { periodStart, record, spentUnder } from "../src/lib/audit.js";
import { evaluate } from "../src/lib/policy.js";

test("periods start at the UTC day, Monday and first of the month", () => {
  const t = Date.UTC(2026, 10, 7, 15, 30); // Saturday 7 Nov 2026
  assert.equal(new Date(periodStart("day", t)).toISOString(), "2026-11-07T00:00:00.000Z");
  assert.equal(new Date(periodStart("week", t)).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(periodStart("month", t)).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(periodStart("none", t), 0);
});

test("a monthly budget only counts this month's orders", () => {
  freshLog();
  const allow = { outcome: "ALLOW" as const, violations: [], mandateId: "mnd_test" };
  record({ agent: "a", tool: "create_order", decision: allow, request: req({ amount: 200 }), paypalOrderId: "OLD" });
  record({ agent: "a", tool: "pay_order", decision: allow, request: req({ amount: 200, tool: "pay_order" }), paypalOrderId: "OLD" });
  const nextMonth = Date.now() + 40 * 864e5;
  assert.equal(spentUnder("mnd_test", Date.now(), "month"), 200);
  assert.equal(spentUnder("mnd_test", nextMonth, "month"), 0);
  assert.equal(spentUnder("mnd_test", nextMonth, "none"), 200);
});

test("the budget refusal says which period ran out", () => {
  const d = evaluate(signed({ budgetPeriod: "month" }), req({ amount: 200 }), { spent: 900 });
  const v = d.violations.find((x) => x.rule === "CUMULATIVE_LIMIT");
  assert.match(v!.evidence, /this month/);
  assert.match(v!.policy, /per month/);
});
