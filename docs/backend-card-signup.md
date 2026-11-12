# Backend: card at signup, first plan charge, extension limit

Owner: Aaron (Track 3 backend). Status: done 2026-11-09, on `feature/backend-course-spec`.
Implements the API side of [billing-flows.md](billing-flows.md) §1 (card + first charge),
part of §2 (price list) and §3 (extension limit). Weekly invoices, past-due recovery and buying
items (numbers, extra extensions, add-ons) are **not** built yet.

## Flow

```
POST /auth/signup {email, password}
  -> 201 {userId, tenantId: null, role: "unassigned"} + login cookies
POST /businesses {name, timezone}
  -> 201 {userId, tenantId, role: "owner", cardSetup: {setupIntentId, clientSecret, publishableKey, stripeJsUrl}}
     (API: Stripe customer + SetupIntent usage=off_session)
Browser: <script src="{stripeJsUrl}">, Stripe(publishableKey).confirmCardSetup(clientSecret, {payment_method: {card}})
POST /billing/card {setupIntentId}
  -> API retrieves the SetupIntent from Stripe: must be succeeded AND belong to this account's customer
  -> default payment method; brand/last4 stored for display
  -> plan never paid: PaymentIntent (off_session, confirm) for the plan prorated to period end
  -> 200 billing state | 402 payment_failed (card saved, plan unpaid; start again with another card)
```

The browser only collects the card. The API creates every charge and checks the SetupIntent with
Stripe itself. It never takes the browser's word for it.

## Endpoints

| Request | Who | Success | Errors |
|---|---|---|---|
| `GET /billing/prices` | public | `200` plan, item prices (cents per 7 days), per-minute prices from `call_pricing` | |
| `GET /billing` | owner | `200 { card, planPaidThrough, currentPeriod, extensions: { used, allowed } }` | |
| `POST /businesses { name, timezone }` | unassigned user | `201 { userId, tenantId, role: "owner", cardSetup }` | 400, 403, 409 |
| `POST /billing/setup-intent` | owner | `201 { setupIntentId, clientSecret, publishableKey, stripeJsUrl }` | 502 |
| `POST /billing/card { setupIntentId }` | owner | `200` billing state | 400 `invalid_request` / `card_not_saved`, 402 `payment_failed`, 502 |
| `POST /extensions` (changed) | owner | `201` | **402 `payment_required`** (plan not paid), **409 `extension_limit`** |

- `cardSetup` in the business-creation response is `null` if the gateway failed; the business
  still exists. Call `POST /billing/setup-intent`.
- `502 payment_gateway_error`: the gateway was unreachable or rejected the request. Retrying is
  safe: every Stripe POST has an `Idempotency-Key`.
- Replacing the card works the same way (`setup-intent` then `card`); a paid plan isn't charged again.

## Files

| File | Purpose |
|---|---|
| `db/migrations/20261110000000_billing_card.sql` | `billing_accounts` (Stripe customer, default card, `plan_paid_through`), `payments` (every charge attempt), `tenant_settings.included_extensions` / `extra_extensions` |
| `services/api/src/billing/stripe.ts` | `StripeClient` interface + `HttpStripeClient` (fetch, form-encoded, no SDK) |
| `services/api/src/billing/account.ts` | `startCardSetup()`, `saveCard()`, first-period charge |
| `services/api/src/billing/catalog.ts` | Plan and prices, ceilings, `proratedCents()` |
| `services/api/src/routes/billing.ts` | The four billing routes |
| `services/api/src/routes/auth.ts` | Account-only signup, login and session lifecycle |
| `services/api/src/routes/businesses.ts` | Creates tenant/settings, assigns the owner and returns `cardSetup` |
| `services/api/src/routes/extensions.ts` | `assertCanAddExtension()` |
| `services/api/test/billing.test.ts` | 8 tests (fake gateway: `FakeStripe` in `test/helpers.ts`) |

## Config (Ansible / Vault)

| Variable | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | yes | Vault. Server only. |
| `STRIPE_PUBLISHABLE_KEY` | yes | Given to browsers. |
| `STRIPE_API_URL` | no | Default `https://stripe.cse356.compas.cs.stonybrook.edu` (Course Services tab; verify-backlog V-S1) |
| `STRIPE_JS_URL` | no | Default `https://stripe.cse356.compas.cs.stonybrook.edu/v3/` (from the spec) |

## Decisions taken (review these; billing-flows §8)

1. **Plan and prices** (§8.6, §8.7), in `catalog.ts`:
   - plan "Business": $19.00 per 7 days, 2 extensions, 100 US minutes;
   - extra extension $9.00; local number $2.75; toll-free $3.50 (raised from $3.00 on 2026-11-11:
     the provider charges 2.00 setup + 3.00 per period, verify-backlog V-D15);
   - international calling $3.90; recording $3.90.

   All are under the ceilings (a test checks). The number prices still need checking against
   DIDWW's setup and 7-day renewal fees.
2. **Account state until the card is confirmed** (§8.2): the account exists and can log in and
   configure routing, but **can't add extensions** (402 `payment_required`) until the first plan
   charge succeeds. No new account status: `tenants.status` stays `active` / `past_due`, so
   telephony is unchanged.
3. **A declined first charge** leaves the card saved and the plan unpaid (402). The customer adds
   another card. The idempotency key is per period **and** card: a retry with the same card
   replays Stripe's result, while a new card gets a new attempt (Stripe would replay a cached
   decline for the same key).
4. **`requires_action`** on the off-session charge counts as a failure (§8.5).
5. **Rounding**: the prorated amount is rounded to the nearest cent and is never more than the
   full price. Below Stripe's $0.50 minimum it is waived (possible only minutes before a period
   ends).
6. **Webhooks**: none (§8.4). Results come from the API responses.
7. **Charge vs. provision order** (§8.1): not relevant yet (the plan has nothing to provision).
   It matters for number purchases.

## Not built yet

- Buying extra extensions (sets `tenant_settings.extra_extensions`), numbers and add-ons.
- Weekly invoices, retries, past due at +24 h, charging overdue invoices when a new card is saved
  (billing-flows §4-§5). `saveCard()` currently only pays the first period.
- Invoices in the API and the web.

## Verification

- 90 API tests pass against PGlite (`node dev/pglite-server.mjs`, which applies every
  migration):
  - full signup → card → charge → limit flow;
  - retry without a second charge;
  - card replacement without a charge;
  - decline then a new card;
  - unconfirmed, foreign and unknown SetupIntents;
  - gateway down at signup and on `setup-intent` (502);
  - the public price list;
  - prices under the ceilings;
  - proration.
- **Not run against the real course gateway.** The URL and the exact parameters it accepts are
  [VERIFY]. First check: `POST /v1/customers`, `/v1/setup_intents`, a test card through
  `confirmCardSetup`, then `POST /v1/payment_intents` with `off_session=true&confirm=true`.
