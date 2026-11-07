import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mandate, req, signed } from "./helpers.js";
import { evaluate } from "../src/lib/policy.js";
import { resolvePayee } from "../src/lib/merchants.js";

const dir = mkdtempSync(path.join(tmpdir(), "spendward-merchants-"));
process.env.SPENDWARD_MERCHANTS = path.join(dir, "merchants.json");
writeFileSync(process.env.SPENDWARD_MERCHANTS, JSON.stringify({
  "bestbuy.com": { name: "Best Buy", payee: "DIRECTORYACCT" },
  "macys.com": { name: "Macy's", payee: "MACYSACCOUNT1" },
}));

test("an allowed merchant pays the account signed into the mandate, not the directory", () => {
  const p = resolvePayee(mandate(), "bestbuy.com");
  assert.deepEqual(p, { account: "TESTMERCHANT1", name: "Best Buy", source: "mandate" });
});

test("a merchant outside the mandate resolves through the directory, for the approver to see", () => {
  assert.equal(resolvePayee(mandate(), "macys.com")?.account, "MACYSACCOUNT1");
});

test("a merchant with no PayPal account on record cannot be paid, or approved", () => {
  const d = evaluate(signed(), req({ merchant: "shady.example", recipient: "shady.example" }), { spent: 0, payeeAccount: null });
  assert.equal(d.outcome, "BLOCK");
  assert.ok(d.violations.some((v) => v.rule === "UNKNOWN_PAYEE" && !v.escalatable));
});

test("a known payee adds no violation", () => {
  const d = evaluate(signed(), req(), { spent: 0, payeeAccount: "TESTMERCHANT1" });
  assert.equal(d.outcome, "ALLOW");
});
