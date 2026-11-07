# Known gaps

Things Spendward does not do, or does not do well. Kept current deliberately:
a control whose limits are undocumented is a control nobody can rely on.

## The agent still says which shop it is buying from

Spendward, not the agent, decides which PayPal account an order pays: the
account signed into the mandate for that shop, written onto the order as its
`payee`. So an agent cannot send money to an account you never approved.

What the agent still controls is the claim that a product comes from a given
shop. A manipulated agent could buy something from a stranger's listing while
labelling it `bestbuy.com`. The money would then go to Best Buy's real account
for an order Best Buy never sold -- a failed or refunded order, not stolen
funds -- but the mandate cannot prove which shop a listing belongs to.

Closing this means binding the order to a cart the merchant signed, which is
the shape AP2's Cart Mandate already defines.

## By default every demo shop shares one PayPal account

`npm run setup` maps all demo shops to the business account PayPal created
for your app, so the payee binding works with no extra setup but every shop
shares a till. Separate sandbox business accounts per shop, listed in
`merchants.json`, make the binding visible.

## The signing key and the enforcement point share a machine

The principal's private key is in `.env`, which the dashboard reads to sign
mandates. The MCP server the agent talks to discards that key at startup and
verifies with the public key alone, and the demo agent is launched without it.
But they run as the same user on the same disk, so an agent with shell access
could read the file. In a real deployment the key belongs on the principal's
device -- a passkey or a phone -- and only the public key reaches the server.

## The dashboard has no login

Anyone who can reach the dashboard can approve, sign, switch or revoke
mandates and connect a wallet. It is meant to run on localhost. Exposed
anywhere else it needs authentication in front of every action, ideally the
same passkey that holds the signing key.

## Injection detection is not a control

Spendward records suspicious listing content in the audit trail. It does not
block on it, and should not be read as detecting prompt injection. Detection is
unreliable by nature; the mandate is what refuses the payment, and it refuses
regardless of whether anything was detected.

## The spend ledger is a local file

`audit.jsonl` is HMAC-chained, so it cannot be rewritten without `AUDIT_KEY`.
Someone who holds that key can still rewrite it end to end; publishing the
latest hash somewhere outside the machine would close that. It is also a
single file: two Spendward processes sharing a mandate would race on the
budget. A real deployment needs a transactional store.

## Benchmark coverage is narrow

Nine scenarios, six models, one agent implementation, one task phrasing.
Enough to show that susceptibility varies and the enforcement point holds; not
enough to characterise any model's susceptibility in general.

The demo's attack uses a planted listing (`src/demo/planted.ts`). It is
labelled as such, off unless the demo scripts enable it, and it is the only
synthetic content in a live run. Whether a given model falls for it changes
between runs: the model the demo uses refused it when it could ask the user,
and fell for it every time it ran unattended.

## The saved wallet is a local file

The PayPal Vault token sits in `wallet.json`. It cannot be used to log in to
the wallet, only to charge it through this PayPal app, and it can be revoked
from the dashboard or from the PayPal account. It deserves the same protection
as the signing key.

## The capture guard is not atomic

Capture checks the audit log for an existing capture of the order, calls
PayPal, then records the capture. Two clicks -- or a click and a webhook --
landing at the same moment can both pass the check before either writes. PayPal itself refuses the second capture, so money moves once -- but
Spendward's own log can gain a duplicate entry.

The approvals file is read-modify-write with no locking, which is the same
weakness as the spend ledger. Both want a transactional store.

## Calls refused downstream are recorded, not retried

When Spendward allows a call and PayPal then rejects it -- an unknown order id,
an order not yet approved by the buyer -- the attempt is written to the audit
trail with PayPal's error, and counts toward nothing. Spendward does not retry
or reconcile; the agent is told the call failed and decides what to do.

## An unpaid order holds budget for a fixed window

An order counts against the mandate from the moment it is created, so an agent
cannot open many orders at once to get past the total. PayPal does not tell
Spendward when a buyer abandons checkout, so an unpaid order instead stops
holding budget after `SPENDWARD_RESERVE_HOURS` (default 3). If the buyer pays
after that, the capture still counts -- but in the gap, the budget it held was
briefly available to other orders.

## Revoking stops new spending, not old

Revoking a mandate refuses every later request and every pending approval. It
does not cancel orders already created at PayPal: a buyer can still pay one,
and Spendward will still capture it, because the authority was valid when the
order was made. Undoing a payment is a refund, which is a human's decision.
