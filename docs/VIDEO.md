# Demo video: shot list and narration

Target: **2:50**, under the 3-minute limit. Upload to YouTube as **Public**.

Record each scene as its own short clip, then join them in order and lay the
narration over them. Agent runs take 15 to 30 seconds; trim the waiting or
speed it up 2x. Nothing needs to be recorded in one take.

## Before you record

1. Open **https://spendward.onrender.com** (resume the Render service first).
2. **Mandates**: the wallet shows **Connected**. If not, Connect PayPal wallet
   and approve with the personal sandbox account.
3. **Try it**: make sure it says **Demo shop**, then click **Reset demo**.
4. Browser: dark mode, zoom 110 to 125%, hide the bookmarks bar, close other tabs.
5. Screen recorder at 1920x1080 (OBS, Xbox Game Bar with Win+Alt+R, or Swoop).

## Scenes

| # | Time | On screen | Narration |
| --- | --- | --- | --- |
| 1 | 0:00 to 0:15 | **Overview** page, still | AI agents can now shop and pay for you. But one PayPal connection gives an agent every power: any amount, any shop, refunds, subscriptions. And agents can be fooled by what they read. |
| 2 | 0:15 to 0:35 | **Mandates**: click **New mandate**, type a sentence, click **Draft with AI**, show the form | Spendward fixes that. You describe what your agent may spend in plain words. The AI drafts a mandate, shows every assumption it made, and you sign it with your own key. Nothing is in force until you sign. |
| 3 | 0:35 to 1:00 | **Try it** → **A normal purchase**. Show the transcript ending "paid from the user's saved PayPal wallet", then **Activity** with Create order and Pay order at the same second, and **PayPal confirmations** | Here the agent buys headphones inside the mandate. Spendward checks every call before PayPal hears of it, sets who gets paid itself, and the agent pays on its own from a saved PayPal wallet. PayPal confirms it, verified. |
| 4 | 1:00 to 1:25 | **Try it** → **A little over the limit**. Click **Go to Overview**, show the amber card "Approving pays TechStore…", click **Approve once** | This one costs more than the agent may spend on its own, so it waits for me. I see exactly which PayPal account would be paid, approve once, and it is paid. |
| 5 | 1:25 to 2:05 | **Try it** → **Prompt injection: a redirected payment**. Pause on the agent's message noting the embedded instruction, then on the red Spendward box `UNAUTHORIZED_RECIPIENT` | Now an attack. This product page hides an instruction to send the money to a "settlement account". Watch: the agent even notices the instruction, then follows it anyway. Spendward refuses. The money can only reach the account I signed for, and PayPal is never called. |
| 6 | 2:05 to 2:25 | **Try it** → **Prompt injection: a hidden subscription**, the red box. Then a quick cut of **Too expensive** being blocked | Same with a product that slips in a monthly subscription. In our tests the agent was fooled every time it ran unattended. Spendward blocked every one. It never relies on the AI noticing. |
| 7 | 2:25 to 2:40 | **Activity**: the decision log, filter chips, **Export CSV**, the "intact · keyed" audit chain on Overview | Every decision is recorded in a tamper-evident log, with PayPal's own verified confirmations alongside. |
| 8 | 2:40 to 2:50 | **Overview**, still, then the URL | Spendward. The AI can be fooled. The mandate can't. Try it yourself at spendward.onrender.com. |

## After recording

1. Join the clips in order; cut waiting time so each scene fits its slot.
2. Add the narration (AI voice) and check the total is under 3:00.
3. Music, if any, must be royalty-free (YouTube Audio Library is safe).
4. Upload to YouTube as **Public** and put the link in the Devpost form.
