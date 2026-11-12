import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftSchema, explainIssues } from "../src/lib/drafter.js";

const base = { maxTransactionAmount: 100, approvalCeiling: 120, maxTotalAmount: 300, budgetPeriod: "month", maxQuantity: 1,
  allowedMerchants: ["bestbuy.com"], allowedCategories: [], allowSubscriptions: false, expiresInDays: 30 };

test("signing problems read as plain sentences with the form's labels", () => {
  const noShop = DraftSchema.safeParse({ ...base, allowedMerchants: [] });
  assert.equal(noShop.success, false);
  assert.equal(explainIssues(noShop.error!.issues), "Shops: name at least one shop the agent may buy from.");
  const zero = DraftSchema.safeParse({ ...base, maxTransactionAmount: 0 });
  assert.equal(explainIssues(zero.error!.issues), "Per payment: must be more than 0.");
  const period = DraftSchema.safeParse({ ...base, budgetPeriod: "year" });
  assert.equal(explainIssues(period.error!.issues), "Budget resets: pick one of the options.");
});
