import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Product } from "../demo/catalog.js";
import { withLock } from "./lock.js";

/**
 * Every listing Spendward has shown the agent, keyed by its id.
 *
 * The agent describes what it is buying; this is what it was actually shown.
 * An order item must name the listing it came from, and its shop, price and
 * category must match that listing. So an agent cannot relabel a stranger's
 * product as an allowed shop's, quietly raise a price, or add an item no
 * listing offered. The listing is the catalogue's record, not the agent's.
 */
export interface Listing {
  id: string;
  name: string;
  merchant: string;
  category: string;
  unitAmount: number;
  seenAt: string;
}

const path = () => process.env.SPENDWARD_LISTINGS ?? "listings.json";

function readAll(): Record<string, Listing> {
  if (!existsSync(path())) return {};
  try {
    return JSON.parse(readFileSync(path(), "utf8")) as Record<string, Listing>;
  } catch {
    return {};
  }
}

export function remember(products: Product[]): void {
  if (products.length === 0) return;
  withLock("listings", () => {
    const all = readAll();
    const at = new Date().toISOString();
    for (const p of products) {
      all[p.id] = { id: p.id, name: p.name, merchant: p.merchant, category: p.category, unitAmount: p.unitAmount, seenAt: at };
    }
    writeFileSync(path(), JSON.stringify(all) + "\n");
  });
}

/** The listings an order's items refer to; ids Spendward never returned map to null. */
export function lookup(ids: string[]): Record<string, Listing | null> {
  const all = readAll();
  return Object.fromEntries(ids.map((id) => [id, all[id] ?? null]));
}
