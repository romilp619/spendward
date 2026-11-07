/**
 * Spendward MCP server.
 *
 * Mirrors the tool names and parameter shapes of PayPal's own MCP server, so
 * any MCP client can point at Spendward instead of PayPal and nothing about the
 * agent has to change. Every call is evaluated against the signed mandate
 * before PayPal is contacted.
 *
 * PayPal's agent toolkit exposes 46 tools, including create_refund,
 * cancel_subscription and accept_dispute_claim. An agent granted that server
 * can invoke all of them. Spendward narrows that surface to what its principal
 * actually authorized.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { SignedMandate } from "../lib/mandate.js";
import type { PaymentRequest } from "../lib/policy.js";
import { evaluate } from "../lib/policy.js";
import { captureOrder, getOrder, type Order } from "../lib/paypal.js";
import { record } from "../lib/audit.js";
import { park } from "../lib/approvals.js";
import { active, ledgerFor } from "../lib/mandates.js";
import { placeOrder, recordPayment } from "../lib/checkout.js";
import { search } from "../demo/catalog.js";
import { planted } from "../demo/planted.js";
import * as channel3 from "../lib/channel3.js";

// This process is the enforcement point. It verifies mandates; it must never
// be able to issue one, so the principal's private key is dropped on arrival
// even if a careless launcher passed it along.
delete process.env.MANDATE_PRIVATE_KEY;

/** The mandate in force right now. Read per call, so switching it in the dashboard takes effect at once. */
function current(): SignedMandate {
  const m = active();
  if (!m) throw new Error("No active mandate. Sign one in the dashboard or run `npm run mint`.");
  return m;
}

const origin = () => process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

/** What the agent is told when Spendward refuses. Structured so the model can
 *  explain the refusal to its user rather than silently retrying. */
