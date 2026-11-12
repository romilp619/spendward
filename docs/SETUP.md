# Setting up Spendward, step by step

Just want to see it working? Use the live site,
**[spendward.onrender.com](https://spendward.onrender.com)**. Nothing to install
and no keys needed.

This guide is for running your own copy. It takes about 15 minutes. Every
screenshot of Spendward below comes from a fresh clone of this repository,
set up by following these exact steps.

**You will need**

- Node 20 or later (`node --version` to check)
- A free [PayPal Developer](https://developer.paypal.com) account
- An API key for any OpenAI-compatible model that supports tool calling
  (OpenAI, Azure OpenAI, OpenRouter and others all work)
- Optional: a [Channel3](https://trychannel3.com/developers) API key, for live
  shopping at real retailers

---

## Part 1: PayPal

Everything here is in the PayPal **sandbox**: test accounts and test money.

### 1.1 Sign in to the developer dashboard

Go to [developer.paypal.com](https://developer.paypal.com) and log in with any
PayPal account. Make sure the **Sandbox** / **Live** switch at the top says
**Sandbox**.

### 1.2 Find your sandbox accounts

Open **Testing Tools → Sandbox Accounts**. PayPal creates two for you:

| Account | Type | What Spendward uses it for |
| --- | --- | --- |
| `…@business.example.com` | Business | The shop that gets paid |
| `…@personal.example.com` | Personal | The buyer: you log in with it to pay or to connect the wallet |

![PayPal's Sandbox test accounts page: business accounts (the shops) and a personal account (the buyer)](setup/paypal-accounts.png)

Click the **personal** account, then **View/Edit account**, and note its email
and password. You will need them in step 4.2.

> Want each shop to have its own PayPal account, so you can see the money for
> Best Buy and for Macy's go to different places? Click **Create account**,
> choose **Business**, and repeat once per shop. Each has an **Account ID**
> (13 characters, for example `N44HAL6FEZTZN`). You will put these in
> `merchants.json` in step 3.3. Optional: by default every shop pays your one
> business account.

### 1.3 Create an app

Open **Apps & Credentials** (Sandbox) and click **Create App**:

- **App name:** anything, for example `spendward`
- **Type:** Merchant
- Click **Create App**

### 1.4 Turn on Save payment methods (PayPal Vault)

On your new app's page, under **Features**, tick **Save payment methods** and
save. This is what lets the agent pay from a saved PayPal wallet with no
checkout page.

> If you tick it on an app that already existed and connecting the wallet later
> says the app is not allowed, create a **new** app with the box ticked from the
> start. PayPal can take hours to apply a feature change to an existing app,
> but a new app gets it at once.

### 1.5 Copy the credentials

Back in **Apps & Credentials**, copy your app's **Client ID** and **Secret**
with the copy buttons. They go in `.env` in step 3.1. Keep both private.

![PayPal's REST API apps list: the app with its Client ID and hidden Secret, each with a copy button](setup/paypal-app.png)

---

## Part 2: Get the code

```bash
git clone https://github.com/romilp619/spendward.git
cd spendward
npm install
```

```
added 100 packages in 1s
```

---

## Part 3: Configure

### 3.1 Fill in `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Value |
| --- | --- |
| `PAYPAL_CLIENT_ID` | Client ID from step 1.5 |
| `PAYPAL_CLIENT_SECRET` | Secret from step 1.5 |
| `LLM_BASE_URL` | Your model provider's OpenAI-compatible URL, for example `https://api.openai.com/v1` |
| `LLM_API_KEY` | Your model provider's key |
| `LLM_MODEL` | A model with tool calling, for example `gpt-4.1-mini` |
| `CHANNEL3_API_KEY` | Optional, for live shopping |

Leave `PUBLIC_URL=http://localhost:3000` as it is for now.

### 3.2 Run setup once

```bash
npm run setup
```

You should see:

```
generated an Ed25519 mandate key pair
generated an audit chain key
wrote merchants.json: every demo shop pays your sandbox business account VJBAWYGFKXP7Q
  for separate shops, create one sandbox business account each and put their IDs here
signed mnd_demo_001
signed mnd_live_001
active mandate: mnd_demo_001

setup done. Next: npm run web, then npm run demo
```

The account ID on the third line is your own sandbox business account's.
Setup has:

- made your **mandate signing key**, which only you hold, and the key that
  protects the audit log, and added both to `.env`
- found your sandbox business account and written `merchants.json`, which says
  which PayPal account each demo shop pays
- signed two demo mandates and made one active

Setup is safe to run again: it never replaces a key or a `merchants.json` you
already have.

### 3.3 Optional: one PayPal account per shop

If you made extra business accounts in step 1.2, open `merchants.json` and put
each shop's Account ID in its `payee`, then sign the demo mandates again:

```json
{
  "TechStore":   { "name": "TechStore (sandbox shop A)",  "payee": "N44HAL6FEZTZN" },
  "AudioWorld":  { "name": "AudioWorld (sandbox shop B)", "payee": "VJBAWYGFKXP7Q" },
  "bestbuy.com": { "name": "Best Buy (sandbox shop A)",   "payee": "N44HAL6FEZTZN" },
  "macys.com":   { "name": "Macy's (sandbox shop B)",     "payee": "VJBAWYGFKXP7Q" }
}
```

```bash
npm run mint
```

---

## Part 4: Run it

### 4.1 Start the dashboard

```bash
npm run web
```

```
Spendward dashboard on http://localhost:3000
```

Open **http://localhost:3000**. A fresh install starts empty, with the demo
mandate in force: USD 250 per payment, USD 1000 a month, at TechStore.

![A fresh install: Overview with no requests yet, the demo mandate in force and an intact audit chain](setup/01-first-open.png)

### 4.2 Connect the PayPal wallet

Open **Mandates**. Both demo mandates are signed, and the wallet says
**Not connected**.

![The Mandates page after setup: the active demo mandate, a second one ready to switch to, and the Connect PayPal wallet button](setup/02-mandates.png)

Click **Connect PayPal wallet**. PayPal's sandbox page opens: log in with the
**personal** sandbox account from step 1.2 and agree. PayPal sends you back
to the dashboard, and the wallet card turns green: **Connected**.

From now on, a payment the mandate allows is paid at once from that wallet,
with no checkout page. You can skip this step: payments then wait for you at
PayPal checkout instead (see 4.4).

### 4.3 Run a scenario

Open **Try it**. Each card is a real task for a real AI agent: everyday
purchases in the first row, attacks in the second. Click one and watch.

![The Try it page: everyday purchases and prompt-injection attacks, each a real task for the agent](setup/03-try-it.png)

The transcript shows every tool call the agent makes and Spendward's answer.
For **A normal purchase**, the order reaches PayPal, payable to the account
Spendward chose, not the agent:

![The transcript of a normal purchase: the agent's create_order call, and Spendward's answer that the order was created at PayPal, payable to the shop's sandbox account](setup/04-order-created.png)

### 4.4 Pay, or approve

**Without a wallet connected**, an allowed order waits in **Overview → Needs
you**. Click **Open PayPal checkout**, pay with the personal sandbox account,
then come back and click **Capture payment**. With webhooks set up (Part 5),
capture happens on its own.

![Needs you: an allowed order waiting for the buyer, with Open PayPal checkout and Capture payment](setup/05-needs-you-checkout.png)

**A little over the limit** is held for you instead. The card says exactly
which PayPal account would be paid. **Approve once** places and pays it;
**Reject** drops it.

![Needs you: a USD 289 order held because it is USD 39 over the per-payment limit, showing the PayPal account it would pay, with Approve once and Reject](setup/06-approval.png)

### 4.5 See the record

**Activity** lists every decision, searchable and exportable as CSV, beside
PayPal's own verified confirmations. **Insights** turns the same record into
charts, and **Ask Spendward** answers questions about it.

![Activity: the two decisions from this walkthrough, one allowed and one held for approval](setup/07-activity.png)

**Reset demo**, top right of **Try it**, clears the record whenever you want to
start over. It keeps your keys, mandates and wallet.

---

## Part 5: Webhooks (optional)

PayPal can confirm each payment independently. Spendward verifies every
confirmation's signature with PayPal and shows it in **Activity**, and it
captures an approved checkout automatically.

PayPal needs a public address to send these to.

**Locally**, start a tunnel in a second terminal and leave it running:

```bash
npm run tunnel
```

It prints a public `https://….trycloudflare.com` address and writes it to
`PUBLIC_URL` in `.env`.

The first time, add the webhook in **Apps & Credentials → your app → Webhooks
→ Add Webhook**:

- **Webhook URL:** the tunnel address followed by `/paypal/webhook`
- **Events:** All Events

Copy the **Webhook ID** into `.env` as `PAYPAL_WEBHOOK_ID` and restart
`npm run web`. A tunnel's address changes every time it starts; from then on,
`npm run tunnel` points the webhook at the new address for you.

---

## Part 6: Deploy on Render (optional)

`render.yaml` describes the whole service. In short:

```bash
npm run render:env        # writes render.env, the settings to paste into Render
```

1. In Render: **New → Blueprint**, pick your fork of this repository.
2. When it asks for settings, choose **Add from .env** and paste `render.env`.
3. After the first deploy, point the webhook from Part 5 at it:

```bash
npm run webhook -- https://your-service.onrender.com
```

This updates the webhook in `PAYPAL_WEBHOOK_ID`, so create the webhook in
Part 5 first.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `could not reach PayPal to find your sandbox business account` | Check the Client ID and Secret in `.env`, and that they are **Sandbox** credentials. |
| Connecting the wallet says the app is not allowed | Save payment methods is not on yet: see step 1.4. A new app with the box ticked works at once. |
| **Model busy, retrying** in the transcript | Your model provider is rate-limiting. Spendward retries on its own. |
| Every purchase is refused with `MERCHANT_NOT_ALLOWED` | The catalogue in **Try it** does not match the active mandate. Demo shop uses `mnd_demo_001`; live shopping uses `mnd_live_001`. Switch in **Mandates**. |
| Every purchase is refused with `MANDATE_REVOKED` | The active mandate was revoked. Make another one active in **Mandates**, or use **Reset demo**. |
