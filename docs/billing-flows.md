# Purchases, payments and billing (review guide)

What the course spec (Project tab §1, §2, §5, §6) requires for signup, purchases, invoicing and
payment, and how the work splits between the web, the API and Stripe. Use it to review the
frontend/backend work. The telephony side of the contract (CDRs, account status, add-on flags,
pricing tables) is in [telephony-contract.md](telephony-contract.md).

Stripe behaviour below is the real Stripe API, which the course gateway clones ("Customers,
PaymentMethods, SetupIntents, PaymentIntents, idempotent requests; test cards behave as
documented"). Anything the clone may not support is marked [VERIFY].

**One rule to remember:** the browser only ever *collects* a card (Stripe.js). The backend
**creates every charge** with the saved card, and it **checks with Stripe** that a card was really
saved. It never trusts the browser's word.

## 1. Signup: account + saved card + first charge

Spec: "Signup: business name, time zone (fixed after signup; governs billing periods and business
hours), admin email and password, and a card." "Save cards with a SetupIntent." "Card numbers must
never reach your servers."

| Step | Who | What happens |
|---|---|---|
| 1 | Web → API | Business name, time zone (IANA, fixed after signup), admin email + password |
| 2 | **API → Stripe** | `POST /v1/customers`, then `POST /v1/setup_intents` (`customer`, `usage=off_session`). Return the SetupIntent's **`client_secret`**; the OpenAPI description must say so |
| 3 | Web → Stripe | Stripe.js **loaded from the gateway URL** (`<script src="https://stripe.cse356.compas.cs.stonybrook.edu/v3/">`), publishable key, card form, `stripe.confirmCardSetup(client_secret, …)`. Stripe.js handles 3-D Secure test cards |
| 4 | Web → API | "Card saved": the SetupIntent id |
| 5 | **API → Stripe** | `GET /v1/setup_intents/:id`: must be `succeeded`. Store its `payment_method`; make it the customer's default |
| 6 | **API → Stripe** | Charge the **plan, prorated** to the end of the first period: `POST /v1/payment_intents` (`customer`, `payment_method`, `amount` in cents, `currency=usd`, `confirm=true`, `off_session=true`) with an `Idempotency-Key` |
| 7 | API | Account active. The first period starts at local midnight on the signup day (`billingPeriod(tz, signupAt, now)` in `@pbx/shared`) |

## 2. What a customer can buy

Spec §2: a base plan (recurring fee, some extensions and US minutes included) plus:
- phone numbers, local and toll-free: search the provider by country, region or city, and area
  code, then buy and route to our trunk;
- additional extensions;
- international calling (without it, calls outside the US, including other +1 countries, are
  blocked);
- call recording.

**Prices** must be shown **before purchase, on invoices, and in the API**:
- the plan, with its included extensions and US minutes;
- extension, number and add-on prices;
- per-minute rate by destination prefix;
- the incoming toll-free per-minute charge.

