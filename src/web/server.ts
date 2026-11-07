/**
 * Spendward dashboard and approval surface.
 * Run with: npm run web
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { entries, verifyChain, record, spentUnder, spend, orders } from "../lib/audit.js";
import { list as listApprovals, get as getApproval, decide, markCaptured } from "../lib/approvals.js";
import { createOrder, captureOrder, getAccessToken } from "../lib/paypal.js";
import type { SignedMandate } from "../lib/mandate.js";
import { recordEvent, recentEvents } from "../lib/events.js";
import { evaluate } from "../lib/policy.js";
import { revoke, revokedAt } from "../lib/revocations.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where PayPal sends the buyer back to. Baked into the order at creation time,
 * so it must outlive the request that created it -- a server on a different
 * port, or behind a tunnel, would otherwise strand the buyer on a dead URL.
 */
function publicOrigin(requestUrl: string): string {
  return process.env.PUBLIC_URL ?? new URL(requestUrl).origin;
}
const app = new Hono();

function mandate(): SignedMandate | null {
  const path = process.env.SPENDWARD_MANDATE;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignedMandate;
  } catch {
    return null;
  }
}

// Render and most platforms probe /healthz by default. Answer it so a healthy
// service is not marked down over a missing route.
app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/", (c) => c.html(readFileSync(join(here, "dashboard.html"), "utf8")));

app.get("/api/state", (c) => {
  const m = mandate()?.mandate ?? null;
  return c.json({
    mandate: m,
    // Computed by the same function the policy engine uses. The dashboard must
    // not do its own arithmetic, or the figure a user reads stops matching the
    // figure their limits are enforced against.
    revokedAt: m ? revokedAt(m.id) : null,
    spent: m ? spentUnder(m.id) : 0,
    spend: m ? spend(m.id) : { collected: 0, held: 0 },
    // Every order Spendward let through that nobody has paid for yet -- allowed
    // outright or approved by you. Both need the same thing: a buyer and a capture.
    toCollect: orders().filter((o) => !o.captured && o.held).map((o) => ({
      orderId: o.orderId, amount: o.amount, currency: o.currency, merchant: o.merchant, agent: o.agent, at: o.at,
      approved: listApprovals().some((a) => a.paypalOrderId === o.orderId),
    })),
    collectedCount: orders().filter((o) => o.captured).length,
    audit: entries(),
    approvals: listApprovals(),
    chain: verifyChain(),
    events: recentEvents(),
  });
});

app.post("/api/approvals/:id/approve", async (c) => {
  const pending = getApproval(c.req.param("id"));
  if (!pending) return c.json({ error: "not found" }, 404);
  if (pending.status !== "PENDING") return c.json({ error: "already decided" }, 409);

  // Run the rules again at the moment of approval. Time has passed since the
  // request was parked: the budget may have filled, the mandate may have
  // expired or been revoked. The principal can waive what they were asked
  // about, not whatever has changed since.
  const signed = mandate();
  if (!signed || signed.mandate.id !== pending.mandateId) {
    return c.json({ error: "this approval belongs to a mandate that is no longer loaded" }, 409);
  }
  const now = evaluate(signed, pending.request, { spent: spentUnder(signed.mandate.id), revokedAt: revokedAt(signed.mandate.id) });
  if (now.outcome === "BLOCK") {
    record({ agent: pending.agent, tool: "create_order", decision: now, request: pending.request, paypalOrderId: null });
    decide(pending.id, "REJECTED");
    return c.json({ error: `can no longer be approved: ${now.violations.filter((v) => !v.escalatable).map((v) => v.rule).join(", ")}` }, 409);
  }

  // The order is only created now. Until the principal approved, PayPal had
  // seen nothing at all.
  const order = await createOrder({
    amount: pending.request.amount,
    currency: pending.request.currency,
    description: `${pending.request.merchant} - ${pending.request.category}`,
    returnUrl: `${publicOrigin(c.req.url)}/paypal/return`,
    cancelUrl: `${publicOrigin(c.req.url)}/paypal/cancel`,
  });

  // The approval is itself a spend event. Without this the cumulative cap never
  // sees approved escalations, and approving repeatedly would bypass it
  // entirely -- each order is real money committed at PayPal.
  record({
    agent: pending.agent,
    tool: "create_order",
    decision: { outcome: "ALLOW", violations: pending.violations, mandateId: pending.mandateId },
    request: pending.request,
    paypalOrderId: order.id,
  });

  return c.json(decide(pending.id, "APPROVED", order) ?? { error: "race" });
});

/**
 * Collects payment for an order Spendward let through. One path for every way
 * an order gets here -- allowed outright, or approved after an escalation --
 * and for every trigger: the dashboard button, the return page, the webhook.
 * A second capture of the same order is refused before PayPal is contacted.
 */
async function collect(orderId: string): Promise<{ ok: true; status: string } | { ok: false; code: 404 | 409; error: string }> {
  const order = orders().find((o) => o.orderId === orderId);
  if (!order) return { ok: false, code: 404, error: "Spendward did not create this order" };
  if (order.captured) return { ok: false, code: 409, error: "already captured" };
  try {
    const result = await captureOrder(orderId);
    const src = order.source;
    record({
      agent: order.agent,
      tool: "pay_order",
      decision: { outcome: "ALLOW", violations: [], mandateId: order.mandateId },
      request: {
        tool: "pay_order", amount: order.amount, currency: src.currency ?? "USD", quantity: src.quantity ?? 0,
        merchant: src.merchant ?? "", category: src.category ?? "", recipient: src.recipient ?? "", isSubscription: false,
      },
      paypalOrderId: result.id,
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
  const signed = mandate();
  if (!signed) return c.json({ error: "no mandate loaded" }, 404);
  return c.json({ mandateId: signed.mandate.id, revokedAt: revoke(signed.mandate.id) });
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
  const url = process.env.PUBLIC_URL;
  if (!url || url.includes("localhost")) return;
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(8000) });
    console.log(
      res.ok
        ? `PUBLIC_URL ${url} is reachable`
        : `WARNING: PUBLIC_URL ${url} answered ${res.status}. Buyers will be redirected there after paying.`,
    );
  } catch {
    console.log(
      `WARNING: PUBLIC_URL ${url} is unreachable. Buyers will be stranded there after paying.\n` +
        `         Start a tunnel with 'npm run tunnel', or set PUBLIC_URL=http://localhost:${port}.`,
    );
  }
})();
