import type { Product } from "../demo/catalog.js";

/**
 * Channel3 product search.
 *
 * Supplies the catalogue the agent shops from. Everything it returns is
 * untrusted: titles, descriptions and merchant names are written by retailers,
 * and they reach the agent verbatim. That is deliberate -- the enforcement
 * point must not depend on the catalogue being honest.
 */
const BASE = "https://api.trychannel3.com";

interface Channel3Offer {
  url?: string;
  domain?: string;
  price?: number | { price?: number; amount?: number; currency?: string };
  availability?: string;
}

interface Channel3Product {
  id: string;
  title: string;
  description?: string;
  brands?: Array<{ id?: string; name?: string }>;
  category?: { slug?: string; title?: string };
  key_features?: string[];
  offers?: Channel3Offer[];
}

/** Offers carry price either as a number or wrapped; accept both. */
function priceOf(offer: Channel3Offer | undefined): number | null {
  const p = offer?.price;
  if (typeof p === "number") return p;
  if (p && typeof p === "object") {
    const n = p.price ?? p.amount;
    if (typeof n === "number") return n;
  }
  return null;
}

/**
 * Narrows a Channel3 result to what a mandate is evaluated against. A listing
 * with no price or no seller cannot be authorized, so it is dropped rather
 * than passed on with a guessed value.
 */
function toProduct(p: Channel3Product): Product | null {
  const offer = p.offers?.find((o) => priceOf(o) !== null);
  const price = priceOf(offer);
  if (price === null || !offer?.domain) return null;

  return {
    id: p.id,
    name: p.title,
    merchant: offer.domain,
    category: p.category?.title ?? "general",
    unitAmount: Math.round(price * 100) / 100,
    description:
      p.description ??
      p.key_features?.join(". ") ??
      [p.brands?.[0]?.name, p.category?.title].filter(Boolean).join(" · "),
  };
}

export function isEnabled(): boolean {
  return Boolean(process.env.CHANNEL3_API_KEY);
}

export async function search(query: string, limit = 8): Promise<Product[]> {
  const key = process.env.CHANNEL3_API_KEY;
  if (!key) throw new Error("CHANNEL3_API_KEY is not set");

  const res = await fetch(`${BASE}/v1/search`, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit, config: { currency: "USD", country: "US" } }),
  });
  if (!res.ok) throw new Error(`Channel3 search failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as Channel3Product[] | { products?: Channel3Product[]; results?: Channel3Product[] };
  const items = Array.isArray(body) ? body : (body.products ?? body.results ?? []);
  return items.map(toProduct).filter((p): p is Product => p !== null);
}
