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
}

export interface Order {
  id: string;
  status: string;
  approveUrl: string | null;
}

interface PayPalOrderResponse {
  id: string;
  status: string;
  links?: Array<{ rel: string; href: string }>;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal ${path} failed: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

export async function createOrder(draft: OrderDraft): Promise<Order> {
  const body = await call<PayPalOrderResponse>("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: draft.currency, value: draft.amount.toFixed(2) },
          description: draft.description,
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: draft.returnUrl,
            cancel_url: draft.cancelUrl,
            user_action: "PAY_NOW",
            brand_name: "Spendward Demo",
          },
        },
      },
    }),
  });

  const approve = body.links?.find((l) => l.rel === "payer-action")?.href ?? null;
  return { id: body.id, status: body.status, approveUrl: approve };
}

export async function captureOrder(orderId: string): Promise<{ id: string; status: string }> {
  const body = await call<PayPalOrderResponse>(`/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    body: "{}",
  });
  return { id: body.id, status: body.status };
}

export async function getOrder(orderId: string): Promise<{ id: string; status: string }> {
  const body = await call<PayPalOrderResponse>(`/v2/checkout/orders/${orderId}`, { method: "GET" });
  return { id: body.id, status: body.status };
}
