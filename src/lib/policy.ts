import type { Mandate, SignedMandate } from "./mandate.js";
import { verifyMandate } from "./mandate.js";

export type Outcome = "ALLOW" | "REQUIRE_APPROVAL" | "BLOCK";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM";

/** What the agent is asking PayGuard to let it do. */
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
  /** Already spent under this mandate, in its currency. */
  spent: number;
}

const money = (n: number, currency: string) => `${currency} ${n.toFixed(2)}`;

/**
 * The deterministic half of PayGuard. No model runs here: a decision is a
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
  const key = process.env.MANDATE_SIGNING_KEY;
  if (!key) throw new Error("MANDATE_SIGNING_KEY is not set");

  if (!verifyMandate(signed, key)) {
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

  if (!m.allowedCategories.includes(request.category)) {
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
  if (projected > m.maxTotalAmount) {
    v.push({
      rule: "CUMULATIVE_LIMIT",
      severity: "HIGH",
      policy: `total spend <= ${money(m.maxTotalAmount, m.currency)}`,
      requested: money(projected, m.currency),
      evidence:
        ledger.spent > 0
          ? `${money(ledger.spent, m.currency)} already spent, leaving ${money(m.maxTotalAmount - ledger.spent, m.currency)} of this mandate`
          : `single payment alone exceeds the mandate's total of ${money(m.maxTotalAmount, m.currency)}`,
      escalatable: true,
    });
  }

  // A single unescalatable violation is decisive. Escalation is only offered
  // when every objection is one the principal is entitled to waive.
  const outcome: Outcome =
    v.length === 0 ? "ALLOW" : v.some((x) => !x.escalatable) ? "BLOCK" : "REQUIRE_APPROVAL";

  return { outcome, violations: v, mandateId: m.id };
}
