/**
 * Spendward dashboard and approval surface.
 * Run with: npm run web
 */
import { readFileSync, rmSync } from "node:fs";
import { dataPath } from "../lib/data.js";
import { spawn } from "node:child_process";
import { streamSSE } from "hono/streaming";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";

import { z } from "zod";
import { entries, verifyChain, record, spend, orders } from "../lib/audit.js";
import { list as listApprovals, get as getApproval, decide, markCaptured } from "../lib/approvals.js";
import { captureOrder, getAccessToken, startWalletSetup, finishWalletSetup, deleteWallet } from "../lib/paypal.js";
import { principalKey, signMandate, type Mandate } from "../lib/mandate.js";
import { recordEvent, recentEvents } from "../lib/events.js";
import { evaluate } from "../lib/policy.js";
import { revoke, revokedAt } from "../lib/revocations.js";
import { active, activate, all as allMandates, byId, ledgerFor, save } from "../lib/mandates.js";
import { directory, resolvePayee } from "../lib/merchants.js";
import { placeOrder, recordPayment } from "../lib/checkout.js";
import { withLockAsync } from "../lib/lock.js";
import { wallet, saveWallet, forgetWallet } from "../lib/wallet.js";
import { draftMandate, DraftSchema } from "../lib/drafter.js";
import { FIXED, LIVE } from "../demo/tasks.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where PayPal sends the buyer back to. Baked into the order at creation time,
 * so it must outlive the request that created it -- a server on a different
 * port, or behind a tunnel, would otherwise strand the buyer on a dead URL.
 */
function publicOrigin(requestUrl: string): string {
  return process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? new URL(requestUrl).origin;
}
const app = new Hono();


// Render and most platforms probe /healthz by default. Answer it so a healthy
// service is not marked down over a missing route.
app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/", (c) => c.html(readFileSync(join(here, "dashboard.html"), "utf8")));

app.get("/api/state", (c) => {
  const m = active()?.mandate ?? null;
  const w = wallet();
  return c.json({
    mandate: m,
    // Computed by the same function the policy engine uses. The dashboard must
    // not do its own arithmetic, or the figure a user reads stops matching the
    // figure their limits are enforced against.
    revokedAt: m ? revokedAt(m.id) : null,
    spent: m ? ledgerFor(active()!, null).spent : 0,
    spend: m ? spend(m.id, Date.now(), m.budgetPeriod) : { collected: 0, held: 0 },
    // Every order Spendward let through that nobody has paid for yet -- allowed
    // outright or approved by you. Both need the same thing: a buyer and a capture.
    toCollect: orders().filter((o) => !o.captured && o.held).map((o) => ({
      orderId: o.orderId, amount: o.amount, currency: o.currency, merchant: o.merchant, agent: o.agent, at: o.at,
      approved: listApprovals().some((a) => a.paypalOrderId === o.orderId),
      payee: o.source.payeeAccount,
    })),
    collectedCount: orders().filter((o) => o.captured).length,
    audit: entries(),
    // Each waiting approval carries where its money would go, resolved now, so
    // the principal approves a destination and not just a shop name.
    approvals: listApprovals().map((a) => {
      const owner = byId(a.mandateId);
      const payee = owner ? resolvePayee(owner.mandate, a.request.merchant) : null;
      return { ...a, payee };
    }),
    chain: verifyChain(),
    events: recentEvents(),
    wallet: w ? { email: w.email, connectedAt: w.connectedAt, vaultId: `${w.vaultId.slice(0, 4)}…` } : null,
    mandates: allMandates().sort((x, y) => Number(y.mandate.id === m?.id) - Number(x.mandate.id === m?.id)).map((s) => ({
      id: s.mandate.id, issuedAt: s.mandate.issuedAt, expiresAt: s.mandate.expiresAt,
      maxTransactionAmount: s.mandate.maxTransactionAmount, maxTotalAmount: s.mandate.maxTotalAmount,
      budgetPeriod: s.mandate.budgetPeriod, allowedMerchants: s.mandate.allowedMerchants,
      currency: s.mandate.currency, active: s.mandate.id === m?.id, revokedAt: revokedAt(s.mandate.id),
    })),
    merchants: Object.fromEntries(Object.entries(directory()).map(([k, v]) => [k, v.name])),
  });
});

