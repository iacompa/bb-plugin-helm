---
name: helm-payments
description: Payments craft (processor and store billing, checkout, subscriptions, webhooks, entitlements, refunds, taxes, evidence). Use on a Helm project that takes money.
---

# Helm Payments Craft

Excellent payments work means card data never touches our servers, every state change comes from a verified, idempotent webhook or a server-side receipt check rather than from the client, a user's access is read from one entitlements table that is provably in step with the processor, and the whole flow (purchase, renewal, failure, refund, dispute, cancellation) has been exercised end to end in test mode with logs to show it. Nobody spends real money until the human says so. `helm-specialist` covers how you work inside Helm.

The Core builder implements payments. The Security specialist reviews them with this skill and `helm-security` (section 14 is the review list). Product rules (what is sold, prices, trial length, refund policy) come from SPEC and CONTRACT; if they are missing, ask the lead rather than inventing a pricing model.

**Where evidence goes.** `reports/payments/…` below means a `payments/` folder inside your own reports folder, the one in your BRIEF's write scope (`reports/core/payments/` for the Core builder, `reports/ios/payments/` or `reports/and/payments/` for a phone builder doing in-app purchases; Security writes its review in SECURITY.md). Never write outside your scope to follow a path in this skill.

---

## 1. Money stays in test mode until the human decides

- **Only the human can:** create or activate a processor account, provide live API keys, switch to live mode, make a real charge, connect a bank account for payouts, register for taxes, pay store developer fees, sign up for a paid plan, or submit dispute evidence. Each of these goes through `helm_need` (about `credentials` or `spending`), asked once, with the options laid out.
- **Meanwhile, build everything in test mode.** Stripe test keys start with `pk_test_`, `sk_test_` (or restricted `rk_test_`); webhook signing secrets start with `whsec_`. Read them from environment variables, commit only `.env.example` with placeholder names, and fail fast at startup with a clear error if a key is missing or if a live key appears in a non-production environment.
- **Never commit or log any key.** A live secret key (`sk_live_`) in the repo is a Critical finding, even if deleted later (it must be rotated). `helm_slop_scan` flags secrets (S6); run it before every report.
- **If there is no test account yet,** you can still write code, unit tests with recorded fixture events, and signature verification tests using a locally generated secret. Say in your report which parts were verified against the processor and which were not.

---

## 2. Choose the processor and the billing channel

Write the decision and reasons in `reports/payments/decision.md` and send it to the lead for DECISIONS.md.

- **Web apps and websites: Stripe by default.** It has hosted Checkout, Payment Element, Billing for subscriptions, Tax, Radar, a customer portal, a CLI for local webhook testing, and good test tooling. Alternatives are reasonable for a stated reason: a merchant of record such as Paddle when the team wants the provider to handle global sales tax and invoicing as the legal seller; PayPal or Braintree when the market expects them; Adyen at larger scale.
- **Digital goods inside iOS and Android apps must use the store's billing,** under the current rules of each store: Apple In-App Purchase (StoreKit 2) on iOS, iPadOS and macOS App Store builds, and Google Play Billing on Android. Digital goods means content, subscriptions, premium features, virtual currency, and anything consumed in the app. Physical goods and real-world services (a delivered meal, a booked appointment) must not use IAP and use a normal processor instead.
- **Store rules on external payment links and alternative billing vary by region and change often.** Court rulings and regulation (the US, the EU Digital Markets Act, South Korea, Japan and others) have created entitlements for link-outs, alternative processors or reader-app exceptions in some storefronts, each with its own conditions, commission terms and required disclosures. Do not rely on memory or this skill for the current state. Before deciding, read the current App Store Review Guidelines (section 3.1) and the current Google Play Payments policy, note the date and the sections you relied on, and record the decision (which storefronts, which mechanism, why) in `reports/payments/store-rules.md`. If the decision affects revenue or legal exposure, it is the human's call: raise it via the lead.
- **Cross-platform products** (web and mobile sharing an account) need one entitlements model fed by every channel (section 9), so a user who bought on the web is recognised in the app where the store rules allow it, and vice versa.

---

## 3. Keep card data off our servers (PCI scope)

