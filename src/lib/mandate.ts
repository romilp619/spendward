import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * A mandate is the authorization a human grants an agent. It is the only
 * source of truth about what that agent may spend.
 *
 * It is signed with the principal's private key and verified with their public
 * key. The enforcement point -- the MCP server the agent talks to -- holds only
 * the public key, so nothing the agent can reach is able to issue or widen a
 * mandate. A shared secret would not give that: whoever verifies could also sign.
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
  /** Ceiling on everything spent within one budget period. */
  maxTotalAmount: number;
  /**
   * The window maxTotalAmount applies to. "none" means once, for the life of
   * the mandate; otherwise the budget resets at the start of each calendar
   * day, week (Monday) or month, in UTC.
   */
  budgetPeriod: BudgetPeriod;
  /**
   * Between maxTransactionAmount and this value, a payment is escalated to the
   * principal instead of refused outright. Above it, nothing can authorize it
   * except a new mandate.
   */
  approvalCeiling: number;
  maxQuantity: number;
  allowedMerchants: string[];
  /**
   * Where the money for each allowed merchant goes: a PayPal merchant ID or the
   * email of a PayPal business account. Spendward sends this to PayPal as the
   * order's payee, so the agent never chooses who is paid. Signed with
   * everything else, which makes the destination part of what was authorized.
   */
  payees: Record<string, string>;
  allowedCategories: string[];
  allowSubscriptions: boolean;
  /** Capabilities the agent may invoke. Anything absent is refused. */
  allowedTools: string[];
}

export type BudgetPeriod = "none" | "day" | "week" | "month";

export interface SignedMandate {
  mandate: Mandate;
  /** Ed25519 signature over the canonical mandate, base64. */
  signature: string;
  /** Fingerprint of the public key that verifies it, so a mismatch is explainable. */
  keyId: string;
}

/**
 * Stable serialization so the same mandate always produces the same bytes.
 * Key order in a JS object is not guaranteed across code paths, and an
 * unstable encoding would make signatures spuriously fail to verify.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** Keys travel as base64 DER (PKCS#8 private, SPKI public): one line, safe in a .env file. */
export function generateKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const privateKeyFrom = (b64: string) => createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
const publicKeyFrom = (b64: string) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

export function keyId(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 16);
}

export function publicKeyOf(privateKey: string): string {
  return createPublicKey(privateKeyFrom(privateKey)).export({ format: "der", type: "spki" }).toString("base64");
}

export function signMandate(mandate: Mandate, privateKey: string): SignedMandate {
  const signature = sign(null, Buffer.from(canonicalize(mandate)), privateKeyFrom(privateKey)).toString("base64");
  return { mandate, signature, keyId: keyId(publicKeyOf(privateKey)) };
}

/** True only if the principal's key signed exactly these contents. */
export function verifyMandate(signed: SignedMandate, publicKey: string): boolean {
  try {
    return verify(null, Buffer.from(canonicalize(signed.mandate)), publicKeyFrom(publicKey), Buffer.from(signed.signature, "base64"));
  } catch {
    return false;
  }
}

/** The key the enforcement point verifies against. Never the private one. */
export function enforcementKey(): string {
  const key = process.env.MANDATE_PUBLIC_KEY;
  if (!key) throw new Error("MANDATE_PUBLIC_KEY is not set. Run `npm run setup`.");
  return key;
}

/** The principal's signing key. Only the principal's console and the mint CLI use it. */
export function principalKey(): string {
  const key = process.env.MANDATE_PRIVATE_KEY;
  if (!key) throw new Error("MANDATE_PRIVATE_KEY is not set. Run `npm run setup`.");
  return key;
}