// One decision at a time, re-read inside the lock: two quick clicks must not
// both see "pending" and place two orders.
app.post("/api/approvals/:id/approve", (c) => withLockAsync("approve", () => approve(c)));

async function approve(c: Context) {
  const pending = getApproval(c.req.param("id") ?? "");
  if (!pending) return c.json({ error: "not found" }, 404);
  if (pending.status !== "PENDING") return c.json({ error: "already decided" }, 409);

  // Judged against the mandate it was requested under, whichever is active now.
  const signed = byId(pending.mandateId);
  if (!signed) return c.json({ error: `mandate ${pending.mandateId} no longer exists` }, 409);

  // Run the rules again at the moment of approval. Time has passed since the
  // request was parked: the budget may have filled, the mandate may have
  // expired or been revoked. The principal can waive what they were asked
  // about, not whatever has changed since.
  const now = evaluate(signed, pending.request, ledgerFor(signed, pending.request));
  if (now.outcome === "BLOCK") {
    record({ agent: pending.agent, tool: "create_order", decision: now, request: pending.request, paypalOrderId: null });
    decide(pending.id, "REJECTED");
    return c.json({ error: `can no longer be approved: ${now.violations.filter((v) => !v.escalatable).map((v) => v.rule).join(", ")}` }, 409);
  }

  // The order is only created now. Until the principal approved, PayPal had
  // seen nothing at all.
  let order;
  try {
    order = await placeOrder(signed.mandate, pending.request, {
      returnUrl: `${publicOrigin(c.req.url)}/paypal/return`,
      cancelUrl: `${publicOrigin(c.req.url)}/paypal/cancel`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record({ agent: pending.agent, tool: "create_order", decision: { outcome: "ALLOW", violations: pending.violations, mandateId: pending.mandateId }, request: pending.request, paypalOrderId: null, error: message.slice(0, 300) });
    return c.json({ error: `PayPal refused the order: ${message.slice(0, 200)}` }, 502);
  }

  // The approval is itself a spend event. Without this the cumulative cap never
  // sees approved escalations, and approving repeatedly would bypass it
  // entirely -- each order is real money committed at PayPal.
  record({
    agent: pending.agent,
    tool: "create_order",
    decision: { outcome: "ALLOW", violations: pending.violations, mandateId: pending.mandateId },
    request: pending.request,
    paypalOrderId: order.id,
    payeeAccount: order.payee,
  });
  const decided = decide(pending.id, "APPROVED", order);
  if (order.captured) {
    recordPayment({ agent: pending.agent, mandateId: pending.mandateId, request: pending.request, orderId: order.id, payee: order.payee });
    markCaptured(pending.id);
  }
  return c.json({ ...decided, paid: order.captured, payeeName: order.payeeName });
}

/**
 * Collects payment for an order Spendward let through. One path for every way
 * an order gets here -- allowed outright, or approved after an escalation --
 * and for every trigger: the dashboard button, the return page, the webhook.
 * A second capture of the same order is refused before PayPal is contacted.
 */
async function collect(orderId: string): Promise<{ ok: true; status: string } | { ok: false; code: 404 | 409; error: string }> {
  // One capture at a time: a click and a webhook landing together must not
  // both pass the "already captured?" check before either records.
  return withLockAsync("capture", () => collectLocked(orderId));
}

async function collectLocked(orderId: string): Promise<{ ok: true; status: string } | { ok: false; code: 404 | 409; error: string }> {
  const order = orders().find((o) => o.orderId === orderId);
  if (!order) return { ok: false, code: 404, error: "Spendward did not create this order" };
  if (order.captured) return { ok: false, code: 409, error: "already captured" };
  // Money moves only when Spendward captures, so refusing here is final.
  // A revoked mandate pays for nothing more, including orders made before it
  // was revoked; and an order whose budget hold has lapsed no longer has the
  // budget it would spend, so it cannot be paid late either.
  if (order.mandateId && revokedAt(order.mandateId)) {
    return { ok: false, code: 409, error: "This order's mandate was revoked, so Spendward will not collect it." };
  }
  if (!order.held) {
    return { ok: false, code: 409, error: "This order's budget hold expired, so Spendward will not collect it. Ask the agent to order again." };
  }
  try {
    const result = await captureOrder(orderId);
    const src = order.source;
    recordPayment({
      agent: order.agent,
      mandateId: order.mandateId,
      request: {
        tool: "pay_order", amount: order.amount, currency: src.currency ?? "USD", quantity: src.quantity ?? 0,
        merchant: src.merchant ?? "", category: src.category ?? "", recipient: src.recipient ?? "", isSubscription: false,
      },
      orderId: result.id,
      payee: result.payee ?? src.payeeAccount,
    });
    const approval = listApprovals().find((a) => a.paypalOrderId === orderId);
    if (approval) markCaptured(approval.id);
    return { ok: true, status: result.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false, code: 409,
      error: message.includes("ORDER_NOT_APPROVED")
        ? "The buyer has not approved this order at PayPal yet. Open the checkout link first."
        : message,
    };
  }
}

app.post("/api/orders/:id/capture", async (c) => {
  const r = await collect(c.req.param("id"));
  return r.ok ? c.json({ status: r.status }) : c.json({ error: r.error }, r.code);
});

// Kept for anything still calling the approval-shaped route.
app.post("/api/approvals/:id/capture", async (c) => {
  const pending = getApproval(c.req.param("id"));
  if (!pending?.paypalOrderId) return c.json({ error: "no order to capture" }, 404);
  const r = await collect(pending.paypalOrderId);
  return r.ok ? c.json({ status: r.status }) : c.json({ error: r.error }, r.code);
});

/**
 * Revokes the loaded mandate. Final: every later request is refused, parked
 * approvals can no longer be granted, and spending again needs a new mandate.
 * Orders already at PayPal are not touched -- revoking stops new spending, it
 * does not undo old spending.
 */
app.post("/api/mandate/revoke", (c) => {
  const signed = active();
  if (!signed) return c.json({ error: "no active mandate" }, 404);
  return c.json({ mandateId: signed.mandate.id, revokedAt: revoke(signed.mandate.id) });
});

// --- Mandates ------------------------------------------------------------------
// The dashboard is the principal's console: it is where mandates are drafted,
// read, signed and switched. It holds the signing key; the MCP server the
// agent talks to does not.

app.post("/api/mandates/draft", async (c) => {
  const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
  if (!text?.trim()) return c.json({ error: "Describe what the agent may buy." }, 400);
  try {
    return c.json(await draftMandate(text));
  } catch (err) {
    return c.json({ error: `Could not draft a mandate: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` }, 502);
  }
});

app.post("/api/mandates", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = DraftSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  const d = parsed.data;
  if (d.approvalCeiling < d.maxTransactionAmount) return c.json({ error: "The approval ceiling cannot be below the per-payment limit." }, 400);
  const dir = directory();
  const unknown = d.allowedMerchants.filter((m) => !dir[m]);
  if (unknown.length) return c.json({ error: `No PayPal account on record for ${unknown.join(", ")}. Add it to merchants.json first.` }, 400);

  const mandate: Mandate = {
    id: `mnd_${Date.now().toString(36)}`,
    principal: process.env.SPENDWARD_PRINCIPAL ?? "you",
    // Which agent this governs is the principal's choice, not the drafter's.
    agent: typeof body?.agent === "string" && /^[\w.-]{1,40}$/.test(body.agent) ? body.agent : "shopper-01",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + d.expiresInDays * 864e5).toISOString(),
    currency: "USD",
    maxTransactionAmount: d.maxTransactionAmount,
    maxTotalAmount: d.maxTotalAmount,
    budgetPeriod: d.budgetPeriod,
    approvalCeiling: d.approvalCeiling,
    maxQuantity: d.maxQuantity,
    allowedMerchants: d.allowedMerchants,
    // The signature covers where each merchant's money goes, not just its name.
    payees: Object.fromEntries(d.allowedMerchants.map((m) => [m, dir[m]!.payee])),
    allowedCategories: d.allowedCategories,
    allowSubscriptions: d.allowSubscriptions,
    allowedTools: ["search_products", "create_order", "get_order", "pay_order"],
  };
  save(signMandate(mandate, principalKey()));
  activate(mandate.id);
  return c.json({ id: mandate.id });
});