**Ceilings** (per billing period; simulated customers' cards **decline anything above them**):

| Item | Ceiling |
|---|---|
| Plan | $11.50 per included extension |
| Extension | $11.50 |
| Local number | $3.25 |
| Toll-free number | $3.50 |
| International calling, recording | $4.60 each |
| US beyond included minutes, incoming toll-free | $0.06 / min |
| Other countries | 6× the international vendor's rate, at least $0.06 / min |

Per-minute prices already live in `call_pricing` (DB CHECKs enforce the ceilings) and
`rate_decks`. Show them with the `@pbx/shared` helpers (`intlRetailPerMin`) so the price shown is
exactly what the call path charges.

**Costs to cover:** DIDWW charges us a setup fee per number, a renewal fee **every 7 days** per
number, and per second on answered incoming toll-free calls (prices in its API). The PSTN vendors
charge per second answered (rate decks). Price items above cost and below the ceilings.

## 3. Buying mid-period

Spec §5: "Items bought mid-period (including the plan at signup) are charged immediately, prorated
linearly to period end."

The same pattern for every item:
1. **Show the price** (and the prorated amount due now).
2. **Charge now:** prorated amount = price × (time left in the period / 7 days), as a server-side
   PaymentIntent on the saved card.
3. **Provision:**
   - number: DIDWW order, then assign the DID to our inbound trunk; insert `phone_numbers`
     (`kind`, `incoming_cost_per_min`, `destination`);
   - extension: `extensions` + `kamailio.subscriber` rows in one transaction
     ([telephony-contract.md](telephony-contract.md) §2);
   - add-on: `tenant_settings.intl_calling` / `record_calls` = true.
4. **Idempotent end to end:** the client's `Idempotency-Key` header → `purchase_requests`; a
   Stripe `Idempotency-Key` per charge; DIDWW retries that can't double-order.

**Removing** an item: it keeps working until its paid period ends and is not renewed. A released
number keeps routing until `paid_until`, then must be released **at DIDWW** too.

**Extension count:** the telephony side does not count extensions. The API must refuse to create
more than the plan includes plus the extensions bought.

## 4. Weekly invoicing (background job)

Spec §5: "Billing period. Seven days from midnight (account time zone) on the signup weekday.
Recurring items are paid in advance ... Within one hour after a period ends, invoice the new
period's recurring charges plus the ended period's usage itemized by call, and charge the card;
retry failures."

Within one hour after each account's period ends:
1. **Recurring lines** for the new period: plan, extensions, numbers and add-ons that weren't
   removed.
2. **Usage lines** for the ended period, **one per call leg** with a charge: `cdrs.charge > 0`
   where `started_at` is in the period. That includes US minutes beyond the included ones,
   international calls, incoming toll-free, and every external leg (forwarded, simultaneous
   ring, transferred).
3. **"Included minutes used"** on the invoice: `usage_periods.included_sec_used / 60` for that
   period.
4. **Charge** off-session with idempotency key = invoice id. On failure: retry with backoff.
5. **Renewals at DIDWW** happen every 7 days on our prepaid balance. Release removed numbers
   whose paid period ended.

Customers see **all invoices** on the web and through the API.

## 5. Past due and recovery

| When | What |
|---|---|
| Invoice unpaid 24 h after period end | `tenants.status = 'past_due'`. Telephony blocks every outgoing external leg within ~30 s (incoming and internal calls keep working). The API reports active/past due |
| Customer adds a new card (new SetupIntent, steps 2–5 of §1) | Charge every overdue invoice **immediately**; on success set `status = 'active'`. Calls must be unblocked **within one minute of payment**: the status change NOTIFYs every pbx node, so the API only has to update the row |

## 6. Money behind the scenes (ops)

- **Customer charges** are deposited in our **Bank** minus 2.9% + $0.30. Charges to cards *we*
  enter ourselves deposit nothing.
- **Vendors are prepaid** from the Bank (Course Services tab → Pay). At $0 the DID provider
  refuses orders and stops delivering calls, and the PSTN vendors answer `402`. Watch the DIDWW
  balance through its API and alert before it runs out. The telephony metric
  `pbx_vendor_leg_failures_total{cause="21"}` rising can mean a vendor is out of funds.
- **Reconciliation** (optional but cheap): the DIDWW CDR export against `cdrs.cost`.

## 7. Responsibilities

### Web (frontend)
Everything must also be possible through the API alone (the graders' tools use the API +
Stripe.js).
- Signup form + Stripe.js card form (gateway URL, publishable key). **No card field ever posts to
  our API.**
- Add / replace card (new SetupIntent).
- Prices before every purchase: plan details, number (local/toll-free), extension, add-ons,
  per-minute rates, incoming toll-free.
- Number search (country, region/city, area code), buy, route, release.
- Add/remove extensions and add-ons.
- Invoice list and detail (line items, included minutes used).
- Account status: past-due banner.

### API (backend)
- **Stripe client (secret key, server only):**
  - Customers; SetupIntents (create, **retrieve to verify**);
  - default PaymentMethod;
  - PaymentIntents (create + confirm off-session, read the status);
  - an `Idempotency-Key` on every POST.
- **Catalog:** item prices and per-minute rates, in the API and the OpenAPI document.
- **Account items** (plan, extensions, numbers, add-ons), each with `started_at` /
  `removed_at` / `paid_through`. These drive proration, renewal and non-renewal.
- **Purchase endpoints:** price → charge → provision, rolled back if a step fails (see §8.1).
- **Billing scheduler:**
  - per-account time zone; invoice within 1 h of period end; retries;
  - past due at +24 h; charge and unblock when a card is added;
  - DIDWW renewal and release.
- **Data:** `invoices`, `invoice_lines` (recurring + per-leg usage from `cdrs`),
  `payment_attempts`.
- **OpenAPI 3.1** at `/openapi.json`, with a description for every operation, parameter and field,
  including where a SetupIntent `client_secret` is returned.

### Telephony (already done)
- It reads `tenants.status`, `tenants.timezone`, `tenant_settings` (`intl_calling`,
  `record_calls`, `included_us_minutes`), `phone_numbers` and `call_pricing` / `rate_decks`.
- It writes a rated `cdrs` row per leg (`cost`, `charge`, `billable_sec` in 30/6, `included_sec`)
  and `usage_periods`.
- Invoices only need to **sum `cdrs.charge`**; they don't need to re-rate calls.

## 8. Decisions still open (check these in review)

1. **Charge first or provision first?** Charging and then failing the DIDWW order leaves money
   taken for nothing, and the clone lists **no Refunds API** [VERIFY]. Options:
   - authorize, then capture after provisioning (`capture_method=manual`), if the clone supports
     it [VERIFY];
   - or order first, then charge, and release the number if the charge is declined.
2. **Account state until the card is confirmed:** "pending" until §1 steps 5–6 succeed? What
   happens if the first prorated charge is declined?
3. **Rounding:** Stripe takes integer cents; `cdrs.charge` has 6 decimals. Sum the period's usage,
   **then** round once (never round each call up), or invoices can cross a ceiling ("overcharges"
   make customers leave).
4. **Webhooks:** not in the clone's feature list [VERIFY]. Read results from the PaymentIntent
   response (and retrieve again when unsure) instead of waiting for events.
5. **Off-session charges that need authentication** come back `requires_action`. Treat that as a
   failure (retry, then past due) and ask the customer for a new card.
6. **The plan's contents:** how many extensions and US minutes it includes. This sets
   `tenant_settings.included_us_minutes`, which the call path uses for every US call.
7. **Price vs cost:** check the DIDWW setup and 7-day renewal prices (in its API) against our
   number price. A number priced under its weekly cost loses money every period.
