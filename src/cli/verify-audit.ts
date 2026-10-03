/** Walks the audit chain and reports the first entry that does not verify. */
import { entries, verifyChain } from "../lib/audit.js";

const log = entries();
const check = verifyChain();

for (const e of log) {
  console.log(`#${e.seq}  ${e.outcome.padEnd(16)} ${e.tool.padEnd(15)} ${e.amount ?? "-"}  ${e.hash.slice(0, 12)}...`);
}
console.log("");
console.log(check.valid ? `CHAIN INTACT (${log.length} entries)` : `CHAIN BROKEN at entry #${check.brokenAt}: ${check.reason}`);
process.exit(check.valid ? 0 : 1);