app.post("/api/mandates/:id/activate", (c) => {
  const id = c.req.param("id");
  if (!byId(id)) return c.json({ error: "not found" }, 404);
  if (revokedAt(id)) return c.json({ error: "That mandate is revoked; sign a new one instead." }, 409);
  activate(id);
  return c.json({ id });
});

// --- Try it ---------------------------------------------------------------------
// Lets anyone evaluating Spendward run the real agent from the browser and
// watch it, instead of reading about it. The agent is the same unhardened
// process `npm run agent` starts, talking to the same MCP server.

/** Live catalogue when the active mandate names a real retailer and Channel3 is configured. */
function catalogFor(): "live" | "fixed" {
  const m = active()?.mandate;
  return process.env.CHANNEL3_API_KEY && m?.allowedMerchants.some((x) => x.includes(".")) ? "live" : "fixed";
}

app.get("/api/scenarios", (c) => {
  const catalog = catalogFor();
  return c.json({
    catalog,
    scenarios: catalog === "live" ? LIVE : FIXED,
    presets: { fixed: Boolean(byId("mnd_demo_001")), live: Boolean(byId("mnd_live_001")) && Boolean(process.env.CHANNEL3_API_KEY) },
    busy: running,
  });
});

let running = false;

app.get("/api/agent/run", (c) => {
  const task = (c.req.query("task") ?? "").trim().slice(0, 500);
  const unattended = c.req.query("unattended") !== "0";
  return streamSSE(c, async (stream) => {
    const send = (e: Record<string, unknown>) => stream.writeSSE({ data: JSON.stringify(e) });
    if (!task) { await send({ type: "error", text: "Give the agent something to do." }); return; }
    if (!active()) { await send({ type: "error", text: "No active mandate. Sign one in the Mandates tab first." }); return; }
    if (running) { await send({ type: "error", text: "The agent is already running a task. Wait for it to finish." }); return; }
    running = true;
    const catalog = catalogFor();
    await send({ type: "start", catalog, unattended });
    // The agent never receives the principal's signing key.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "MANDATE_PRIVATE_KEY") env[k] = v;
    Object.assign(env, {
      SPENDWARD_EVENTS_JSON: "1",
      SPENDWARD_PLANTED: "1",
      SPENDWARD_UNATTENDED: unattended ? "1" : "0",
      SPENDWARD_CATALOG: catalog === "live" ? "channel3" : "",
    });
    // No shell: the task is passed as one argument, never interpreted.
    const child = spawn(process.execPath, ["--import", "tsx", "src/agent/shopper.ts", task], { env, cwd: process.cwd() });
    // Generous: one slow PayPal settlement can take minutes in the sandbox.
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    let buf = "";
    let failed = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("{")) void stream.writeSSE({ data: line });
      }
    });
    child.stderr.on("data", (d: Buffer) => { failed += d.toString(); });
    stream.onAbort(() => { child.kill("SIGKILL"); });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    clearTimeout(timer);
    running = false;
    const err = failed.match(/Error: ([^\n]+)/)?.[1];
    await send(err ? { type: "error", text: err.slice(0, 300) } : { type: "end" });
  });
});

