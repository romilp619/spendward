/**
 * Minimal client for any OpenAI-compatible chat endpoint.
 *
 * Shared LLM gateways throttle bursts, and a demo that dies on the first
 * "retry shortly" is worse than one that waits. Only load and rate-limit
 * errors are retried; anything else surfaces at once.
 */
export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(
  messages: Message[],
  opts: { tools?: unknown[]; json?: boolean; onRetry?: (waitMs: number, attempt: number) => void } = {},
): Promise<Message> {
  const attempts = 6;
  for (let i = 1; ; i++) {
    const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.LLM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        messages,
        temperature: 0,
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))) as
      | { choices: Array<{ message: Message }> }
      | { error: { message: string } };

    if ("error" in body) {
      const transient = res.status === 429 || res.status >= 500 || /load|rate|retry|slow|busy/i.test(body.error.message);
      if (!transient || i >= attempts) throw new Error(`LLM error: ${body.error.message}`);
      const wait = Math.min(60_000, 5_000 * 2 ** (i - 1));
      opts.onRetry?.(wait, i + 1);
      await sleep(wait);
      continue;
    }
    const first = body.choices[0];
    if (!first) throw new Error("LLM returned no choices");
    return first.message;
  }
}