PCI DSS applies to anyone who accepts cards. The integration choice decides how much of it applies to us.

| Integration | What happens | Typical self-assessment |
|---|---|---|
| **Hosted checkout page** (Stripe Checkout redirect or Payment Links) | The customer enters card details on the processor's page. | SAQ A |
| **Processor-hosted fields in an iframe** (Stripe Payment Element / Elements) | Card fields are iframes served by the processor, embedded in our page. | Usually SAQ A; check the processor's current guidance |
| **Our page script builds or posts the payment form** (direct post, custom JS collecting card data) | Our page could be tampered with to skim cards. | SAQ A-EP |
| **Card numbers reach our server or database** | We store, process or transmit card data. | SAQ D (hundreds of requirements) |

- **Use hosted checkout or processor-hosted fields. Never build a form that posts card numbers to our backend,** never store card numbers, and never store CVC under any circumstances. Store only processor IDs (`cus_`, `pm_`, `pi_`, `sub_`) and display data the processor returns (card brand, last four, expiry month and year).
- **PCI DSS v4.x added script-integrity expectations for payment pages,** and SAQ A eligibility includes conditions about the page that redirects to or embeds the payment form. Read the current SAQ A eligibility criteria from the PCI SSC document library and record which SAQ the project expects in `reports/payments/decision.md`. Keep third-party scripts off checkout pages, and serve them over HTTPS with a Content-Security-Policy.
- **Mobile:** use the processor's native SDK sheet (Stripe's mobile Payment Sheet) for physical goods and services; IAP for digital goods. Never collect card numbers in our own native fields.

---

## 4. Products and prices in the CONTRACT

