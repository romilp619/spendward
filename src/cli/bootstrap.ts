/**
 * Prepares an empty data directory on first start, then gets out of the way.
 * Run before the server by `npm start`, so a fresh host (a new Render disk)
 * comes up with its merchant directory and signed demo mandates. Never
 * overwrites anything that already exists, and never writes a .env file:
 * on a host the keys come from its environment.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { signMandate } from "../lib/mandate.js";
import { activate, active, all, save } from "../lib/mandates.js";
import { dataPath } from "../lib/data.js";
import { preset } from "./presets.js";

mkdirSync(dataPath("."), { recursive: true });

// The merchant directory travels as one environment variable on a host.
const merchants = process.env.SPENDWARD_MERCHANTS ?? dataPath("merchants.json");
if (!existsSync(merchants) && process.env.MERCHANTS_JSON) {
  try {
    writeFileSync(merchants, JSON.stringify(JSON.parse(process.env.MERCHANTS_JSON), null, 2) + "\n");
    console.log("bootstrap: wrote the merchant directory");
  } catch {
    console.log("bootstrap: MERCHANTS_JSON is not valid JSON; paste it exactly as `npm run render:env` wrote it");
  }
}

if (all().length === 0) {
  const key = process.env.MANDATE_PRIVATE_KEY;
  if (!key || !existsSync(merchants)) {
    console.log("bootstrap: no mandates yet; set MANDATE_PRIVATE_KEY and MERCHANTS_JSON to create the demo ones");
  } else {
    for (const live of [false, true]) save(signMandate(preset(live), key));
    console.log("bootstrap: signed the demo mandates");
  }
}
if (!active() && all().some((m) => m.mandate.id === "mnd_demo_001")) {
  activate("mnd_demo_001");
  console.log("bootstrap: active mandate mnd_demo_001");
}
