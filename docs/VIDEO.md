# Demo video script

Target: under 3 minutes. ~370 words of narration, which leaves room for silence
while things happen on screen. Generate the audio first, then record the screen
while listening to it, so clicks land on the words describing them.

Reset before every take: `npm run demo`

---

## 0:00 – 0:18 · The problem

> **[screen: PayPal's agent tools reference, scrolled to show the tool list]**

PayPal's agent toolkit gives an AI agent forty-six tools.
Create refund. Cancel subscription. Accept dispute claim.

*(pause)*

Connect an agent to it, and it can call all of them.

There is no way to say: buy one pair of headphones, under two hundred fifty
dollars, from this one shop.

---

## 0:18 – 0:34 · What PayGuard is

> **[screen: the PayGuard dashboard, idle]**

That sentence only exists between you and your agent. It never reaches PayPal,
so PayPal cannot enforce it.

PayGuard can. It sits between the agent and PayPal, and it only lets through
what you actually signed off on.

---

## 0:34 – 1:05 · The normal case

> **[screen: terminal, `npm run demo`, first block only]**

The agent asks to buy headphones. Two hundred nineteen dollars, from TechStore,
one unit. That is inside the mandate, so PayGuard passes it to PayPal and a real
order comes back.

> **[screen: dashboard, the allowed row appears]**

Normal purchases are not the interesting part. These are.

---

## 1:05 – 1:30 · The block  ← the moment that matters

> **[screen: terminal, the refused block. Hold on the violation list.]**

The same agent, manipulated by a product listing, asks for three units and
sends the money somewhere else entirely.

*(pause — let the red text sit)*

PayGuard refuses. Wrong recipient. Too many units. Four hundred seven dollars
over the limit.

> **[screen: dashboard, click the blocked row, open the investigation panel]**

And PayPal was never called. Not a failed payment. No payment at all.

---

## 1:30 – 1:50 · Tool escalation

> **[screen: terminal, the create_refund refusal]**

The agent then reaches for refunds — a tool it was never granted.

Refused. Its mandate covers buying. Nothing else.

---

## 1:50 – 2:25 · Approval and settlement

> **[screen: dashboard approval card → Approve once → PayPal checkout → Complete Purchase → return page]**

Two hundred eighty nine dollars is over the limit, but within the ceiling you
set. So PayGuard does not refuse it. It asks you.

You approve. The buyer pays at PayPal.

*(pause)*

And PayPal's own signed confirmation comes back, so PayGuard settles it
automatically. Two seconds, no second click.

---

## 2:25 – 2:45 · The evidence

> **[screen: dashboard, webhook events with verified badges, then the audit chain card]**

Every decision is recorded and hash-chained. Change one row and the chain
breaks.

> **[screen: terminal, `npm run audit:verify` showing CHAIN BROKEN]**

---

## 2:45 – 3:00 · The benchmark

> **[screen: RESULTS.md table]**

Six injection attacks, five different models. Susceptibility ranged from one in
six to four in six. No two models failed the same way.

PayGuard held twenty eight out of twenty eight.

*(pause)*

You cannot know which way your model will go. That is the point.

---

## Production notes

- **Audio first.** Generate per-beat clips, not one long file, so a rewrite
  costs one clip.
- **Burn in captions.** The script is the caption text, and three of the judges
  work on accessibility.
- **No order IDs in narration** — text-to-speech mangles them. Let the screen
  show them.
- **Large terminal font.** Judges watch on laptops.
- **No music**, or a quiet CC0 bed. The rules forbid copyrighted audio.
- Rehearse the whole run five times before recording. You will find bugs.
