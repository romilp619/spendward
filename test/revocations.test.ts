import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { revoke, revokedAt } from "../src/lib/revocations.js";

test("revocation is recorded once and stays", () => {
  process.env.SPENDWARD_REVOCATIONS = path.join(mkdtempSync(path.join(tmpdir(), "sw-rev-")), "revoked.json");
  assert.equal(revokedAt("mnd_a"), null);
  const first = revoke("mnd_a");
  assert.equal(revokedAt("mnd_a"), first);
  assert.equal(revoke("mnd_a"), first, "revoking again keeps the original time");
  assert.equal(revokedAt("mnd_b"), null, "other mandates are unaffected");
});