- **Model the catalogue in CONTRACT.md** (send proposed text to the lead): each product, its prices (amount in minor units, currency, interval for recurring, trial length), what entitlement each grants, and the processor's identifiers or lookup keys per environment.
- **Reference prices by stable lookup keys, not hard-coded IDs.** Stripe Prices cannot change their amount after creation; a price change is a new Price with the same lookup key transferred, so code keeps working.
- **Create test-mode products and prices with a committed, idempotent script** (keyed by lookup key) or document the exact Dashboard steps, so another builder can recreate the catalogue. Store products for IAP are created in App Store Connect and Google Play Console, which requires account access (`helm_need`); keep their product IDs in configuration and mirrored in the CONTRACT.
- **Amounts are integer minor units plus an ISO 4217 currency code** everywhere: database, API, events. Not every currency has two decimals (JPY has none; some have three). Use the processor's or the platform's formatter for display (`Intl.NumberFormat`, `NumberFormatter`, StoreKit's `displayPrice`), never string concatenation. Never compute prices in floating point.
- **The server decides the price.** The client sends a product or price key and a quantity; the server looks up the amount. Never accept an amount from the client.

---

## 5. Checkout

- **Create the checkout session on the server** for an authenticated user (or a known guest flow), passing the price lookup, quantity, mode (`payment`, `subscription`, `setup`), success and cancel URLs, and our user ID in `client_reference_id` or `metadata` so the webhook can find the user. Reuse one processor customer per user and store its ID.
- **Use idempotency keys on every create call** (Stripe accepts an `Idempotency-Key` header on POST requests; the SDKs expose it as an option). Derive the key from our own operation ID so a retried request does not create a second charge or session.
- **The success page is not proof of payment.** A user can reach it without paying, close the tab before it loads, or pay with a method that settles later. The success page shows "processing" until the webhook has updated our state, then reads the entitlement from our database.
- **Handle delayed and failed methods:** some payment methods (bank debits, vouchers) succeed or fail days later. Model `pending` explicitly and react to the async success and failure events.
- **Pin the processor API version** in the SDK client and on the webhook endpoint, and upgrade deliberately with tests, so a version change cannot silently reshape objects.

---

## 6. Subscriptions lifecycle

Map every state and transition before writing code, and put the table in the CONTRACT: `trialing`, `active`, `past_due`, `unpaid` or `paused`, `canceled`, `incomplete` and `incomplete_expired` on Stripe; store equivalents for IAP.

- **Trials:** decide whether a payment method is required up front; send a reminder before the trial ends (Stripe emits `customer.subscription.trial_will_end` a few days before); define what happens at the end without a payment method.
- **Plan changes and proration:** decide upgrade (immediate, prorated) and downgrade (at period end) behaviour, preview the proration amount to the user before confirming, and test both.
- **Dunning:** when a renewal fails, the subscription goes `past_due`; use the processor's retry schedule (Stripe Smart Retries) and its failed-payment emails, and decide how long access continues (a grace period) before entitlements are revoked. Make the grace period a configured value, not a magic number.
- **Cancellation:** default to cancel at period end (access continues until `current_period_end`), offer immediate cancellation only if SPEC requires it, and keep cancellation as easy as sign-up (consumer law in several regions requires this). The Stripe customer portal handles plan changes, payment method updates, invoices and cancellation with little code.
- **Grace periods on stores:** Apple and Google both offer billing grace periods and account hold or billing retry states; your entitlement logic must read them from the server notifications (section 8) rather than treating every failed renewal as instant expiry.
- **Test the whole lifecycle with time travel,** not by waiting: Stripe test clocks advance a customer's subscriptions through trials, renewals and failures in minutes; Xcode StoreKit testing and the App Store sandbox use accelerated renewal periods; Google Play license testers get shortened subscription periods.

---

## 7. Webhooks are the source of truth

- **State changes happen in webhook handlers (or server-side receipt checks), never on the client's word.** The client may trigger a refresh; it never grants access.
- **Verify the signature on the raw request body** with the processor's library before parsing or acting (Stripe: `stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret)` in Node, or the equivalent in other SDKs). Frameworks that parse JSON first break verification; read the raw bytes on that route. Reject requests with a missing or bad signature with a 400, and keep the library's timestamp tolerance to block replays.
- **Idempotent handlers keyed by event ID.** Deliveries can repeat. Record each processed event ID in a table with a `UNIQUE` constraint, inside the same transaction as the state change; a duplicate becomes a no-op that still returns 2xx.
- **Out-of-order delivery is normal.** `invoice.paid` may arrive before `checkout.session.completed`; an old `customer.subscription.updated` may arrive after a newer one. Either compare the object's timestamps or version and ignore stale updates, or treat the event as a notification and fetch the current object from the API before updating our state. Fetching the current object is simpler and usually right.
- **Respond fast, work later.** Return 2xx within a few seconds after verifying and recording the event; do slow work (emails, provisioning) in a job queue. A non-2xx response or timeout makes the processor retry with backoff for days in live mode, so failures must be safe to retry.
- **Subscribe only to the events you handle,** and handle at least: checkout completion and async payment success and failure, invoice paid and payment failed, subscription created, updated and deleted, trial ending, charge refunded, and dispute created and closed. Log unhandled event types at info level, by type and ID only.
- **Replay in test mode with the Stripe CLI** (needs a test-mode account login, so `helm_need` for access if none exists):

```bash
stripe login                                         # once, interactive, test mode
stripe listen --forward-to localhost:3000/api/webhooks/stripe   # prints a whsec_ secret for local use
stripe trigger checkout.session.completed            # fire a test event
stripe trigger invoice.payment_failed
stripe events resend evt_XXXXXXXX                     # redeliver a specific event (duplicate test)
```

  Save the `stripe listen` output and your handler logs (IDs and outcomes, no payloads) to `reports/payments/webhooks/`.
- **Also keep offline tests:** recorded fixture events (test mode, scrubbed of personal data) fed to the handler with a locally computed signature, covering valid, invalid signature, duplicate, out-of-order and unknown-type cases. These run in CI without network.

---

## 8. In-app purchases: verify on the server

The app's local receipt or transaction is a hint; the server verifies it with the store before granting anything that matters.

**Apple (StoreKit 2)**
- Purchases return a JWS-signed `Transaction`. Set an `appAccountToken` (a UUID tied to our user) on purchase so the server can link transactions to accounts.
- Send the transaction (or its ID) to our server, which verifies it with the App Store Server API (for example Get Transaction Info and Get All Subscription Statuses) or verifies the JWS signature chain with Apple's App Store Server Library. Never trust a client-supplied "isPremium" flag.
- Configure **App Store Server Notifications V2** to our endpoint; verify each signed payload and handle renewals, expirations, grace periods, billing retry, refunds and revocations (`REFUND`, `REVOKE`) idempotently, keyed by the notification UUID.
- On device, `Transaction.currentEntitlements` and `Transaction.updates` keep the UI responsive and work offline; always finish transactions after delivering content, and offer Restore Purchases.
- Test locally with an Xcode StoreKit configuration file, then with Sandbox testers in App Store Connect (requires account access: `helm_need`).

**Google Play Billing**
- Purchases return a purchase token. Send it to our server, which verifies it with the Google Play Developer API (`purchases.subscriptionsv2.get` for subscriptions, `purchases.products.get` for one-time products) using a service account (a credential: `helm_need`).
- **Acknowledge every purchase** (client or server) promptly; Google refunds purchases that are not acknowledged within three days. Consume consumables after granting them.
- Set `obfuscatedAccountId` to an opaque ID of our user to link purchases and help fraud checks.
- Subscribe to **Real-time Developer Notifications** (through Cloud Pub/Sub) and on each notification fetch the current state from the Developer API, then update entitlements. Handle voided purchases (the Voided Purchases API) to revoke refunded items.
- Test with license testers and an internal testing track.

---

## 9. One entitlements table

Access decisions read one place, whatever the channel.

- **An `entitlements` table** (proposed to the data owner if that is not you): `user_id`, `entitlement` (the feature or plan key from the CONTRACT), `source` (`stripe`, `app_store`, `play`, `manual`), `source_ref` (subscription ID, original transaction ID, purchase token hash), `status` (`active`, `grace`, `expired`, `revoked`), `current_period_end timestamptz`, `last_event_id`, `updated_at`. A `UNIQUE (source, source_ref, entitlement)` constraint prevents duplicates.
- **Writers:** only webhook and notification handlers, server-side verification, and audited admin actions. **Readers:** an `hasEntitlement(user, key, now)` function used by every gated path on the server. Client-side checks are UX only.
- **Processed events table** with `UNIQUE (source, event_id)`, written in the same transaction as the entitlement change.
- **Test entitlement state transitions** as a pure function where possible: given current state and an event, the next state. Cover purchase, renewal, failed renewal into grace then expiry, recovery from grace, upgrade, downgrade, cancel at period end, refund and revoke, dispute, duplicate event, stale event, and two channels for one user. Save the run output to `reports/payments/entitlements-tests.txt`.
- Stripe also offers an Entitlements feature tied to products; if you use it, it still feeds our table, so there is one reader everywhere.

---

## 10. Refunds and disputes

- **Refunds are server-side, authorised actions** (support or admin role, audit-logged) calling the processor's refund API with an idempotency key. The refund webhook, not the button, updates our records and entitlements according to the refund policy in SPEC.
- **Store refunds happen outside our control.** Apple and Google refund users directly; the server notifications above are how we learn about them. Revoke or keep access according to policy, and test both store refund paths.
- **Disputes (chargebacks):** handle the dispute-created event (flag the order, optionally suspend access, alert the team) and the dispute-closed event. Submitting evidence and accepting disputes are human tasks with deadlines; surface them, do not automate submission without explicit approval.
- **Never retry a refund blindly;** check the existing refunds on the charge first.

---

## 11. Taxes, currencies and SCA

- **Do not hand-roll tax calculation.** Rates, thresholds, product taxability and invoice rules vary by jurisdiction and change. Use Stripe Tax (or the processor's equivalent) or a merchant of record. Stores calculate and remit tax for IAP in most regions. Registering for tax collection is a legal step for the human (`helm_need`); until then, enable tax calculation in test mode and show prices according to SPEC (tax-inclusive or exclusive).
- **Currencies:** decide which currencies are sold (SPEC), store the currency on every amount, never convert with our own exchange rates, and let the processor present local currencies if adaptive pricing is wanted. Test a zero-decimal currency.
- **Strong Customer Authentication (3D Secure)** applies to many card payments in the EEA and UK and appears elsewhere. Use the processor's Payment Intents or Checkout flows, which handle `requires_action` and the 3DS challenge. For off-session renewals, save the payment method with the processor's setup flow so later charges are less likely to need the customer; when they do, notify the customer with a link to authenticate. Test with the authentication-required test cards.

---

## 12. Fraud, abuse and privacy

- **Turn on the processor's fraud tooling** (Stripe Radar is on by default for card payments) and review its rules; do not build our own risk scoring.
- **Card testing attacks** abuse checkout endpoints to validate stolen cards. Require authentication or bot protection before creating a session, rate-limit session creation per user, IP and account, and alert on spikes in declines.
- **Never log card data or full payment objects.** Objects carry names, emails, addresses and partial card details. Log IDs (`evt_`, `cs_`, `pi_`, `sub_`, original transaction IDs), event types, amounts and outcomes. Add a test that the logging path redacts. Error trackers must not capture webhook bodies.
- **Receipts and emails:** use the processor's receipts and failed-payment emails where they fit (enable them in the Dashboard; test mode does not send all emails, so check the docs), and send our own transactional emails for entitlement changes (welcome, cancellation confirmed, access ending). Emails never include full card numbers or secrets.
- **Payment data in the privacy inventory:** tell the Security specialist what is stored (customer IDs, last four, billing country) so SECURITY.md and store privacy declarations are accurate.

---

## 13. Testing and reconciliation

- **Test cards** (Stripe test mode): `4242 4242 4242 4242` succeeds; `4000 0025 0000 3155` requires 3D Secure authentication; `4000 0000 0000 9995` is declined for insufficient funds; `4000 0000 0000 0002` is a generic decline; `4000 0000 0000 0259` succeeds and then opens a dispute. Use any future expiry and any CVC. Check the current testing docs for the full list.
- **End-to-end in test mode:** drive a real checkout in a browser (`plugin:browser-automation` can do this headlessly), complete it with a test card, and confirm the webhook arrives, the entitlement row appears, and the gated feature unlocks. Repeat for decline, 3DS, refund and cancellation. Capture screenshots of checkout and the unlocked state into `reports/payments/checkout/`.
- **Subscriptions with test clocks:** create a customer on a test clock, subscribe, advance through trial end, a renewal, a failed renewal and grace expiry, and assert entitlement state at each step.
- **Reconciliation:** a scheduled job (or `plugin:automations` run) compares our records with the processor's for a period: every paid invoice or charge has an order or entitlement, every active entitlement has a live subscription or valid store purchase, refunds match. Mismatches are reported, not silently fixed. Run it in test mode and save the output to `reports/payments/reconciliation.txt`. Payout reconciliation against bank deposits is a finance task for the human.
- **Declare the checks:** ask the lead to add the webhook and entitlement test suites to `.helm/checks.json` and run them with `.helm/run-check.sh tests -- <command>`.

---

## 14. Security review list (for the Security specialist)

File findings per `helm-security` with severity raised one level for payments.

- No card numbers or CVC ever reach our servers, logs or database; the integration matches the SAQ recorded in the decision.
- No secret or live keys in the repo, its history, client bundles or mobile binaries; only publishable keys client-side.
- Webhook routes verify signatures on the raw body, reject unsigned requests, and are idempotent by event ID.
- Amounts and prices are set server-side; no client-supplied amount, discount or entitlement is trusted.
- IAP purchases are verified server-side; store notifications are signature-checked.
- Every gated server path calls the entitlement check; client checks are cosmetic only.
- Checkout creation is authenticated and rate-limited; refunds are role-restricted and audited.
- Payment logs contain IDs only.

---

## Done means

**Decisions and safety**
- [ ] Processor, channel per platform, store-rule reading (with date and guideline sections) and expected SAQ are recorded in `reports/payments/`; sent to the lead.
- [ ] Everything runs in test mode; every live key, real charge, payout, tax registration, store fee or paid plan was requested via `helm_need`, not assumed.
- [ ] No secrets in the repo; startup refuses missing keys and live keys outside production.

**Flows**
- [ ] Card data is entered only on processor-hosted pages or fields.
- [ ] Products and prices are in the CONTRACT with lookup keys; amounts are integer minor units with currency, priced server-side.
- [ ] Checkout uses server-created sessions with idempotency keys; the success page waits for webhook-confirmed state.
- [ ] The subscription lifecycle (trial, proration, dunning, grace, cancellation) is implemented and tested with test clocks or store test environments.

**Source of truth**
- [ ] Webhooks verify signatures, are idempotent by event ID, tolerate out-of-order delivery and retries, and respond quickly.
- [ ] IAP transactions are verified server-side; App Store Server Notifications and Play RTDN update entitlements; Play purchases are acknowledged.
- [ ] One entitlements table is written only by verified sources and read by every gated server path; transition tests pass.

**Money operations**
- [ ] Refunds and disputes update state via webhooks and are audited; store refunds revoke per policy.
- [ ] Tax uses the processor's tax product or a merchant of record; SCA flows pass with the authentication test card.
- [ ] Fraud tooling is on, checkout creation is rate-limited, and logs hold IDs only.
- [ ] A reconciliation run in test mode shows no unexplained mismatches.

## Evidence to commit

- `reports/payments/decision.md`: processor, channels, SAQ expectation, account and key status.
- `reports/payments/store-rules.md`: guideline sections read, date, storefront decisions.
- `reports/payments/webhooks/`: `stripe listen` and trigger logs, duplicate and out-of-order test output, IDs only.
- `reports/payments/checkout/`: test-mode screenshots of checkout, success (after webhook), decline, 3DS and the unlocked feature.
- `reports/payments/entitlements-tests.txt`: entitlement state-transition test run.
- `reports/payments/subscriptions-test-clock.md`: steps and observed states for the test-clock run.
- `reports/payments/reconciliation.txt`: test-mode reconciliation output.
- `reports/checks/` outputs from `.helm/run-check.sh`, cited in `helm_report`.

## Sources

- Stripe docs, Checkout: https://docs.stripe.com/payments/checkout
- Stripe docs, Payment Element: https://docs.stripe.com/payments/payment-element
- Stripe docs, Webhooks (signatures, retries, best practices): https://docs.stripe.com/webhooks
- Stripe docs, Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Stripe docs, Stripe CLI: https://docs.stripe.com/stripe-cli
- Stripe docs, Testing (test cards): https://docs.stripe.com/testing
- Stripe docs, Test clocks: https://docs.stripe.com/billing/testing/test-clocks
- Stripe docs, Subscriptions overview: https://docs.stripe.com/billing/subscriptions/overview
- Stripe docs, Customer portal: https://docs.stripe.com/customer-management
- Stripe docs, Stripe Tax: https://docs.stripe.com/tax
- Stripe docs, Strong Customer Authentication: https://docs.stripe.com/strong-customer-authentication
- Stripe docs, Radar: https://docs.stripe.com/radar
- Stripe docs, Integration security guide (PCI): https://docs.stripe.com/security/guide
- Stripe docs, Disputes: https://docs.stripe.com/disputes
- PCI Security Standards Council, Document Library (PCI DSS, SAQs): https://www.pcisecuritystandards.org/document_library/
- Apple, App Store Review Guidelines (section 3.1 Payments): https://developer.apple.com/app-store/review/guidelines/
- Apple, StoreKit: https://developer.apple.com/documentation/storekit
- Apple, App Store Server API: https://developer.apple.com/documentation/appstoreserverapi
- Apple, App Store Server Notifications: https://developer.apple.com/documentation/appstoreservernotifications
- Apple, App Store Server Library: https://github.com/apple/app-store-server-library-node
- Apple, Testing in-app purchases with StoreKit in Xcode: https://developer.apple.com/documentation/xcode/setting-up-storekit-testing-in-xcode
- Google Play, Payments policy: https://support.google.com/googleplay/android-developer/answer/9858738
- Google Play Billing, Integrate the library: https://developer.android.com/google/play/billing/integrate
- Google Play Billing, Backend integration and acknowledgement: https://developer.android.com/google/play/billing/backend
- Google Play Billing, Real-time developer notifications: https://developer.android.com/google/play/billing/getting-ready#configure-rtdn
- Google Play Developer API, purchases.subscriptionsv2: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
