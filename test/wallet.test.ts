import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveWallet, wallet } from "../src/lib/wallet.js";

const dir = mkdtempSync(path.join(tmpdir(), "spendward-wallet-"));
process.env.SPENDWARD_WALLET = path.join(dir, "wallet.json");
process.env.AUDIT_KEY = "test-audit-key";
const w = { vaultId: "TOKEN123456", email: "buyer@example.com", customerId: "C1", connectedAt: "2026-11-08T00:00:00Z" };

test("the saved wallet is encrypted at rest and reads back intact", () => {
  saveWallet(w);
  const raw = readFileSync(process.env.SPENDWARD_WALLET!, "utf8");
  assert.ok(!raw.includes("TOKEN123456"), "the token must not be readable in the file");
  assert.deepEqual(wallet(), w);
});

test("a wallet saved before encryption is sealed on first read", () => {
  writeFileSync(process.env.SPENDWARD_WALLET!, JSON.stringify(w));
  assert.deepEqual(wallet(), w);
  assert.ok(!readFileSync(process.env.SPENDWARD_WALLET!, "utf8").includes("TOKEN123456"));
});

test("the file is useless without the key", () => {
  saveWallet(w);
  process.env.AUDIT_KEY = "a-different-key";
  assert.equal(wallet(), null);
  process.env.AUDIT_KEY = "test-audit-key";
});
