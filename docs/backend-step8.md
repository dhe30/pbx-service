# Backend step 8: phone numbers (search, purchase, release)

Owner: Aaron (Track 3 backend). Status: done (2026-11-10), against a fake provider. The client
for the course's DIDWW API v3 clone is written and tested against a mock, **not yet against the
clone itself** (see [VERIFY] below).

## Routes

| Route | Who | Result | Errors |
|---|---|---|---|
| `GET /numbers` | any user | `200 [number]` | |
| `GET /numbers/:id` | any user | `200 number` | 404 |
| `GET /numbers/countries` | owner | `200 [{ iso, name, prefix }]` | 502 |
| `GET /numbers/regions?country` | owner | `200 [{ id, name }]` | 400, 502 |
| `GET /numbers/cities?country&regionId` | owner | `200 [{ id, name }]` | 400, 502 |
| `GET /numbers/available?country&regionId&cityId&areaCode&kind&limit` | owner | `200 [offer]` | 400, 502 |
| `POST /numbers/purchase { availableNumberId }` + `Idempotency-Key` | owner | `201 { number, chargedCents, replayed }` / `202` | 400, 402, 409, 502 |
| `PUT /numbers/:id/route { destination }` (step 5) | owner | `200 number` | 400, 404 |
| `DELETE /numbers/:id` | owner | `200 number` (released) | 404, 502 |

- number = `{ id, did, status, kind, destination, paidUntil, purchasedAt }`. `paidUntil` and
  `purchasedAt` are new.
- offer = `{ id, number, kind, country, region, city, areaCode, priceCents, dueNowCents }`.
  `country` defaults to `US`. `kind` is `local | toll_free`.
- `priceCents` is per 7-day period (`PRICES` in `src/billing/catalog.ts`: local $2.50 since 2026-11-13,
  toll-free $3.50, the ceiling, since 2026-11-11: verify-backlog V-D15). `dueNowCents` is what buying it now would charge: the price prorated to the
  end of the account's current billing period, or 0 below Stripe's $0.50 minimum.

Code: `src/routes/numbers.ts`, `src/numbers/purchase.ts` (the flow), `src/numbers/provider.ts`
(interface), `src/numbers/didww.ts` (DIDWW client), `src/numbers/fake-provider.ts`. Migration:
`db/migrations/20261111000000_number_purchase.sql`. Tests: `test/numbers.test.ts`,
`test/didww.test.ts`.

## Purchase flow

1. **Checks:** a saved card and a paid plan, and the account isn't past due (else 402
   `payment_required`). The number must not already be ours (409 `number_unavailable`).
2. **Order** the offer at the provider and get the DID. If the provider is still processing:
   `202`.
3. **Assign** the DID to our inbound trunk group, so its calls reach our edges.
4. **Charge** the price prorated to period end on the saved card (`payments` row, purpose
   `number`). Declined: the DID is released at the provider again, and the answer is 402
   `payment_failed`.
5. **Insert** `phone_numbers` (`status = assigned`, `kind`, `provider_ref` = DID id,
   `paid_until` = period end, `destination = null`). Kamailio's `kamailio_did_tenant` view and
   the ARI app pick it up right away (NOTIFY trigger).

**Order first, then charge** (billing-flows §8.1, now decided). The gateway has no refunds, so
charging first and then failing the order would keep the customer's money for nothing. The
other way round, a declined card costs us at most DIDWW's setup fee for a number we release
again.

## Idempotency and resuming

The `Idempotency-Key` header is required (1-200 of `A-Za-z0-9_.:-`). It is scoped per account:
the row key in `purchase_requests` is `<tenant_id>:<key>`. Each step stores its result before
the next starts:

| Stored | Means |
|---|---|
| `status = pending`, `did` | the offer was looked up; an order may have been sent |
| `provider_order_id` | the order was accepted (maybe still processing) |
| `status = ordered`, `provider_did_id` | we own the DID |
| `payments` row `number:<key>` | charged (the Stripe Idempotency-Key is the same string) |
| `status = completed`, `phone_number_id` | done |
| `status = failed`, `error_code`, `error_message` | final: `number_unavailable` or `payment_failed` |

So a retry with the same key:
- **after success:** returns the same number with `replayed: true`. Nothing is ordered or
  charged again.
- **after a final failure:** returns the same 409 / 402.
- **after a 502, a timeout or a crash:** continues from the last stored step. If the process
  died between sending the order and storing its id, it asks the provider whether the number is
  already ours (`findOwnedDid`) before ordering again.
- **after 202:** checks the order again.
- **while another attempt with the key is running:** 409 `purchase_in_progress`. `updated_at`
  is a 30 s lease, released at once when an attempt fails in a retryable way.
- **with a different `availableNumberId`:** 409 `idempotency_key_reused`.

A 402 `payment_required` from the checks isn't final: once the card is saved, the same key
works.

