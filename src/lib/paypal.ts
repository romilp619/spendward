const API_BASE = () => process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

interface TokenCache {
  token: string;
  expiresAt: number;
}
let cached: TokenCache | null = null;

/**
 * PayPal access tokens last nine hours. We refresh a minute early rather than
 * on expiry so a long-running request cannot straddle the boundary.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set");

  const res = await fetch(`${API_BASE()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.token;
}

export interface OrderDraft {
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** PayPal merchant ID or business email. Set by Spendward, never by the agent. */
  payee: string;
  /**
   * A saved PayPal wallet. With one, PayPal charges it at once and no buyer
   * needs to visit checkout; without one, the buyer approves at PayPal.
   */
  vaultId?: string | null;
}

export interface Order {
  id: string;
  status: string;
  /** Where the buyer approves the payment. Null when the order was paid from a saved wallet. */
  approveUrl: string | null;
  /** The payee PayPal recorded on the order, read back from its response. */
  payee: string | null;
  /** True when PayPal completed the payment as part of creating the order. */
  captured: boolean;
}

interface PayPalOrderResponse {
  id: string;
  status: string;
  links?: Array<{ rel: string; href: string }>;
  purchase_units?: Array<{
    payee?: { merchant_id?: string; email_address?: string };
    payments?: { captures?: Array<{ id: string; status: string }> };
  }>;
}

async function call<T>(path: string, init: RequestInit, retried = false): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Makes a retried create idempotent at PayPal: the same request id never
      // produces a second order or a second charge.
      "PayPal-Request-Id": crypto.randomUUID(),
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  // A token can be revoked before it expires (or its app's permissions
  // change). Fetch a new one once rather than failing every call until restart.
  if (res.status === 401 && !retried) {
    cached = null;
    return call<T>(path, init, true);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${path} failed: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const payeeField = (account: string) => (account.includes("@") ? { email_address: account } : { merchant_id: account });

function readPayee(body: PayPalOrderResponse): string | null {
  const p = body.purchase_units?.[0]?.payee;
  return p?.merchant_id ?? p?.email_address ?? null;
}

export async function createOrder(draft: OrderDraft): Promise<Order> {
  const body = await call<PayPalOrderResponse>("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: draft.currency, value: draft.amount.toFixed(2) },
          description: draft.description.slice(0, 127),
          payee: payeeField(draft.payee),
        },
      ],
      payment_source: {
        paypal: draft.vaultId
          ? { vault_id: draft.vaultId }
          : {
              experience_context: {
                return_url: draft.returnUrl,
                cancel_url: draft.cancelUrl,
                user_action: "PAY_NOW",
                shipping_preference: "NO_SHIPPING",
                brand_name: "Spendward Demo",
              },
            },
      },
    }),
  });

  // Trust what PayPal recorded, not what was sent. If the payee on the order
  // is not the one Spendward asked for, nothing about this order is safe.
  const recorded = readPayee(body);
  if (recorded && recorded !== draft.payee && !draft.payee.includes("@")) {
    throw new Error(`PayPal recorded payee ${recorded}, expected ${draft.payee}`);
  }

  const approve = body.links?.find((l) => l.rel === "payer-action")?.href ?? null;
  const captured = body.status === "COMPLETED" ||
    (body.purchase_units?.[0]?.payments?.captures ?? []).some((c) => c.status === "COMPLETED");
  return { id: body.id, status: body.status, approveUrl: approve, payee: recorded ?? draft.payee, captured };
}

export async function captureOrder(orderId: string): Promise<{ id: string; status: string; payee: string | null }> {
  const body = await call<PayPalOrderResponse>(`/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    body: "{}",
  });
  return { id: body.id, status: body.status, payee: readPayee(body) };
}

export async function getOrder(orderId: string): Promise<{ id: string; status: string }> {
  const body = await call<PayPalOrderResponse>(`/v2/checkout/orders/${orderId}`, { method: "GET" });
  return { id: body.id, status: body.status };
}

// --- Vault: a saved PayPal wallet ---------------------------------------------
// The principal approves once, at PayPal, that this app may charge their
// wallet. After that, payments the mandate allows are charged without a
// checkout page. This is what lets "allowed" mean the agent actually paid,
// and it is also why the mandate matters: it is the only thing between the
// agent and a wallet that no longer asks.

export async function startWalletSetup(returnUrl: string, cancelUrl: string): Promise<{ id: string; approveUrl: string }> {
  const body = await call<{ id: string; links?: Array<{ rel: string; href: string }> }>("/v3/vault/setup-tokens", {
    method: "POST",
    body: JSON.stringify({
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          description: "Payments your AI agent makes within the mandates you sign in Spendward",
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            brand_name: "Spendward Demo",
            shipping_preference: "NO_SHIPPING",
            vault_instruction: "ON_PAYER_APPROVAL",
          },
        },
      },
    }),
  });
  const approveUrl = body.links?.find((l) => l.rel === "approve")?.href;
  if (!approveUrl) throw new Error("PayPal returned no approval link for the wallet setup");
  return { id: body.id, approveUrl };
}

export async function finishWalletSetup(setupTokenId: string): Promise<{ vaultId: string; email: string | null; customerId: string | null }> {
  const body = await call<{ id: string; customer?: { id?: string }; payment_source?: { paypal?: { email_address?: string } } }>(
    "/v3/vault/payment-tokens",
    { method: "POST", body: JSON.stringify({ payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }) },
  );
  return { vaultId: body.id, email: body.payment_source?.paypal?.email_address ?? null, customerId: body.customer?.id ?? null };
}

export async function deleteWallet(vaultId: string): Promise<void> {
  await call(`/v3/vault/payment-tokens/${encodeURIComponent(vaultId)}`, { method: "DELETE" });
}
