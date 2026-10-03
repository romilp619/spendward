import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A mandate is the authorization a human grants an agent. It is the only
 * source of truth about what that agent may spend. Agents never see the
 * signing key, so they cannot widen their own permissions -- an agent that
 * has been manipulated into asking for more still presents the same mandate.
 */
export interface Mandate {
  id: string;
  principal: string;
  agent: string;
  issuedAt: string;
  expiresAt: string;
  currency: string;
  /** Hard ceiling on a single payment. Above this, see approvalCeiling. */
  maxTransactionAmount: number;
  /** Cumulative ceiling across every payment made under this mandate. */
  maxTotalAmount: number;
  /**
   * Between maxTransactionAmount and this value, a payment is escalated to the
   * principal instead of refused outright. Above it, nothing can authorize it
   * except a new mandate.
   */
  approvalCeiling: number;
  maxQuantity: number;
  allowedMerchants: string[];
  allowedCategories: string[];
  allowSubscriptions: boolean;
  /** Capabilities the agent may invoke. Anything absent is refused. */
  allowedTools: string[];
}

export interface SignedMandate {
  mandate: Mandate;
  signature: string;
}

/**
 * Stable serialization so the same mandate always produces the same bytes.
 * Key order in a JS object is not guaranteed across code paths, and an
 * unstable encoding would make signatures spuriously fail to verify.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function signMandate(mandate: Mandate, key: string): SignedMandate {
  const signature = createHmac("sha256", key).update(canonicalize(mandate)).digest("hex");
  return { mandate, signature };
}

/**
 * Verifies the mandate was issued by the holder of the signing key and has not
 * been edited since. Compared in constant time so a caller cannot learn the
 * expected signature byte by byte from timing.
 */
export function verifyMandate(signed: SignedMandate, key: string): boolean {
  const expected = createHmac("sha256", key).update(canonicalize(signed.mandate)).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(signed.signature, "hex");
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