Known gap: if the order was accepted but is still *pending* at the provider when the process
crashes before storing its id, the retry finds neither an owned DID nor the offer, and answers
`number_unavailable`. The DID then arrives later, unused. It's rare (the window is one HTTP
response), and it's logged by the provider order, not by us. A reconciliation job against
DIDWW's DID list would catch it.

## Release

`DELETE /numbers/:id` tells the provider to stop renewing the DID first, then sets
`status = released`. `paid_until` is kept, so calls still route until then (contract §4). The
number stays in `GET /numbers` until then, can still be re-routed, and isn't refunded. After
`paid_until` it is 404 and no longer counts as "in use" for deletes (`references.ts`). If the
provider call fails, nothing changes (502, retry). Releasing twice is a no-op.

A lapsed number can be bought again (by anyone): the insert reuses its `phone_numbers` row when
`paid_until` is past.

## Provider

- `DID_PROVIDER_MODE=didww` (default): `HttpDidwwProvider` with `DID_PROVIDER_URL` (the clone's
  `/v3` base URL), `DID_PROVIDER_API_KEY` (Vault) and exactly one of `DID_TRUNK_GROUP_ID`
  (recommended: a trunk group with both edges, CLAUDE.md A7) or `DID_TRUNK_ID`. The API refuses
  to start if they're missing.
- `DID_PROVIDER_MODE=fake`: in-memory fictional `+1 <area> 555-01xx` numbers (201, 973, 212, 516,
  631, toll-free 833) in New Jersey / New York. Local dev and tests only; the state is per
  process.

**Checked against the clone** (read-only probes, 2026-11-11; `test/didww.test.ts` mocks the
observed behaviour):
- filters `available_dids?filter[country.id|region.id|city.id|did_group_type.id|number_contains]`,
  `dids?filter[number|order.id]`, `regions` / `cities` `?filter[country.id]` (+ `[region.id]`)
  are accepted. The `did_group.`-prefixed spellings from DIDWW's docs are rejected (400).
- `available_dids` accepts **only** `include=did_group,did_group.stock_keeping_units`. Asking
  for `did_group.did_group_type` / `.city` / `.region` / `.country` is a 400 (this broke every
  search before the fix). The group carries those as relationship ids, plus `prefix`,
  `area_name` and `is_metered` (true = toll-free); the provider names them from cached
  `did_group_types` / `countries` / `regions` / `cities` lookups.
- `page[size]` is ignored on `available_dids` (up to 100 come back), so the provider re-checks
  type, region, city and area code on the results and applies the limit itself.
- SKU attributes: `setup_price`, `monthly_price` (per 7-day period here), `channels_included_count`.
  Observed: local 0.00 setup / 1.50 per period, toll-free 2.00 / 3.00.
- there's no area code filter, so the client asks for numbers containing
  `<calling code><area code>` and keeps those starting with it.

**Still [VERIFY]** (needs a real purchase; the probes were GET-only):
- `POST /orders` with `did_order_items {sku_id, available_did_id}`; order status
  `Pending | Completed | Canceled`; "taken" answered with 422 / 404 / 409;
- trunk assignment: `PATCH /dids/:id` relationship `voice_in_trunk_group` (or `voice_in_trunk`);
- release: `PATCH /dids/:id {billing_cycles_count: 0}` = stop renewing, works until the 7-day
  period ends. The course spec says a released number works until its paid period ends, "then
  release it at the provider": check whether the clone needs an explicit call at that point.

## Not done here

- **Weekly renewal charges** and releasing lapsed numbers at the provider on our own schedule
  (billing scheduler, billing-flows §4).
- ~~Toll-free incoming cost per number~~: done. It isn't in the clone's API; the Course
  Services tab publishes it (US $0.025/min, UK $0.05/min), kept in
  `TOLL_FREE_IN_COST_PER_MIN` (`numbers/didww.ts`). Other countries: null = `call_pricing` default.
- **Price vs DIDWW cost** (billing-flows §8.7): check the setup and renewal fees once the clone
  is reachable.
- **Reconciliation** of DIDWW's DID list against `phone_numbers` (orphans after rare crashes).

## Tests

- `test/numbers.test.ts`, without a DB: auth and roles, lookups, the required Idempotency-Key,
  502 mapping.
- `test/numbers.test.ts`, with Postgres and the fake provider:
  - search with prices;
  - purchase end to end (trunk, prorated charge, `payments`, `kamailio_did_tenant`, list);
  - replay;
  - a key reused for another number, and per-account key scope;
  - the number taken meanwhile;
  - card / plan / past-due checks, with the key reusable after paying;
  - a declined card (number released, decline replayed);
  - provider down, then the payment service down, then success with one order and one charge;
  - an order whose response was lost (found again, not ordered twice);
  - 202 while pending, then completion;
  - the lease;
  - release (provider call, still routing until `paidUntil`, gone after it).
- `test/didww.test.ts`: the DIDWW client against a mock JSON:API server: headers, filters, the
  `included` parsing (cheapest SKU, kind, region, city), order bodies and statuses, trunk
  assignment, release, and error mapping.
