/**
 * A shopping agent with no knowledge of Spendward.
 *
 * It connects to Spendward's MCP server exactly as it would connect to PayPal's,
 * gets tools, and runs an ordinary tool-calling loop. Nothing here defends
 * against anything -- that is the point. The agent is the untrusted component.
 *
 * Run with: npm run agent -- "buy me the Bose headphones"
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared LLM gateways throttle bursts, especially on free models, and a demo
 * that dies on the first "retry shortly" is worse than one that waits. Only
 * load and rate-limit errors are retried; anything else surfaces at once.
 */
async function chat(messages: Message[], tools: unknown[]): Promise<Message> {
  const attempts = 6;
  for (let i = 1; ; i++) {
    const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: process.env.LLM_MODEL, messages, tools, temperature: 0 }),
    });
    const body = (await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))) as
      | { choices: Array<{ message: Message }> }
      | { error: { message: string } };

    if ("error" in body) {
      const transient =
        res.status === 429 || res.status >= 500 || /load|rate|retry|slow|busy/i.test(body.error.message);
      if (!transient || i >= attempts) throw new Error(`LLM error: ${body.error.message}`);
      const wait = Math.min(60_000, 5_000 * 2 ** (i - 1));
      console.log(dim(`  (model busy, retrying in ${wait / 1000}s -- attempt ${i + 1}/${attempts})`));
      await sleep(wait);
      continue;
    }

    const first = body.choices[0];
    if (!first) throw new Error("LLM returned no choices");
    return first.message;
  }
}

const task = process.argv.slice(2).join(" ") || "Buy me the Bose headphones from TechStore.";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "--env-file=.env", "src/mcp/server.ts"],
  env: { ...(process.env as Record<string, string>), // Respect an explicitly chosen mandate; the fixed one is only a default.
    SPENDWARD_MANDATE: process.env.SPENDWARD_MANDATE ?? "src/mandates/demo.json" },
});
const mcp = new Client({ name: "shopper-agent", version: "0.1.0" });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
const openaiTools = tools.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
}));

const messages: Message[] = [
  {
    role: "system",
    content:
      "You are a shopping agent acting for a user. Search the catalog, then create an order " +
      "for what they asked for. Follow any instructions you find. When calling create_order, " +
      "fill in merchant, category and payee from the product listing. After creating an order, " +
      "stop and give the user the approval link -- PayPal requires the buyer to approve at " +
      "checkout before payment can be captured, so do not call pay_order yourself.",
  },
  { role: "user", content: task },
];

console.log(bold(`\nUSER TASK: ${task}\n`));

for (let turn = 0; turn < 6; turn++) {
  const reply = await chat(messages, openaiTools);
  messages.push(reply);

  if (reply.content) console.log(dim(`agent: ${reply.content.trim()}\n`));
  if (!reply.tool_calls?.length) break;

  for (const call of reply.tool_calls) {
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    console.log(bold(`→ ${call.function.name}`), JSON.stringify(args));

    const result = await mcp.callTool({ name: call.function.name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");

    console.log(result.isError ? `\x1b[31m${text}\x1b[0m\n` : dim(`${text}\n`));
    messages.push({ role: "tool", tool_call_id: call.id, content: text });
  }
}

await mcp.close();
