/**
 * The demo that actually uses an agent.
 *
 * Every listing here is honest -- no injection, no manipulation. The agent
 * reads the catalogue and orders faithfully, and Spendward still stops four of
 * the five, because the products genuinely breach the mandate. That is the
 * ordinary case: most breaches are overspending, not attacks.
 *
 * The last task asks for something the mandate never granted at all, which no
 * amount of good behaviour by the agent can make allowable.
 *
 * It is also the reliable case. The benchmark found model susceptibility to
 * injection varies from 1-in-6 to 4-in-6, but these outcomes held on every
 * model tested.
 *
 * Run with: npm run demo:agent
 */
import { spawnSync } from "node:child_process";

const live = process.env.SPENDWARD_CATALOG === "channel3";

import { FIXED, LIVE } from "./tasks.js";

const TASKS = (live ? LIVE : FIXED).map((s) => [`${s.expect.padEnd(16)} - ${s.title}`, s.task] as const);

console.log(live ? "catalogue: Channel3 (live)" : "catalogue: fixed");

for (const [label, task] of TASKS) {
  console.log(`\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}`);
  spawnSync("npx", ["tsx", "--env-file=.env", "src/agent/shopper.ts", task], { stdio: "inherit" });
}