function refusal(decision: ReturnType<typeof evaluate>, pendingId?: string) {
  const lines = decision.violations.map(
    (v) => `- ${v.rule} (${v.severity}): policy is ${v.policy}, you requested ${v.requested}. ${v.evidence}`,
  );
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Spendward ${decision.outcome === "BLOCK" ? "refused" : "escalated"} this request.\n\n` +
          `${lines.join("\n")}\n\n` +
          (decision.outcome === "REQUIRE_APPROVAL"
            ? `The principal has been asked to approve it (request ${pendingId}). ` +
              "Tell the user it is awaiting their approval. Do not retry."
            : "This exceeds the authority you were granted. Do not retry with altered parameters."),
      },
    ],
  };
}

/** Runs a tool against the mandate, logs the decision, and only then acts. */
async function guarded<T>(
  tool: string,
  request: PaymentRequest | null,
  act: (mandate: SignedMandate) => Promise<T>,
  describe: (result: T) => string,
) {
  const mandate = current();
  const agent = mandate.mandate.agent;
  // Tools that move no money still need their grant checked, so they are
  // evaluated against a zero-value probe. The probe is never recorded -- the
  // audit trail would otherwise show a USD 0.00 payment that never existed.
  const probe: PaymentRequest = request ?? {
    tool,
    amount: 0,
    currency: mandate.mandate.currency,
    quantity: 0,
    merchant: mandate.mandate.allowedMerchants[0] ?? "",
    category: mandate.mandate.allowedCategories[0] ?? "",
    recipient: mandate.mandate.allowedMerchants[0] ?? "",
    isSubscription: false,
  };

  const decision = evaluate(mandate, probe, ledgerFor(mandate, request?.tool === "create_order" ? request.merchant : null));

  if (decision.outcome !== "ALLOW") {
    record({ agent, tool, decision, request, paypalOrderId: null });
    // An escalation is parked for the principal. PayPal is not contacted either
    // way until they decide.
    const pending =
      decision.outcome === "REQUIRE_APPROVAL" && request
        ? park({ agent, decision, request })
        : undefined;
    return refusal(decision, pending?.id);
  }

  let result: T;
  try {
    result = await act(mandate);
  } catch (err) {
    // Authorized, attempted, refused downstream. Leaving this out would make
    // the audit trail claim fewer calls were made than actually were.
    const message = err instanceof Error ? err.message : String(err);
    record({ agent, tool, decision, request, paypalOrderId: null, error: message.slice(0, 300) });
    throw err;
  }
  const orderId =
    typeof result === "object" && result !== null && "id" in result
      ? String((result as { id: unknown }).id)
      : null;
  const order = tool === "create_order" ? (result as unknown as Order) : null;
  record({ agent, tool, decision, request, paypalOrderId: orderId, payeeAccount: order?.payee ?? null });
  // Paid from the saved wallet as the order was created: money has moved.
  if (order?.captured && request) {
    recordPayment({ agent, mandateId: mandate.mandate.id, request, orderId: order.id, payee: order.payee });
  }

  return { content: [{ type: "text" as const, text: describe(result) }] };
}

const server = new McpServer({ name: "spendward", version: "0.1.0" });

// --- Product search ----------------------------------------------------------
// Untrusted content enters the agent here. Spendward returns listing text
// verbatim rather than sanitizing it: the whole point is that the enforcement
// point does not depend on recognizing a malicious description.
server.registerTool(
  "search_products",
  {
    title: "Search Products",
    description: "Search the product catalog.",
    inputSchema: { query: z.string().describe("What to search for.") },
  },
  async (args) => {
    // Live catalogue when a key is present, fixed one otherwise, so the
    // benchmark stays reproducible without a network call.
    const found = channel3.isEnabled()
      ? await channel3.search(args.query).catch(() => search(args.query))
      : search(args.query);
    // Demo only: a planted listing, standing in for a compromised seller page.
    const results = [...planted(args.query), ...found];
    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length === 0
              ? "No products found."
              : results
                  .map(
                    (p) =>
                      `id: ${p.id}\nname: ${p.name}\nmerchant: ${p.merchant}\n` +
                      `category: ${p.category}\nprice: USD ${p.unitAmount}\n` +
                      `description: ${p.description}`,
                  )
                  .join("\n\n---\n\n"),
        },
      ],
    };
  },
);

// --- Orders -----------------------------------------------------------------
// Mirrors PayPal's create_order. merchant/category/payee are Spendward
// additions: PayPal's schema carries no field identifying who is being paid,
// so there is nothing for a mandate to check against without them.
server.registerTool(
  "create_order",
  {
    title: "Create Order",
    description: "Create a PayPal order. Subject to the spending mandate granted by the user.",
    inputSchema: {
      currencyCode: z.enum(["USD"]).describe("Currency code of the amount."),
      items: z
        .array(
          z.object({
            name: z.string().describe("The name of the item."),
            quantity: z.number().describe("The item quantity. Must be a whole number."),
            unitAmount: z.number().describe("The price per unit."),
            description: z.string().optional(),
          }),
        )
        .max(50),
      merchant: z
        .string()
        .describe("The merchant selling the item, copied exactly from the listing's merchant field (for example bestbuy.com)."),
      category: z.string().describe("The product category, copied from the listing."),
      payee: z
        .string()
        .describe("Who receives the money. For an ordinary purchase this is the same value as merchant, copied exactly."),
      shippingCost: z.number().default(0).optional(),
      discount: z.number().default(0).optional(),
      isSubscription: z
        .boolean()
        .default(false)
        .optional()
        .describe("True if this order enrolls the buyer in a recurring charge."),
      notes: z.string().optional(),
      // Accepted for compatibility with PayPal's schema and ignored: where the
      // buyer is sent after checkout is not the agent's decision.
      returnUrl: z.string().optional(),
      cancelUrl: z.string().optional(),
      sourceContext: z
        .string()
        .optional()
        .describe("Where this instruction came from, e.g. a product page. Recorded for audit."),
    },
  },
  async (args) => {
    const subtotal = args.items.reduce((sum, i) => sum + i.unitAmount * i.quantity, 0);
    const amount = subtotal + (args.shippingCost ?? 0) - (args.discount ?? 0);
    const quantity = args.items.reduce((sum, i) => sum + i.quantity, 0);

    const request: PaymentRequest = {
      tool: "create_order",
      amount,
      currency: args.currencyCode,
      quantity,
      merchant: args.merchant,
      category: args.category,
      recipient: args.payee,
      isSubscription: args.isSubscription ?? false,
      ...(args.sourceContext !== undefined ? { sourceContext: args.sourceContext } : {}),
    };

    return guarded(
      "create_order",
      request,
      (m) => placeOrder(m.mandate, request, { returnUrl: `${origin()}/paypal/return`, cancelUrl: `${origin()}/paypal/cancel` }),
      (o) =>
        o.captured
          ? `Order ${o.id} paid (${o.status}) from the user's saved PayPal wallet, to ${o.payeeName}. Nothing more to do.`
          : `Order ${o.id} created (${o.status}), payable to ${o.payeeName}.\nThe user approves it at: ${o.approveUrl ?? "n/a"}`,
    );
  },
);

server.registerTool(
  "pay_order",
  {
    title: "Pay Order",
    description: "Capture payment for an approved PayPal order.",
    inputSchema: { id: z.string().describe("The order id generated during create call") },
  },
  async (args) =>
    guarded("pay_order", null, () => captureOrder(args.id), (r) => `Order ${r.id} captured (${r.status}).`),
);

server.registerTool(
  "get_order",
  {
    title: "Get Order",
    description: "Retrieve the status of a PayPal order.",
    inputSchema: { id: z.string().describe("The order id generated during create call") },
  },
  async (args) =>
    guarded("get_order", null, () => getOrder(args.id), (r) => `Order ${r.id} is ${r.status}.`),
);

// --- Tools present so they can be refused ------------------------------------
// These exist on PayPal's MCP server. Spendward exposes them so an agent that
// reaches for one gets a mandate refusal rather than a missing-tool error,
// which is both more honest and more useful to the model.
server.registerTool(
  "create_refund",
  {
    title: "Create Refund",
    description: "Refund a captured payment.",
    inputSchema: { captureId: z.string(), amount: z.number().optional() },
  },
  async () => guarded("create_refund", null, async () => ({ id: null }), () => "refunded"),
);

server.registerTool(
  "cancel_subscription",
  {
    title: "Cancel Subscription",
    description: "Cancel an active subscription.",
    inputSchema: { subscriptionId: z.string(), reason: z.string().optional() },
  },
  async () => guarded("cancel_subscription", null, async () => ({ id: null }), () => "cancelled"),
);

await server.connect(new StdioServerTransport());
