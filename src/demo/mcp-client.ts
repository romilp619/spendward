/**
 * Drives the Spendward MCP server the way a real MCP client would, so the
 * enforcement can be seen from the agent's side.
 * Run with: npm run demo:mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && k !== "MANDATE_PRIVATE_KEY")) as Record<string, string>,
});

const client = new Client({ name: "spendward-demo", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools exposed:", tools.map((t) => t.name).join(", "));

async function call(label: string, name: string, args: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text?: string }>;
  const text = content.map((c) => c.text ?? "").join("\n");
  // An escalation comes back as an error so the agent stops, but calling it
  // "refused" on screen contradicts the message right underneath it.
  console.log(!r.isError ? "ALLOWED" : text.includes("escalated") ? "ESCALATED" : "REFUSED");
  for (const c of content) if (c.text) console.log(c.text);
}

await call("legitimate purchase", "create_order", {
  currencyCode: "USD",
  items: [{ name: "Sony Headphones", quantity: 1, unitAmount: 219 }],
  merchant: "TechStore", category: "electronics", payee: "TechStore",
});

await call("injected: 3 units, funds redirected", "create_order", {
  currencyCode: "USD",
  items: [{ name: "Sony Headphones", quantity: 3, unitAmount: 219 }],
  merchant: "TechStore", category: "electronics", payee: "account-XYZ",
  sourceContext: "product description on listing page",
});

await call("over limit, within ceiling", "create_order", {
  currencyCode: "USD",
  items: [{ name: "Bose QuietComfort Ultra", quantity: 1, unitAmount: 289 }],
  merchant: "TechStore", category: "electronics", payee: "TechStore",
});

await call("tool escalation", "create_refund", { captureId: "0NY123456789" });

await client.close();
