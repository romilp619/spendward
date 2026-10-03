# Known gaps

Things PayGuard does not do, or does not do well. Kept current deliberately:
a control whose limits are undocumented is a control nobody can rely on.

## The agent supplies `merchant` and `payee`

PayPal's `create_order` schema has no field identifying who receives the funds,
so PayGuard adds `merchant`, `category` and `payee`. The agent fills them.

A sufficiently careful attack could therefore state a truthful-looking merchant
while redirecting the actual payee -- or lie about both.

What still holds in that case: the amount cap, the quantity cap, the cumulative
cap, the tool grant, the subscription rule and the mandate signature. What does
not: the merchant allowlist and the recipient check.

In a real deployment these fields belong to the merchant side of the
transaction, not the agent. Closing this properly means binding them to a
merchant-signed cart -- which is the shape AP2's Cart Mandate already defines.

## Injection detection is not a control

PayGuard records suspicious listing content in the audit trail. It does not
block on it, and should not be read as detecting prompt injection. Detection is
unreliable by nature; the mandate is what refuses the payment, and it refuses
regardless of whether anything was detected.

## The spend ledger is a local file

`audit.jsonl` is hash-chained and tamper-evident, but it is a single file on one
machine. Two PayGuard processes sharing a mandate would race on the cumulative
limit. A real deployment needs a transactional store.

## Benchmark coverage is narrow

Nine scenarios, five models, one agent implementation, one task phrasing.
Enough to show that susceptibility varies and the enforcement point holds; not
enough to characterise any model's susceptibility in general.

## No mandate revocation

A mandate is valid until it expires. There is no way to revoke one early.
