import type { Mandate } from "./mandate.js";
import type { Decision, PaymentRequest } from "./policy.js";
import { createOrder, type Order } from "./paypal.js";
import { record } from "./audit.js";
import { resolvePayee } from "./merchants.js";
import { forgetWallet, wallet } from "./wallet.js";

/**
 * Places an order the rules have already allowed. Shared by the agent's path
 * and the approval path, so both bind the payee and use the wallet the same
 * way. Callers evaluate first; this function does not decide anything.
 */
export async function placeOrder(
  m: Mandate,
  request: PaymentRequest,
  urls: { returnUrl: string; cancelUrl: string },
): Promise<Order & { payeeName: string; walletRejected: boolean }> {
  const payee = resolvePayee(m, request.merchant);
  // The rules refuse an unknown payee before we get here. Checked again
  // because sending an order with no payee would pay the app's own account.
  if (!payee) throw new Error(`no PayPal account on record for ${request.merchant}`);
  const base = {
    amount: request.amount,
    currency: request.currency,
    description: `${request.merchant} - ${request.category}`,
    returnUrl: urls.returnUrl,
    cancelUrl: urls.cancelUrl,
    payee: payee.account,
  };
  const saved = wallet();
  if (!saved) return { ...(await createOrder({ ...base, vaultId: null })), payeeName: payee.name, walletRejected: false };
  try {
    return { ...(await createOrder({ ...base, vaultId: saved.vaultId })), payeeName: payee.name, walletRejected: false };
  } catch (walletErr) {
    // PayPal refused to charge the saved wallet. If the same order goes through
    // without it, the wallet was the problem (connected through another app, or
    // removed at PayPal): forget it, and let this order wait at checkout. That
    // only adds a human step. If it fails without the wallet too, the cause is
    // something else, so the wallet is kept and the original error stands.
    let order: Order;
    try {
      order = await createOrder({ ...base, vaultId: null });
    } catch {
      throw walletErr;
    }
    forgetWallet();
    return { ...order, payeeName: payee.name, walletRejected: true };
  }
}

/** Records that money moved for an order: a capture, or a wallet charge at creation. */
export function recordPayment(input: {
  agent: string;
  mandateId: string | null;
  request: PaymentRequest;
  orderId: string;
  payee: string | null;
}): void {
  const decision: Decision = { outcome: "ALLOW", violations: [], mandateId: input.mandateId };
  record({
    agent: input.agent,
    tool: "pay_order",
    decision,
    request: { ...input.request, tool: "pay_order" },
    paypalOrderId: input.orderId,
    payeeAccount: input.payee,
  });
}
