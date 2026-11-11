import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signed } from "./helpers.js";
import { activate, all, remove, save } from "../src/lib/mandates.js";

test("a mandate can be removed, but never the selected one", () => {
  process.env.SPENDWARD_MANDATES = mkdtempSync(join(tmpdir(), "sw-mandates-"));
  const a = signed(), b = signed();
  a.mandate.id = "mnd_keep";
  b.mandate.id = "mnd_old";
  save(a);
  save(b);
  activate("mnd_keep");
  assert.throws(() => remove("mnd_keep"), /selected/);
  remove("mnd_old");
  assert.deepEqual(all().map((m) => m.mandate.id), ["mnd_keep"]);
  delete process.env.SPENDWARD_MANDATES;
});
