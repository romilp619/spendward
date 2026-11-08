import { test } from "node:test";
import assert from "node:assert/strict";
import { req, signed } from "./helpers.js";
import { evaluate } from "../src/lib/policy.js";
import type { Listing } from "../src/lib/listings.js";

const earbuds: Listing = { id: "L1", name: "Earbuds", merchant: "bestbuy.com", category: "In-Ear Headphones", unitAmount: 59.99, seenAt: "" };
const item = (over = {}) => ({ productId: "L1", name: "Earbuds", quantity: 1, unitAmount: 59.99, ...over });
const rules = (d: ReturnType<typeof evaluate>) => d.violations.map((v) => v.rule);

test("an order that matches the listing it names is allowed", () => {
  const d = evaluate(signed(), req({ items: [item()] }), { spent: 0, listings: { L1: earbuds } });
  assert.equal(d.outcome, "ALLOW");
});

test("relabelling a stranger's product as an allowed shop's is refused", () => {
  const d = evaluate(signed(), req({ items: [item()] }), { spent: 0, listings: { L1: { ...earbuds, merchant: "shady.example" } } });
  assert.equal(d.outcome, "BLOCK");
  assert.ok(rules(d).includes("LISTING_MISMATCH"));
});

test("a price that differs from the listing is refused, however small the order", () => {
  const d = evaluate(signed(), req({ amount: 69.99, items: [item({ unitAmount: 69.99 })] }), { spent: 0, listings: { L1: earbuds } });
  assert.equal(d.outcome, "BLOCK");
  assert.match(d.violations.find((v) => v.rule === "LISTING_MISMATCH")!.requested, /listed at 59.99, not 69.99/);
});

test("an item that names no listing, or one never shown, is refused", () => {
  const none = evaluate(signed(), req({ items: [item({ productId: undefined })] }), { spent: 0, listings: {} });
  const unseen = evaluate(signed(), req({ items: [item({ productId: "L9" })] }), { spent: 0, listings: { L9: null } });
  assert.equal(none.outcome, "BLOCK");
  assert.equal(unseen.outcome, "BLOCK");
});

test("an extra line no listing offered is refused (the injected add-on)", () => {
  const d = evaluate(signed(), req({ items: [item(), { productId: "L1", name: "Care plan", quantity: 1, unitAmount: 19 }] }),
    { spent: 0, listings: { L1: earbuds } });
  assert.ok(rules(d).includes("LISTING_MISMATCH"));
});

test("calls that buy nothing are not held to a listing", () => {
  const d = evaluate(signed(), req({ tool: "get_order", amount: 0, quantity: 0 }), { spent: 0 });
  assert.ok(!rules(d).includes("LISTING_MISMATCH"));
});
