import { test } from "node:test";
import assert from "node:assert/strict";
import { mandate, req } from "./helpers.js";
import { generateKeys, signMandate, verifyMandate } from "../src/lib/mandate.js";
import { evaluate } from "../src/lib/policy.js";

test("a mandate verifies with the principal's public key", () => {
  const s = signMandate(mandate(), process.env.MANDATE_PRIVATE_KEY!);
  assert.ok(verifyMandate(s, process.env.MANDATE_PUBLIC_KEY!));
});

test("a mandate signed by any other key is refused, even if well formed", () => {
  const stranger = generateKeys();
  const s = signMandate(mandate({ maxTransactionAmount: 99999 }), stranger.privateKey);
  const d = evaluate(s, req({ amount: 5000 }), { spent: 0 });
  assert.equal(d.outcome, "BLOCK");
  assert.deepEqual(d.violations.map((v) => v.rule), ["MANDATE_SIGNATURE_INVALID"]);
});

test("the enforcement side needs no private key to verify", () => {
  const s = signMandate(mandate(), process.env.MANDATE_PRIVATE_KEY!);
  const priv = process.env.MANDATE_PRIVATE_KEY;
  delete process.env.MANDATE_PRIVATE_KEY;
  try {
    assert.equal(evaluate(s, req(), { spent: 0 }).outcome, "ALLOW");
  } finally {
    process.env.MANDATE_PRIVATE_KEY = priv;
  }
});

test("changing where a merchant's money goes breaks the signature", () => {
  const good = signMandate(mandate(), process.env.MANDATE_PRIVATE_KEY!);
  const redirected = { ...good, mandate: { ...good.mandate, payees: { "bestbuy.com": "ATTACKERACCT1" } } };
  assert.equal(verifyMandate(redirected, process.env.MANDATE_PUBLIC_KEY!), false);
});
