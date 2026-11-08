import type { Mandate, SignedMandate } from "./mandate.js";
import { enforcementKey, verifyMandate } from "./mandate.js";
import type { Listing } from "./listings.js";

/** One line of an order, as the agent described it. */
export interface OrderItem {
  /** The listing this item came from, as returned by search_products. */
  productId?: string | undefined;
  name: string;
  quantity: number;
  unitAmount: number;
}

export type Outcome = "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";

/** What the agent is asking Spendward to let it do. */
export interface PaymentRequest {
  tool: string;
  amount: number;
  currency: string;
  quantity: number;
  merchant: string;
  category: string;
  /** Who the money would actually reach. Must match the merchant. */
  recipient: string;
  isSubscription: boolean;
  /** Where the agent got this instruction. Recorded for the audit trail. */
  sourceContext?: string;
  /** The order's lines, each naming the listing it came from. */
  items?: OrderItem[];
}

export interface Violation {
  rule: string;
  severity: Severity;
  /** The constraint, in the mandate's own terms. */
  policy: string;
  /** What the agent asked for. */
  requested: string;
  /** Why the two are incompatible. */
  evidence: string;
  escalatable: boolean;
}

export interface Decision {
  outcome: Outcome;
  violations: Violation[];
  mandateId: string | null;
}

export interface LedgerState {
  /** Already spent under this mandate in the current budget period, in its currency. */
  spent: number;
  /** When the principal revoked this mandate, if they did. */
  revokedAt?: string | null;
  /**
   * The PayPal account this payment would actually reach, as resolved by
   * Spendward from the mandate or the merchant directory -- never from the
   * agent. null means no account is known for the merchant, so nobody can say
   * where the money would go. Left undefined for calls that pay no one.
   */
  payeeAccount?: string | null;
  /**
   * The listings the request's items name, as Spendward recorded them when it
   * showed them to the agent. Undefined for calls that buy nothing.
   */
  listings?: Record<string, Listing | null>;
}

/**
 * A category is allowed when the shop's category name contains it as whole
 * words: "headphones" covers "In-Ear Headphones" but not "Headphone Stands".
 * Shops name categories their own way, and a principal writes "headphones",
 * not one shop's taxonomy.
 */
export function categoryAllowed(allowed: string[], category: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const have = words(category);
  return allowed.some((a) => {
    const want = words(a);
    if (want.length === 0) return false;
    for (let i = 0; i + want.length <= have.length; i++) {
      if (want.every((w, j) => have[i + j] === w)) return true;
    }
    return false;
  });
}

/** Every way an order departs from the listings its items name. Empty when it matches. */
export function listingProblems(request: PaymentRequest, listings: Record<string, Listing | null>): string[] {
  const items = request.items ?? [];
  if (items.length === 0) return ["the order lists no items"];
  const out: string[] = [];
  for (const it of items) {
    const label = `"${it.name}"`;
    if (!it.productId) { out.push(`${label} names no listing`); continue; }
    const l = listings[it.productId];
    if (!l) { out.push(`${label} names listing ${it.productId}, which Spendward never returned`); continue; }
    if (l.merchant !== request.merchant) out.push(`${label} is sold by ${l.merchant}, not ${request.merchant}`);
    if (Math.abs(l.unitAmount - it.unitAmount) > 0.005) out.push(`${label} is listed at ${l.unitAmount}, not ${it.unitAmount}`);
    if (l.category !== request.category) out.push(`${label} is listed under ${l.category}, not ${request.category}`);
  }
  return out;
}

const PERIOD_WORD = { none: "", day: " today", week: " this week", month: " this month" } as const;

const money = (n: number, currency: string) => `${currency} ${n.toFixed(2)}`;

/**
 * The deterministic half of Spendward. No model runs here: a decision is a
 * function of the signed mandate, the request, and what has already been
 * spent. That is deliberate -- we do not want an LLM deciding whether money
 * moves, and it means a payment is refused whether the cause was a prompt
 * injection, a hallucination, or an ordinary bug.
 */
