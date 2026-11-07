/**
 * One-time setup: keys, merchant directory, demo mandates.
 * Run with: npm run setup
 *
 * Safe to run again. It never replaces a key that already exists or a
 * merchant directory you have edited.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { generateKeys, publicKeyOf, signMandate } from "../lib/mandate.js";
import { activate, save } from "../lib/mandates.js";
import { getAccessToken } from "../lib/paypal.js";
import { preset } from "./presets.js";

const ENV = ".env";
const env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
const has = (k: string) => new RegExp(`^${k}=.+`, "m").test(env);
const add: string[] = [];

if (!has("MANDATE_PRIVATE_KEY")) {
  const { privateKey, publicKey } = generateKeys();
  add.push(
    "# The principal's mandate signing key. Only the dashboard and `npm run mint` use it;",
    "# the MCP server the agent talks to holds the public key alone.",
    `MANDATE_PRIVATE_KEY=${privateKey}`,
    `MANDATE_PUBLIC_KEY=${publicKey}`,
  );
  process.env.MANDATE_PRIVATE_KEY = privateKey;
  process.env.MANDATE_PUBLIC_KEY = publicKey;
  console.log("generated an Ed25519 mandate key pair");
} else if (!has("MANDATE_PUBLIC_KEY")) {
  const publicKey = publicKeyOf(process.env.MANDATE_PRIVATE_KEY!);
  add.push(`MANDATE_PUBLIC_KEY=${publicKey}`);
  process.env.MANDATE_PUBLIC_KEY = publicKey;
}
if (!has("AUDIT_KEY")) {
  const key = randomBytes(32).toString("hex");
  add.push("# Keys the audit chain, so it cannot be rewritten by someone without this value.", `AUDIT_KEY=${key}`);
  process.env.AUDIT_KEY = key;
  console.log("generated an audit chain key");
}
if (add.length) appendFileSync(ENV, (env.endsWith("\n") || !env ? "" : "\n") + add.join("\n") + "\n", { mode: 0o600 });

/**
 * Every sandbox app comes with one business account. Until you create one per
 * shop, all demo merchants map to it -- the payee binding still works, every
 * shop simply shares a till. Found by asking PayPal who an order with no
 * payee would pay.
 */
async function ownMerchantId(): Promise<string | null> {
  try {
    const base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const created = (await (await fetch(`${base}/v2/checkout/orders`, {
      method: "POST", headers,
      body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }),
    })).json()) as { id: string };
    const order = (await (await fetch(`${base}/v2/checkout/orders/${created.id}`, { headers })).json()) as {
      purchase_units?: Array<{ payee?: { merchant_id?: string } }>;
    };
    return order.purchase_units?.[0]?.payee?.merchant_id ?? null;
  } catch {
    return null;
  }
}

if (!existsSync("merchants.json")) {
  const id = await ownMerchantId();
  if (!id) {
    console.log("could not reach PayPal to find your sandbox business account; copy merchants.example.json to merchants.json and fill it in");
  } else {
    const shared = (name: string) => ({ name: `${name} (your sandbox business account)`, payee: id });
    writeFileSync("merchants.json", JSON.stringify({
      TechStore: shared("TechStore"), AudioWorld: shared("AudioWorld"),
      "bestbuy.com": shared("Best Buy"), "macys.com": shared("Macy's"),
    }, null, 2) + "\n");
    console.log(`wrote merchants.json: every demo shop pays your sandbox business account ${id}`);
    console.log("  for separate shops, create one sandbox business account each and put their IDs here");
  }
}

if (existsSync("merchants.json")) {
  for (const live of [false, true]) {
    const m = preset(live);
    save(signMandate(m, process.env.MANDATE_PRIVATE_KEY!));
    console.log(`signed ${m.id}`);
  }
  activate("mnd_demo_001");
  console.log("active mandate: mnd_demo_001");
}
console.log("\nsetup done. Next: npm run web, then npm run demo");
