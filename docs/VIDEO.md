# Demo video script

Under 3 minutes. ~360 words of narration, leaving room for silence while things
happen on screen. Generate the audio first, then record the screen while
listening to it so clicks land on the words describing them.

**Before every take:** start the tunnel, start `npm run web`, open
localhost:3000, then run `npm run demo`.

---

## 0:00 – 0:20 · The problem

> **[screen: PayPal's agent tools reference, the tool list visible]**

PayPal's agent toolkit gives an A I agent forty-six tools. Create refund.
Cancel subscription. Accept dispute claim.

*(pause)*

Connect an agent, and it can call every one of them.

There is no way to say: buy one pair of headphones, under two hundred fifty
dollars, from this one shop.

---

## 0:20 – 0:36 · What Spendward is

> **[screen: the dashboard, freshly reset]**

That sentence only exists between you and your agent. It never reaches PayPal,
so PayPal cannot enforce it.

Spendward can. It sits between the agent and PayPal and passes through only what
you actually authorized.

---

## 0:36 – 1:00 · The agent behaves perfectly

> **[screen: terminal, `npm run demo`, first block. Dashboard visible alongside.]**

A real agent, searching a real catalogue. It finds the Sony headphones, two
hundred nineteen dollars, and orders them.

Inside the mandate. Spendward passes it to PayPal, and a real order comes back.

*(pause)*

Now watch what happens when the agent does nothing wrong at all.

---

## 1:00 – 1:20 · A name in the wrong field  ← the quiet one

> **[screen: terminal. Hold on the two create_order calls, side by side.]**

Watch this. The agent fills in the payee as, quote, Best Buy.

*(pause)*

Refused. Funds may only reach bestbuy dot com. Best Buy is a name. It is not
who gets paid.

The agent corrects itself, and the order goes through.

*(pause)*

No attack. No injection. A plausible string in the wrong field, which is how
money actually goes missing.

---

## 1:20 – 1:45 · Blocked  ← the loud one

> **[screen: terminal, the Sennheiser refusal. Hold on the red text.]**

The agent is asked for a different pair. It searches honestly, finds them, and
orders them. Four hundred forty nine dollars.

*(pause)*

Refused. Nearly two hundred dollars over the limit, and above the ceiling, so
no approval can rescue it.

> **[screen: dashboard, click the blocked row, open the investigation panel]**

And PayPal was never called. Not a failed payment. No payment at all.

---

## 1:45 – 2:00 · A tool it was never given

> **[screen: terminal, the create_refund refusal]**

Then the agent is asked for a refund.

It has the capture id. It knows exactly what to do. Refused anyway — refunds
were never in its grant.

---

## 2:00 – 2:30 · Approval and settlement

> **[screen: dashboard approval card → Approve once → PayPal checkout → Complete Purchase → return page]**

Two hundred eighty nine dollars is over the limit but within the ceiling you
set. So Spendward does not refuse it. It asks you.

You approve. The buyer pays at PayPal.

*(pause)*

PayPal's own signed confirmation comes back, and Spendward settles it
automatically. Two seconds. No second click.

---

## 2:30 – 2:45 · The record

> **[screen: webhook events with verified badges, then the audit chain card]**

Two independent records that agree. What Spendward decided, and what PayPal says
happened.

Every decision is hash chained. Change one row and the chain breaks.

> **[screen: terminal, `npm run audit:verify` showing CHAIN BROKEN]**

---

## 2:45 – 3:00 · The benchmark

> **[screen: RESULTS.md table]**

Six injection attacks, five different models. Susceptibility ranged from one in
six to three in six. No two models failed the same way.

Spendward held twenty eight out of twenty eight.

*(pause)*

You cannot know which way your model will go. That is the point.

---

## Production notes

- **Audio first**, per beat, not one long file.
- **Burn in captions.** The script is the caption text, and three judges work on
  accessibility.
- **No order ids in narration** -- text to speech mangles them. Let the screen
  show them.
- **Large terminal font.** Judges watch on laptops.
- **No music**, or a quiet CC0 bed. The rules forbid copyrighted audio.
- **Say "A I" not "AI"** in the script you feed the voice, or it may read it as
  a word. Likewise write "bestbuy dot com", not the URL.
- Rehearse five times before recording.

## Why this framing

The agent is never the villain. It searches honestly, reports accurately, and
refuses to work around its limits. Four of the five refusals happen because the
*product* breaches the mandate, not because the agent misbehaved.

That is the realistic case -- most breaches are overspending or ordinary
mistakes, not attacks -- and it is also the reliable one. The benchmark found injection susceptibility varies
from one in six to three in six across models, while these outcomes held on every
model tested.
