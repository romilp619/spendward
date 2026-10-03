import type { SignedMandate } from "./mandate.js";
import type { Decision, LedgerState, PaymentRequest } from "./policy.js";
import { evaluate } from "./policy.js";
import { createOrder, type Order } from "./paypal.js";

export interface GuardResult {
  decision: Decision;
  /** Present only when the request was allowed and actually reached PayPal. */
  order: Order | null;
}

/**
 * The enforcement point. Policy is evaluated before PayPal is contacted, so a
 * refused request leaves no trace on the payment provider's side at all --
 * which is the property we demonstrate by showing an empty sandbox ledger
 * after a blocked attempt.
 */
export async function guardedPurchase(
  signed: SignedMandate,
  request: PaymentRequest,
  ledger: LedgerState,
  urls: { returnUrl: string; cancelUrl: string },
): Promise<GuardResult> {
  const decision = evaluate(signed, request, ledger);

  if (decision.outcome !== "ALLOW") {
    return { decision, order: null };
  }

  const order = await createOrder({
    amount: request.amount,
    currency: request.currency,
    description: `${request.merchant} - ${request.category}`,
    returnUrl: urls.returnUrl,
    cancelUrl: urls.cancelUrl,
  });

  return { decision, order };
}