/** Clears the demo record. Signed mandates and the saved wallet are kept. */
app.post("/api/demo/reset", (c) => {
  if (running) return c.json({ error: "Wait for the agent to finish first." }, 409);
  for (const f of [
    process.env.SPENDWARD_AUDIT_LOG ?? dataPath("audit.jsonl"),
    process.env.SPENDWARD_APPROVALS ?? dataPath("approvals.json"),
    process.env.SPENDWARD_EVENTS ?? dataPath("paypal-events.jsonl"),
    process.env.SPENDWARD_REVOCATIONS ?? dataPath("revoked.json"),
    process.env.SPENDWARD_LISTINGS ?? dataPath("listings.json"),
  ]) rmSync(f, { force: true });
  return c.json({ ok: true });
});

// --- Saved wallet (PayPal Vault) -------------------------------------------------

app.post("/api/wallet/connect", async (c) => {
  try {
    const origin = publicOrigin(c.req.url);
    const setup = await startWalletSetup(`${origin}/paypal/wallet-return`, `${origin}/paypal/cancel`);
    return c.json({ approveUrl: setup.approveUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({
      error: message.includes("NOT_AUTHORIZED")
        ? "Your PayPal app is not allowed to save payment methods yet. In the developer dashboard, open the app and tick \"Save payment methods\". " +
          "If it is already ticked, create a new sandbox app with it ticked: changes to an existing app can take hours to apply."
        : message.slice(0, 240),
    }, 502);
  }
});

app.get("/paypal/wallet-return", async (c) => {
  const token = c.req.query("approval_token_id") ?? c.req.query("token") ?? "";
  let message: string;
  try {
    const result = await finishWalletSetup(token);
    saveWallet({ ...result, connectedAt: new Date().toISOString() });
    message = `Wallet connected${result.email ? ` (${result.email})` : ""}. Payments your mandate allows will now be charged to it without a checkout page.`;
  } catch (err) {
    message = `Could not save the wallet: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  }
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Wallet</title><body style="font-family:system-ui;padding:2.5rem 1rem;max-width:34rem;margin:0 auto;background:#0d1117;color:#e7edf3">
    <h2 style="margin:0 0 .5rem">PayPal wallet</h2><p style="color:#9aa7b4">${message.replace(/</g, "&lt;")}</p>
    <p><a href="/" style="color:#4d8bff">Back to Spendward</a></p></body>`);
});

app.post("/api/wallet/disconnect", async (c) => {
  const w = wallet();
  if (!w) return c.json({ ok: true });
  try { await deleteWallet(w.vaultId); } catch { /* already gone at PayPal */ }
  forgetWallet();
  return c.json({ ok: true });
});

app.post("/api/approvals/:id/reject", (c) => {
  const updated = decide(c.req.param("id"), "REJECTED");
  return updated ? c.json(updated) : c.json({ error: "not found or already decided" }, 404);
});

/**
 * PayPal webhook receiver.
 *
 * When PAYPAL_WEBHOOK_ID is set the event is verified against PayPal before it
 * is trusted. Without it the event is accepted but flagged, because an
 * unverified webhook is an unauthenticated POST from anyone.
 */
/**
 * PayPal's dashboard form silently drops the path from a webhook URL, so a
 * webhook saved there arrives at the site root instead of the endpoint. Rather
 * than rely on the registration staying correct, accept deliveries at both.
 */
app.post("/", (c) => app.fetch(
  new Request(new URL("/paypal/webhook", c.req.url), {
    method: "POST",
    headers: c.req.raw.headers,
    body: c.req.raw.body,
    // @ts-expect-error -- node fetch requires this for a streamed body
    duplex: "half",
  }),
));

app.post("/paypal/webhook", async (c) => {
  const raw = await c.req.text();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  let verified: string;

  if (!webhookId) {
    verified = "UNVERIFIED (PAYPAL_WEBHOOK_ID not set)";
  } else {
    const res = await fetch(
      `${process.env.PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: c.req.header("paypal-auth-algo"),
          cert_url: c.req.header("paypal-cert-url"),
          transmission_id: c.req.header("paypal-transmission-id"),
          transmission_sig: c.req.header("paypal-transmission-sig"),
          transmission_time: c.req.header("paypal-transmission-time"),
          webhook_id: webhookId,
          webhook_event: JSON.parse(raw),
        }),
      },
    );
    const body = (await res.json()) as { verification_status?: string };
    verified = body.verification_status ?? "UNKNOWN";
  }

  const event = JSON.parse(raw) as {
    event_type?: string;
    summary?: string;
    resource?: { id?: string };
  };

  recordEvent({
    at: new Date().toISOString(),
    type: event.event_type ?? "UNKNOWN",
    resourceId: event.resource?.id ?? null,
    verification: verified,
    summary: event.summary ?? null,
  });

  console.log(`[webhook] ${verified}  ${event.event_type ?? "?"}  ${event.resource?.id ?? ""}`);

  // Settle approved orders without a second human action. The principal has
  // already decided, and the buyer has already paid at PayPal -- capture is
  // settlement, not another authorization.
  //
  // Only on a verified event. Acting on an unverified one would let anyone who
  // can reach this endpoint trigger captures by POSTing a plausible body.
  if (verified === "SUCCESS" && event.event_type === "CHECKOUT.ORDER.APPROVED") {
    await autoCapture(event.resource?.id ?? null);
  }

  return c.body(null, 204);
});

/**
 * Captures an order PayPal has told us the buyer approved. PayPal retries
 * webhooks, so this must be safe to run more than once -- the CAPTURED state
 * is what makes a repeat delivery a no-op.
 */
async function autoCapture(orderId: string | null): Promise<void> {
  if (!orderId) return;
  const r = await collect(orderId);
  if (r.ok) console.log(`[webhook] auto-captured ${orderId} (${r.status})`);
  else if (r.code !== 404) console.log(`[webhook] auto-capture of ${orderId} skipped: ${r.error}`);
}

app.get("/paypal/return", (c) => {
  const token = c.req.query("token") ?? "";
  const order = orders().find((o) => o.orderId === token);
  return c.html(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <title>Payment approved</title>
     <body style="font-family:system-ui;padding:2.5rem 1rem;max-width:34rem;margin:0 auto;
                  background:#0d1117;color:#e7edf3">
       <h2 style="margin:0 0 .5rem">Payment approved at PayPal</h2>
       <p style="color:#9aa7b4">Order <code>${token}</code> is ready to capture.</p>
       ${
         order?.captured
           ? `<p style="color:#3fb97a;font-weight:600">Captured automatically.</p>`
           : order
           ? `<button id="cap" style="font:inherit;font-weight:600;padding:.6rem 1.1rem;border:0;
                     border-radius:7px;background:#4d8bff;color:#fff;cursor:pointer">Capture payment</button>
              <p id="out" role="status" style="color:#9aa7b4"></p>
              <script>
                document.getElementById("cap").onclick = async (e) => {
                  e.target.disabled = true;
                  const r = await fetch("/api/orders/${order.orderId}/capture", { method: "POST" });
                  const b = await r.json();
                  document.getElementById("out").textContent =
                    r.ok ? "Captured: " + b.status : b.error;
                  e.target.disabled = !r.ok;
                };
              <\/script>`
           : ""
       }
       <p><a href="/" style="color:#4d8bff">Back to Spendward</a></p>
     </body>`,
  );
});

app.get("/paypal/cancel", (c) =>
  c.html(
    `<body style="font-family:system-ui;padding:3rem;max-width:34rem">
       <h2>Payment cancelled</h2><p><a href="/">Back to Spendward</a></p>
     </body>`,
  ),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Spendward dashboard on http://localhost:${port}`);

/**
 * PUBLIC_URL is baked into every order as the address PayPal returns the buyer
 * to, so a stale one strands them on a dead host after they have already paid.
 * A tunnel hostname changes on every restart, which makes that easy to miss --
 * so say it at startup rather than at checkout.
 */
void (async () => {
  const url = process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (!url || url.includes("localhost")) return;
  // A new tunnel hostname takes a few seconds to go live, so try for about
  // half a minute before calling it unreachable.
  let last = "unreachable";
  for (let i = 0; i < 7; i++) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) { console.log(`PUBLIC_URL ${url} is reachable`); return; }
      last = `answered ${res.status}`;
    } catch {
      last = "unreachable";
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(
    `WARNING: PUBLIC_URL ${url} is ${last}. Buyers will be redirected there after paying.\n` +
      `         Start a tunnel with 'npm run tunnel', or set PUBLIC_URL=http://localhost:${port}.`,
  );
})();
