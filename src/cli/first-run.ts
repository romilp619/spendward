/**
 * Runs before `npm run web`, so that one command is all anyone needs.
 *
 * Checks that .env has the keys only you can provide, and on the first run sets
 * the copy up (signing key, merchant directory, demo mandates). On every later
 * run it changes nothing: it never re-signs mandates or switches the active one.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ENV = ".env";
if (!existsSync(ENV)) {
  copyFileSync(".env.example", ENV);
  console.log("Created .env from .env.example.");
}

const env = Object.fromEntries(
  readFileSync(ENV, "utf8").split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null && m[2]!.trim() !== "")
    .map((m) => [m[1]!, m[2]!.trim()]),
);

const needed: [string, string][] = [
  ["PAYPAL_CLIENT_ID", "PayPal developer dashboard > Apps & Credentials (Sandbox) > your app"],
  ["PAYPAL_CLIENT_SECRET", "same page as the Client ID"],
  ["LLM_BASE_URL", "your model provider's OpenAI-compatible URL, e.g. https://api.openai.com/v1"],
  ["LLM_API_KEY", "your model provider's API key"],
  ["LLM_MODEL", "a model with tool calling"],
];
const missing = needed.filter(([k]) => !env[k]);
if (missing.length) {
  console.log("\nAlmost there. Fill these in .env, then run the same command again:\n");
  for (const [k, where] of missing) console.log(`  ${k.padEnd(22)} ${where}`);
  console.log("\nStep-by-step help: docs/SETUP.md\n");
  process.exit(1);
}

const mandatesDir = process.env.SPENDWARD_MANDATES ?? "mandates";
const hasMandates = existsSync(mandatesDir) && readdirSync(mandatesDir).some((f) => f.endsWith(".json") && f !== "active.json");
if (!env.MANDATE_PRIVATE_KEY || !existsSync(process.env.SPENDWARD_MERCHANTS ?? "merchants.json") || !hasMandates) {
  console.log("First run: setting up (signing key, shops, demo mandates)...\n");
  const r = spawnSync(process.execPath, ["--env-file=.env", "--import", "tsx", "src/cli/setup.ts"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log("");
}
