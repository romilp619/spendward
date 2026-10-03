/**
 * PayGuard dashboard and approval surface.
 * Run with: npm run web
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { entries, verifyChain, record } from "../lib/audit.js";
import { list as listApprovals, get as getApproval, decide } from "../lib/approvals.js";
import { createOrder, captureOrder, getAccessToken } from "../lib/paypal.js";
import type { SignedMandate } from "../lib/mandate.js";

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
  const path = process.env.PAYGUARD_MANDATE;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SignedMandate;
  } catch {
    return null;
  }
}

app.get("/", (c) => c.html(readFileSync(join(here, "dashboard.html"), "utf8")));

app.get("/api/state", (c) =>
  c.json({
    mandate: mandate()?.mandate ?? null,
    audit: entries(),
    approvals: listApprovals(),
    chain: verifyChain(),
  }),
);

app.post("/api/approvals/:id/approve", async (c) => {
  const pending = getApproval(c.req.param("id"));
  if (!pending) return c.json({ error: "not found" }, 404);
  if (pending.status !== "PENDING") return c.json({ error: "already decided" }, 409);

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
 * Captures an approved order. PayPal refuses this until the buyer has approved
 * at checkout, so the dashboard surfaces that error rather than hiding it.
 */
app.post("/api/approvals/:id/capture", async (c) => {
  const pending = getApproval(c.req.param("id"));
  if (!pending?.paypalOrderId) return c.json({ error: "no order to capture" }, 404);
  try {
    const result = await captureOrder(pending.paypalOrderId);
    record({
      agent: pending.agent,
      tool: "pay_order",
      decision: { outcome: "ALLOW", violations: [], mandateId: pending.mandateId },
      request: pending.request,
      paypalOrderId: result.id,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notApproved = message.includes("ORDER_NOT_APPROVED");
    return c.json(
      {
        error: notApproved
          ? "The buyer has not approved this order at PayPal yet. Open the checkout link first."
          : message,
      },
      409,
    );
  }
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

  const event = JSON.parse(raw) as { event_type?: string; resource?: { id?: string } };
  console.log(`[webhook] ${verified}  ${event.event_type ?? "?"}  ${event.resource?.id ?? ""}`);
  return c.body(null, 204);
});

app.get("/paypal/return", (c) => {
  const token = c.req.query("token") ?? "";
  const pending = listApprovals().find((a) => a.paypalOrderId === token);
  return c.html(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <title>Payment approved</title>
     <body style="font-family:system-ui;padding:2.5rem 1rem;max-width:34rem;margin:0 auto;
                  background:#0d1117;color:#e7edf3">
       <h2 style="margin:0 0 .5rem">Payment approved at PayPal</h2>
       <p style="color:#9aa7b4">Order <code>${token}</code> is ready to capture.</p>
       ${
         pending
           ? `<button id="cap" style="font:inherit;font-weight:600;padding:.6rem 1.1rem;border:0;
                     border-radius:7px;background:#4d8bff;color:#fff;cursor:pointer">Capture payment</button>
              <p id="out" role="status" style="color:#9aa7b4"></p>
              <script>
                document.getElementById("cap").onclick = async (e) => {
                  e.target.disabled = true;
                  const r = await fetch("/api/approvals/${pending.id}/capture", { method: "POST" });
                  const b = await r.json();
                  document.getElementById("out").textContent =
                    r.ok ? "Captured \u2014 " + b.status : b.error;
                  e.target.disabled = !r.ok;
                };
              <\/script>`
           : ""
       }
       <p><a href="/" style="color:#4d8bff">Back to PayGuard</a></p>
     </body>`,
  );
});

app.get("/paypal/cancel", (c) =>
  c.html(
    `<body style="font-family:system-ui;padding:3rem;max-width:34rem">
       <h2>Payment cancelled</h2><p><a href="/">Back to PayGuard</a></p>
     </body>`,
  ),
);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`PayGuard dashboard on http://localhost:${port}`);