export function evaluate(
  signed: SignedMandate,
  request: PaymentRequest,
  ledger: LedgerState,
  now: Date = new Date(),
): Decision {
  const v: Violation[] = [];

  // Signature first. An unverified mandate tells us nothing, so no later rule
  // would mean anything.
  if (!verifyMandate(signed, enforcementKey())) {
    return {
      outcome: "BLOCK",
      mandateId: null,
      violations: [
        {
          rule: "MANDATE_SIGNATURE_INVALID",
          severity: "CRITICAL",
          policy: "mandate must carry a valid signature",
          requested: `mandate ${signed.mandate.id}`,
          evidence: "signature does not match mandate contents; it was forged or altered",
          escalatable: false,
        },
      ],
    };
  }

  const m: Mandate = signed.mandate;

  // Revocation outranks every other rule: the principal has withdrawn the
  // authority this mandate granted, and no approval can restore it.
  if (ledger.revokedAt) {
    return {
      outcome: "BLOCK",
      mandateId: m.id,
      violations: [
        {
          rule: "MANDATE_REVOKED",
          severity: "CRITICAL",
          policy: `revoked by the principal at ${ledger.revokedAt}`,
          requested: request.tool,
          evidence: "this mandate no longer grants any authority",
          escalatable: false,
        },
      ],
    };
  }

  if (new Date(m.expiresAt) <= now) {
    v.push({
      rule: "MANDATE_EXPIRED",
      severity: "CRITICAL",
      policy: `expires ${m.expiresAt}`,
      requested: now.toISOString(),
      evidence: "mandate is no longer valid",
      escalatable: false,
    });
  }

  if (!m.allowedTools.includes(request.tool)) {
    v.push({
      rule: "TOOL_NOT_PERMITTED",
      severity: "CRITICAL",
      policy: `allowed tools: ${m.allowedTools.join(", ")}`,
      requested: request.tool,
      evidence: `agent attempted a capability outside its grant`,
      escalatable: false,
    });
  }

  if (request.currency !== m.currency) {
    v.push({
      rule: "CURRENCY_MISMATCH",
      severity: "HIGH",
      policy: m.currency,
      requested: request.currency,
      evidence: "mandate limits are denominated in a different currency",
      escalatable: false,
    });
  }

  // The recipient is checked separately from the merchant because an injection
  // typically keeps a plausible merchant name while redirecting the money.
  if (request.recipient !== request.merchant) {
    v.push({
      rule: "UNAUTHORIZED_RECIPIENT",
      severity: "CRITICAL",
      policy: `funds may only reach the named merchant (${request.merchant})`,
      requested: request.recipient,
      evidence: "payment would be delivered to a party other than the merchant",
      escalatable: false,
    });
  }

  // The order must be what the agent was shown: every item names a listing
  // Spendward returned, from the shop the order claims, at that listing's
  // price, in its category. This is what stops an agent relabelling a
  // stranger's product as an allowed shop's, inflating a price, or adding a
  // line no listing offered. Not waivable: it is a false description, not a
  // judgement call.
  if (ledger.listings !== undefined) {
    const problems = listingProblems(request, ledger.listings);
    if (problems.length) {
      v.push({
        rule: "LISTING_MISMATCH",
        severity: "CRITICAL",
        policy: "every item matches a listing Spendward returned: same shop, price and category",
        requested: problems.join("; "),
        evidence: "the order does not match what the agent was shown",
        escalatable: false,
      });
    }
  }

  if (!m.allowedMerchants.includes(request.merchant)) {
    v.push({
      rule: "MERCHANT_NOT_ALLOWED",
      severity: "HIGH",
      policy: `allowed merchants: ${m.allowedMerchants.join(", ")}`,
      requested: request.merchant,
      evidence: "merchant is not on the mandate's allowlist",
      escalatable: true,
    });
  }

  // Spendward, not the agent, decides where the money goes. A merchant with no
  // known PayPal account cannot be paid safely: there is nothing to bind the
  // order's payee to, and approving it would mean approving an unknown recipient.
  if (ledger.payeeAccount === null) {
    v.push({
      rule: "UNKNOWN_PAYEE",
      severity: "CRITICAL",
      policy: "payments go only to a PayPal account named in the mandate or the merchant directory",
      requested: request.merchant,
      evidence: "no PayPal account is on record for this merchant, so the recipient cannot be verified",
      escalatable: false,
    });
  }

  // An empty list means the mandate does not constrain category at all, which
  // is different from constraining it to nothing.
  if (m.allowedCategories.length > 0 && !categoryAllowed(m.allowedCategories, request.category)) {
    v.push({
      rule: "CATEGORY_NOT_ALLOWED",
      severity: "MEDIUM",
      policy: `allowed categories: ${m.allowedCategories.join(", ")}`,
      requested: request.category,
      evidence: "purchase falls outside the authorized categories",
      escalatable: true,
    });
  }

  if (request.isSubscription && !m.allowSubscriptions) {
    v.push({
      rule: "SUBSCRIPTION_NOT_ALLOWED",
      severity: "HIGH",
      policy: "one-time purchases only",
      requested: "recurring subscription",
      evidence: "a subscription creates spending beyond this mandate's window",
      escalatable: false,
    });
  }

  if (request.quantity > m.maxQuantity) {
    v.push({
      rule: "QUANTITY_LIMIT",
      severity: "HIGH",
      policy: `quantity <= ${m.maxQuantity}`,
      requested: String(request.quantity),
      evidence: `${request.quantity - m.maxQuantity} unit(s) over the authorized quantity`,
      escalatable: true,
    });
  }

  if (request.amount > m.maxTransactionAmount) {
    const overage = request.amount - m.maxTransactionAmount;
    // Within the approval ceiling this is a judgement call that belongs to the
    // principal, not to us. Above it, nothing short of a new mandate suffices.
    const escalatable = request.amount <= m.approvalCeiling;
    v.push({
      rule: "MANDATE_MAX_AMOUNT",
      severity: escalatable ? "MEDIUM" : "CRITICAL",
      policy: `amount <= ${money(m.maxTransactionAmount, m.currency)}`,
      requested: money(request.amount, m.currency),
      evidence: escalatable
        ? `${money(overage, m.currency)} over the delegated limit, within the approval ceiling of ${money(m.approvalCeiling, m.currency)}`
        : `${money(overage, m.currency)} over the delegated limit and above the approval ceiling of ${money(m.approvalCeiling, m.currency)}`,
      escalatable,
    });
  }

  const projected = ledger.spent + request.amount;
  const when = PERIOD_WORD[m.budgetPeriod ?? "none"];
  if (projected > m.maxTotalAmount) {
    v.push({
      rule: "CUMULATIVE_LIMIT",
      severity: "HIGH",
      policy: `total spend <= ${money(m.maxTotalAmount, m.currency)}${when ? ` per ${m.budgetPeriod}` : ""}`,
      requested: money(projected, m.currency),
      evidence:
        ledger.spent > 0
          ? `${money(ledger.spent, m.currency)} already spent${when}, leaving ${money(m.maxTotalAmount - ledger.spent, m.currency)}`
          : `single payment alone exceeds the budget of ${money(m.maxTotalAmount, m.currency)}`,
      // Not waivable. The per-transaction cap exists to be escalated -- that is
      // what approvalCeiling is for -- but a total the principal can raise one
      // click at a time is not a total. Spending more needs a new mandate.
      escalatable: false,
    });
  }

  // A single unescalatable violation is decisive. Escalation is only offered
  // when every objection is one the principal is entitled to waive.
  const outcome: Outcome =
    v.length === 0 ? "ALLOW" : v.some((x) => !x.escalatable) ? "BLOCK" : "REQUIRE_APPROVAL";

  return { outcome, violations: v, mandateId: m.id };
}
