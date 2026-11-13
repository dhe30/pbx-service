# Backend API: what the rest of the team needs to know

From: Aaron (Track 3 backend). Updated 2026-11-12 (billing completed, API deployable).
Details: `docs/backend-step1.md` to `docs/backend-step8.md`, `docs/backend-card-signup.md`. Code:
`services/api/`. **Machine-readable reference: `GET /openapi.json`** (see "For everyone").

<<<<<<< Updated upstream
**What changed on 2026-11-11 (support tickets, course spec §3):**
- New: `POST /tickets`, `GET /tickets`, `GET /tickets/:id`, `POST /tickets/:id/close` (any
  logged-in user of the account), and the provider view `GET /operator/tickets`,
  `GET /operator/tickets/:id` (operator bearer token, not a login). Details: "Support tickets"
  in the Justin section and "Provider (operator) access" below it.
- New migration `20261115000000_support_tickets.sql` (run `npm run db:migrate`).
- New config `OPERATOR_TOKEN` (Vault `vault_operator_token`, at least 32 characters; the `api`
  role refuses to run without it). Locally optional: unset = operator routes refuse everyone.
- New metrics `pbx_api_support_tickets_opened_total`, `pbx_api_support_tickets_closed_total`.
=======
**Account lifecycle (2026-11-15):** signup now creates an unattached login; authenticated users
create a business separately, and owners can attach existing unassigned users as staff.
`GET /me` returns `tenant: null` until the user belongs to a business. See
[backend-step2.md](backend-step2.md).
>>>>>>> Stashed changes

**What changed on 2026-11-12:**
- New: `GET /billing/rates`, `GET /billing/rates/lookup` (per-minute price by prefix / number),
  `GET/POST/DELETE /billing/items` (buy and cancel additional extensions, international calling,
  call recording), `GET /invoices`, `GET /invoices/:id`.
- The billing scheduler runs in every API process: weekly invoices, retries, past due, recovery
  when a card is added (`POST /billing/card` with a replacement card now charges unpaid invoices;
  `402 payment_failed` if that fails). Config: `BILLING_SCHEDULER`, `BILLING_TICK_SEC`.
- A released number can be re-routed until `paidUntil`, and stops blocking deletes after it.
- `DELETE /extensions/:id` is `409 in_use` for a ring group's only member.
- Migrations `20261112000000_account_items.sql`, `20261113000000_invoices.sql`,
  `20261114000000_purchase_incoming_cost.sql` (run `npm run db:migrate`).
- Deployment: Ansible role `api`, `services/api/Dockerfile`; the edge HAProxy checks `/ready`.

**What changed on 2026-11-09 (historical):**
- `GET /me` was added with business, time zone, and `status`.
- New: `/business-hours`, `/blocked-numbers`, `/billing`, `/billing/prices`, `/billing/card`,
  `/billing/setup-intent`.
- `POST /extensions` answers 402 until the plan is paid and 409 `extension_limit` past the plan.
- `DELETE /staff/:id` no longer answers 409 `in_use` (staff logins are not routing targets).
- Phase-1 IVR targets `{action: "user"}` are a 400 now.
- New required config: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`. New migration:
  `db/migrations/20261110000000_billing_card.sql` (run `npm run db:migrate`).
- `npm run db:kamailio` now also adds the `tenant_id` / `extension_id` columns to
  `kamailio.subscriber`. **Re-run it on an existing dev database**, otherwise extension routes and
  the API tests fail with `column "tenant_id" does not exist`.
- **Step 6 (media):** `POST /media` (greeting upload), `GET /media`, `GET /media/:id`,
  `GET /media/:id/audio`, `DELETE /media/:id`. Audio is served by the API, not via presigned
  URLs. Local dev now needs Garage (`npm run dev:s3`) and ffmpeg.
- **Step 8 (numbers):** `GET /numbers`, `GET /numbers/:id`, number search
  (`/numbers/countries`, `/regions`, `/cities`, `/available`), `POST /numbers/purchase`
  (`Idempotency-Key` header), `DELETE /numbers/:id` (release). Number objects gained `paidUntil`
  and `purchasedAt`. **New config:** `DID_PROVIDER_MODE` (`fake` for local dev; add it to your
  `.env`, or the API refuses to start), and for the real provider `DID_PROVIDER_API_KEY` +
  `DID_TRUNK_GROUP_ID` (or `DID_TRUNK_ID`). New migration `20261111000000_number_purchase.sql`.
- **Step 7 (history, voicemail, settings):** `GET /calls` (search, keyset paging),
  `GET /calls/:callId`, `GET /calls/:callId/recording`; `GET /voicemails`, `GET/PATCH/DELETE
  /voicemails/:id`, `GET /voicemails/:id/audio`; `GET /settings` (read-only). Staff see only their
  own extensions' calls and their mailboxes. Deleting a mailbox now also deletes its voicemail audio.

## Status

| Step | What | State |
|---|---|---|
| 1 | Server skeleton: config, logging, `/health`, `/ready`, `/metrics`, error format, graceful shutdown | Done |
| 2 | Auth: account-only signup, login, refresh, logout, `GET /me`; separate business creation | Done |
| 3 | Tenant isolation: scoped queries, 404 for other tenants' ids, reference checks | Done |
| 4 | Staff logins + SIP credentials; extensions (each with a Kamailio `subscriber` row) | Done |
| 5 | IVR menus, ring groups, mailboxes, number routing, business hours, caller blocklist | Done |
| — | Course spec: time zone, `GET /me`, business hours, blocklist, `/openapi.json`, card + first plan charge, extension limit | Done (2026-11-09) |
| 6 | Greeting upload (ffmpeg → 8 kHz WAV), media list / audio download / delete | Done |
| 7 | Call history search + recordings, voicemail inbox, settings (read-only) | Done |
| 8 | Number search, purchase (idempotent, prorated charge), list, release | Done (DIDWW clone details [VERIFY]) |
| — | Support tickets (spec §3): account side + provider view of all accounts' open tickets | Done (2026-11-11) |
| 9 | Review fixes (2026-11-12): rates by prefix, additional extensions + add-ons, weekly invoices / past due / recovery, deployment role, toll-free cost, voicemail audio cleanup | Done |

## For everyone

**Error format.** Every error response, on every route, has this shape:

```json
{ "error": "<machine-readable code>", "message": "<human-readable text>" }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Bad body or malformed id; `message` names each bad field (`email: Invalid email; password: ...`) |
| 400 | `invalid_reference` | The body points at an id that doesn't exist or belongs to another business; `message` names the field (`memberIds.1: no such extension`) |
| 400 | `invalid_audio` | Upload isn't a supported audio file, is empty, or is longer than 300 s (`POST /media`) |
| 400 | `card_not_saved` | Card setup not confirmed with Stripe.js yet (`POST /billing/card`) |
| 401 | `unauthorized` / `invalid_credentials` | Not logged in, session expired / wrong email or password (on `/operator/*`: missing or wrong operator token) |
| 402 | `payment_required`, `payment_failed` | Plan not paid yet (or account past due) / a card charge was declined |
| 403 | `forbidden` | Logged in, but wrong role (e.g. staff on an owner-only route) |
| 404 | `not_found` | Doesn't exist, **or belongs to another business** (deliberately indistinguishable) |
| 409 | `email_taken`, `in_use`, `number_taken`, `extension_limit` | Conflict with existing data (`in_use`: can't delete, still used by call routing; `message` names what uses it) |
| 409 | `number_unavailable`, `idempotency_key_reused`, `purchase_in_progress` | Number purchase: the number was taken / the key was used for another number / the same key is still running |
| 416 | `range_not_satisfiable` | `Range` header outside the file (`GET /media/:id/audio`) |
| 4xx | Fastify's code, e.g. `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415) | Errors raised by Fastify itself: body wasn't JSON (only `application/json` is accepted, except audio uploads to `POST /media`), body too large, malformed JSON. Same shape, but `error` is Fastify's code, not one of ours |
| 500 | `internal_error` | A bug; details are only in the server log |
| 502 | `payment_gateway_error` | The payment service failed. Safe to retry (billing calls are idempotent) |
| 502 | `did_provider_error` | The phone number provider failed. Safe to retry (a purchase with the same `Idempotency-Key` continues where it stopped) |
| 503 | `unavailable` | Database failing over or object store unreachable; comes with `Retry-After: 2`. Retry, it's not a bug |

**API reference: `GET /openapi.json`** (OpenAPI 3.1, required by the course spec). It lists
every route with its body, parameters, responses and error codes, and a description for every
field. Open it in any OpenAPI viewer (e.g. paste into editor.swagger.io) instead of relying on the
tables below when in doubt. How routes document themselves: `services/api/src/openapi/document.ts`
(each route passes `withDoc(opts, {...})`; `test/openapi.test.ts` fails if a route, parameter or
field has no description).

**Running the API locally:**

```sh
cp .env.example .env          # add SHUTDOWN_DRAIN_MS=0 for fast restarts
npm run dev:up                # Postgres + Garage (Docker Desktop with WSL integration)
npm run db:migrate
npm run db:kamailio           # Kamailio tables + our subscriber columns; safe to re-run
npm run dev:s3                # Garage layout, bucket and the dev key from .env.example; safe to re-run
npm run dev -w @pbx/api       # http://127.0.0.1:3000
```

Greeting uploads also need **ffmpeg** on the PATH (`sudo apt install ffmpeg`), or set
`FFMPEG_PATH`. `/ready` should answer 200 with `db` and `objectStore` ok. The API won't start without the Stripe keys in `.env`; the
`.env.example` placeholders are enough for local work (the gateway is only called on signup and
billing).

**Tests with Docker:** after the setup above (`dev:up`, `db:migrate`, `db:kamailio`), run
`npm test -w @pbx/api`. The test files run in parallel against the dev Postgres.

**Tests without Docker** (in-process Postgres with every migration applied):

```sh
npm run db:test-server &       # node dev/pglite-server.mjs, listens on 127.0.0.1:55432
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test -w @pbx/api -- --no-file-parallelism
```

With PGlite, run the API tests sequentially (`--no-file-parallelism`): it serves one connection at
a time. Without a database the DB tests are skipped, not failed.

**Schema changes.** The API, the ARI app and Kamailio all read the same tables. Please send
migrations (`db/migrations/`, dbmate) through one reviewed PR at a time and tell the other
owners.

**After pulling changes to `services/shared`, rebuild it:** `npm run build -w @pbx/shared`. The
API and ARI app use its compiled `dist/` (gitignored). A stale build makes shared types silently
resolve to `unknown` (this happened once already, see `docs/backend-step3.md`).

**Tenant isolation (step 3).** Every API query is scoped to the logged-in user's business, the
business comes only from the login token (never from the URL or body), and every id a request
stores is checked to belong to the same business. Rules and helpers: `docs/backend-step3.md`.

---

## Justin (frontend)

### Auth endpoints (available now)

| Request | Success response |
|---|---|
| `POST /auth/signup` `{ "email", "password" }` | `201 { "userId", "tenantId": null, "role": "unassigned" }` + cookies |
| `POST /businesses` `{ "name", "timezone" }` | `201 { "userId", "tenantId", "role": "owner", "cardSetup" }` + refreshed cookies |
| `POST /auth/login` `{ "email", "password" }` | `200 { "userId", "tenantId", "role" }` + cookies |
| `POST /auth/refresh` (no body) | `200 { "userId", "tenantId", "role" }` + new cookies |
| `POST /auth/logout` (no body) | `204` + cookies cleared |
| `GET /me` | `200 { "user": { "id", "email", "role", "createdAt" }, "tenant": object \| null }` |

Validation rules (show them in the forms):
- `name`: 1-100 characters; `timezone`: an IANA name, e.g. `America/New_York` (offer a picker;
  default to `Intl.DateTimeFormat().resolvedOptions().timeZone`). Fixed after business creation
  because it sets billing periods and business hours; returned in canonical spelling.
- `email`: valid email, case-insensitive (stored lowercased).
- `password`: 8-128 characters at signup; the web form also confirms it before sending.

An unassigned account has `role: "unassigned"` and `tenantId: null`. `/me` returns a null tenant.
Business-scoped routes return `403 business_required` until it creates or joins a business.
`POST /businesses` creates the tenant/settings and assigns the current user as owner; it returns
the card SetupIntent. The browser then saves the card with Stripe.js and `POST /billing/card`.

Error codes: wrong email and wrong password return the same `401 invalid_credentials` (on
purpose). A taken email at signup returns `409 email_taken`.

### Card and billing (spec §1, §2)

The account signup is separate from business creation; card fields go to Stripe.js only, **never**
to our API.
1. `POST /auth/signup` creates a user with no business; `POST /businesses` creates the business.
   The business response's `cardSetup` = `{ setupIntentId, clientSecret, publishableKey,
   stripeJsUrl }` (`null` if the gateway failed: call `POST /billing/setup-intent`).
2. Load Stripe.js from `stripeJsUrl`, `Stripe(publishableKey)`, card element,
   `stripe.confirmCardSetup(clientSecret, { payment_method: { card } })` (handles 3-D Secure).
3. `POST /billing/card { setupIntentId }` → `200` billing state; the plan is charged now,
   prorated. `402 payment_failed` = card declined: restart from `POST /billing/setup-intent`.

Other routes: `GET /billing/prices` (public; show the plan price on the signup page),
`GET /billing/rates?region=intl&prefix=&destination=&limit=&cursor=` (public; per-minute price by
destination prefix, exactly what calls are charged), `GET /billing/rates/lookup?number=` (public;
price of calling one number, e.g. next to the dial pad or the forwarding field),
`GET /billing` (card, `planPaidThrough`, extension usage). Until the plan is paid,
`POST /extensions` answers `402 payment_required`; past the plan's limit it answers
`409 extension_limit`. Details and the decisions taken: [backend-card-signup.md](backend-card-signup.md).

### How sessions work

- Two **httpOnly** cookies, set by the server:
  - `pbx_access`: 15 min, sent on every request.
  - `pbx_refresh`: 7 days, sent only to `/auth/*`.
- JavaScript can't read them; don't try to store tokens yourself. `fetch` sends them
  automatically on same-origin requests.
- **The web app must be same-origin with the API** (cookies are `SameSite=Lax`).
  - Production: HAProxy serves both on one domain.
  - Local dev: configure the Vite dev server to proxy API paths (`/auth`, and later `/numbers`,
    `/staff`, ...) to `http://127.0.0.1:3000`, instead of calling port 3000 directly.
- **Refresh on 401.** When any request returns 401, call `POST /auth/refresh` once, then retry the
  original request. If refresh also returns 401, send the user to the login page. Make concurrent
  401s share one refresh call.
- **503 with `Retry-After`** means a database failover (10-30 s). Retry after the given seconds
  instead of showing an error right away.
- **Bodies must be JSON**: send `Content-Type: application/json`. Form posts get 415.

> **Changed 2026-11-09 (course-spec port, PR from `phase1/telephony`):** SIP accounts moved from
> staff users to **extensions**. Destinations (IVR options, number routing, ring group no-answer)
> use `{ "type", "id" }` instead of `{ action, target }`. Ring group members are extensions. Why:
> [spec-transition.md](spec-transition.md). Full contract: [telephony-contract.md](telephony-contract.md).

### Staff endpoints (logins only)

| Request | Who | Success response |
|---|---|---|
| `POST /staff` `{ "email", "password"? }` | owner | `201 { "id", "email", "role": "staff", "createdAt" }` |
| `GET /staff` | owner | `200 [ { same fields }, ... ]`, oldest first |
| `DELETE /staff/:id` | owner | `204` (an extension assigned to them stays, unassigned) |
| `GET /me/sip-credentials[?extensionId=]` | any user | `200 { "wsUri", "sipUri", "username", "password", "extensionId", "extensionNumber" }` |

- To attach an existing unassigned account, send only its email. To create a new staff account,
  include its first dashboard password (same rules as signup); the staff member logs in normally
  with `/auth/login`.
- Errors: `409 email_taken` on create; `404` if already deleted.
- **Softphone** (spec §4: "a logged-in user calls and answers as one of the account's
  extensions", `data-testid="softphone-extension"`):
  1. list `GET /extensions`;
  2. fetch `/me/sip-credentials?extensionId=<chosen>` (without it: the extension assigned to
     this user, `extensions.userId`, else 404);
  3. pass the fields to SIP.js (`wsUri` = WebSocket server, `sipUri` = AOR, `username`/`password`
     = digest auth).

  Keep the password in memory only. Owners can use the softphone too.

### Extension endpoints (spec §3)

| Request | Who | Success response |
|---|---|---|
| `GET /extensions`, `GET /extensions/:id` | any user | extension(s), by number; `sipPassword` only for owners |
| `POST /extensions` | owner | `201 extension` (creates its SIP account and, unless `mailboxId` is given or `null`, a mailbox) |
| `PUT /extensions/:id` | owner | `200 extension` (full replace; omitted `mailboxId` = keep) |
| `DELETE /extensions/:id` | owner | `204`; `409 in_use` while something routes to it or it is a ring group's only member |

extension = `{ id, number, name, sipUsername, sipPassword, mailboxId, ringTimeoutSec, forwardAlways,
forwardBusy, forwardNoAnswer, externalNumbers, callerIdNumber, userId }`.
- `number`: 1–8 digits, unique in the account (`409 number_taken`).
- `forward*`: `null`, `{ "type": "extension", "id" }` or `{ "type": "external", "number": "+E.164" }`.
- `externalNumbers`: E.164 list, rung together with the extension's phones.
- `callerIdNumber`: must be one of the account's numbers.
- **Desk phones** register with `sipUsername` / `sipPassword` at the group domain (SRV records).

### Call configuration endpoints (available now, step 5)

Owner-only. Full field rules, defaults and an example: `docs/backend-step5.md`.

| Resource | Routes | Object |
|---|---|---|
| Mailboxes | `GET/POST /mailboxes`, `GET/PUT/DELETE /mailboxes/:id` | `{ id, name, greetingMediaId, ownerUserId }` |
| Ring groups | `GET/POST /ring-groups`, `GET/PUT/DELETE /ring-groups/:id` | `{ id, name, strategy, ringTimeoutSec, noAnswerDestination, memberIds }` |
| IVR menus | `GET/POST /ivr-menus`, `GET/PUT/DELETE /ivr-menus/:id` | `{ id, name, greetingMediaId, timeoutSec, maxRetries, config }` |
| Number routing | `PUT /numbers/:id/route` `{ destination }` | `{ id, did, status, kind, destination, paidUntil, purchasedAt }` |
| Business hours | `GET/POST /business-hours`, `GET/PUT/DELETE /business-hours/:id` | `{ id, name, schedule, openDestination, closedDestination, openNow }` |
| Blocklist | `GET/POST /blocked-numbers`, `DELETE /blocked-numbers/:number` | `{ number, createdAt }` |
| Media (step 6) | `POST /media` (file upload), `GET /media?kind=`, `GET/DELETE /media/:id`, `GET /media/:id/audio` | `{ id, kind, format, durationMs, callId, createdAt, audioUrl }` |

- **`PUT` replaces the whole object**: omitted fields reset to defaults. Edit forms should send
  everything they got from `GET`.
- **Destination** (number routing, IVR digits, ring group no-answer) is one of:
  - `{ "type": "extension" | "ring_group" | "ivr_menu" | "voicemail" | "business_hours", "id" }`
  - `{ "type": "external", "number": "+E.164" }`
  - `{ "type": "hangup" }`

  Formats and semantics: [telephony-contract.md](telephony-contract.md) §3.
- `memberIds` are **extension** ids; their order is the ring order (matters for
  `strategy: "sequential"`). Offer `GET /extensions` in that picker.
- `config` uses the ARI app's keys as-is:
  `{ options: { "1": Destination }, timeout, invalid, repeat_digit }` (snake_case `repeat_digit`).
  The phase-1 shape (`{ action, target }`, `on_timeout`) is still accepted on input.
- `PUT /numbers/:id/route` still accepts the phase-1 body `{ ivrMenuId }`. Phase-1
  `{ action: "user" }` IVR targets are refused (400): pick an extension instead.
- Business hours `schedule` = `{ intervals: [{ day: 0-6 (0 = Sunday), start: "09:00", end:
  "17:00" }] }` in the account's time zone (`GET /me` → `tenant.timezone`). `openNow` is a
  read-only preview to show next to the schedule.
- Blocklist: send `number` in any format (`(201) 555-0100`, `+44...`); it comes back as E.164.
  Blocking returns `201`; blocking an already blocked number is fine and returns `200`. Encode `+` as `%2B` in the DELETE URL.
- `409 in_use` on delete: show `message` (e.g. `Used by IVR menu "Main"; change that first`).
- **Greetings (step 6, details in `docs/backend-step6.md`):** upload the file as the body of
  `POST /media` (`Content-Type: audio/*`) or as `FormData` field `file`; WAV, MP3, Ogg/Opus,
  M4A, WebM (`MediaRecorder` output) and more, up to 20 MB / 300 s. Use the returned `id` as
  `greetingMediaId`. Play any media with `<audio src={audioUrl}>` (same origin, the cookie is
  sent). Media can't be edited: upload a new greeting and switch the menu or mailbox to it.
  `400 invalid_audio`: show `message`. `409 in_use` on delete: a menu or mailbox still plays it.

### Call history, voicemail, settings (available now, step 7)

Any logged-in user. The owner sees everything; **staff see only calls where one of their
extensions (`extensions.userId`) took part, and voicemails in mailboxes they own or their
extensions' mailboxes**. Details: `docs/backend-step7.md`.

| Request | Response |
|---|---|
| `GET /calls?from&to&direction&outcome&extension&number&limit&cursor` | `{ items: [leg], nextCursor }`, newest first |
| `GET /calls/:callId` | `{ callId, legs: [leg], recordingUrl }` (main leg first) |
| `GET /calls/:callId/recording` | the WAV (`<audio src={recordingUrl}>`) |
| `GET /voicemails?mailboxId&heard&limit&cursor` | `{ items: [voicemail], nextCursor }`, newest first |
| `GET /voicemails/:id`, `PATCH /voicemails/:id { heard }` | `voicemail` |
| `DELETE /voicemails/:id` | `204` (message + audio) |
| `GET /voicemails/:id/audio` | the WAV (`<audio src={audioUrl}>`) |
| `GET /settings` | `{ recordCalls, intlCalling, includedUsMinutes, includedExtensions, extraExtensions }` |

- **One row per leg**, not per call: an incoming call that also rang an external number has a
  second leg with the same `callId` and `parentId` set. Group by `callId` if the page shows calls.
- leg = `{ id, callId, parentId, direction, fromNumber, toNumber, did, fromExtension, toExtension,
  startedAt, answeredAt, endedAt, billableSec, outcome, voicemail, vendor, charge, includedSec,
  recordingUrl }`. `charge` is USD. Our cost isn't exposed.
- `number` matches digits anywhere in the from/to/our number; formatting is ignored, so
  `(201) 555` works. `from` is inclusive, `to` exclusive (ISO 8601).
- **Paging:** pass `nextCursor` back as `cursor`; `null` means the last page. Don't build cursors
  yourself.
- voicemail = `{ id, mailboxId, mailboxName, callerNumber, callId, heard, durationMs, createdAt,
  audioUrl }`. `heard: false` = new, `true` = saved; the phone menu (`*98`) sees the same state.
  Playing doesn't mark it heard: send the `PATCH`.
- **Settings are read-only.** Recording and international calling are paid add-ons
  (billing-flows §2-§3), bought and cancelled through `/billing/items` (below).

### Phone numbers (available now, step 8)

Details: `docs/backend-step8.md`.

| Request | Who | Response |
|---|---|---|
| `GET /numbers` | any user | `[number]`: active numbers, plus released ones until `paidUntil` |
| `GET /numbers/:id` | any user | `number` |
| `GET /numbers/countries` | owner | `[{ iso, name, prefix }]` |
| `GET /numbers/regions?country=US` | owner | `[{ id, name }]` |
| `GET /numbers/cities?country=US&regionId=` | owner | `[{ id, name }]` |
| `GET /numbers/available?country&regionId&cityId&areaCode&kind&limit` | owner | `[{ id, number, kind, country, region, city, areaCode, priceCents, dueNowCents }]` |
| `POST /numbers/purchase { availableNumberId }` + header `Idempotency-Key` | owner | `201 { number, chargedCents, replayed }`, or `202` (repeat the request) |
| `DELETE /numbers/:id` | owner | `200 number` with `status: "released"` |

- **Show `priceCents` (per week) and `dueNowCents` (charged now, prorated) before the buy
  button.** That is the "price before purchase" the spec asks for.
- **Idempotency-Key:** make a new UUID when the user clicks Buy, and reuse it for every retry of
  that click (timeouts, `502`, `202`). The same key never orders or charges twice; a new key is a
  new purchase. After `402 payment_failed` (declined), the number was not kept: the user picks
  a card and clicks again, which is a new key.
- `202 { status: "processing" }`: the provider is still working; wait `Retry-After` seconds and
  repeat the same request.
- After buying, route it with `PUT /numbers/:id/route`. Until then calls to it are hung up.
- Release: the number keeps working until `paidUntil`; nothing is refunded. It can still be
  re-routed until then (`PUT /numbers/:id/route`); after `paidUntil` it is gone (404) and no longer
  blocks deleting what it routed to.

### Additional extensions and add-ons

| Request | Who | Response |
|---|---|---|
| `GET /billing/items` | owner | `[item]`: plan, additional extensions, numbers, add-ons (incl. cancelled ones until `paidThrough`) |
| `POST /billing/items { kind }` + header `Idempotency-Key` | owner | `201 { item, chargedCents, replayed }` |
| `DELETE /billing/items/:id` | owner | `200 item` with `renews: false` |

item = `{ id, kind, priceCents, startedAt, paidThrough, removedAt, renews, phoneNumberId, did }`,
`kind` = `plan | extension | number | intl_calling | recording`.
- `kind` to buy: `extension` (one more extension slot), `intl_calling`, `recording`. Charged now,
  prorated (show `GET /billing/prices` first); Idempotency-Key works like number purchases.
- `409 already_active`: the add-on already renews. Buying a cancelled add-on that is still paid
  for renews it again for free (`chargedCents: 0`).
- Cancel: an add-on keeps working until `paidThrough`. An extension slot stops counting at once,
  so cancelling it is `409 extension_limit` while the extensions in use need it.
- Numbers are released with `DELETE /numbers/:id`; the plan can't be cancelled (400).

### Invoices and past due

| Request | Who | Response |
|---|---|---|
| `GET /invoices` | owner | `[invoice]`, newest first |
| `GET /invoices/:id` | owner | `invoice` + `lines` |

invoice = `{ id, periodStart, periodEnd, usageFrom, usageTo, recurringCents, usageCents, totalCents,
includedMinutesUsed, status, pastDue, attempts, lastError, nextAttemptAt, paidAt, createdAt }`;
line = `{ kind: recurring|usage, description, itemKind, callId, startedAt, billableSec, amount }`.
- The billing scheduler (in every API process, `src/billing/scheduler.ts`) issues an invoice
  within about a minute after each 7-day period ends: the new period's items (plan, additional
  extensions, numbers, add-ons) plus the ended period's call usage, one line per charged leg.
  It charges the card at once and retries declines (5 min, 15 min, 1 h, 3 h, then every 6 h).
- `status: failed` + `pastDue: true` (unpaid 24 h after the period ended): `GET /me` shows
  `tenant.status: "past_due"` and outgoing calls are blocked. Show a banner with "add a card".
  Adding a card (`POST /billing/setup-intent` -> Stripe.js -> `POST /billing/card`) charges every
  unpaid invoice immediately and reactivates the account; `402 payment_failed` = that charge was
  declined too (the card stays saved).

### Support tickets (spec §3)

| Request | Who | Response |
|---|---|---|
| `POST /tickets` `{ subject, description }` | any user | `201 ticket` |
| `GET /tickets?status=open\|closed&limit&cursor` | any user | `{ items: [ticket], nextCursor }`, newest first |
| `GET /tickets/summary` | any user | `{ open, closed }`, account-wide counts independent of list filters and pagination |
| `GET /tickets/:id` | any user | `ticket`; 404 |
| `POST /tickets/:id/close` | any user | `200 ticket` (closed); 404. Idempotent |

ticket = `{ id, subject, description, status: open|closed, createdAt, createdBy, createdByEmail,
closedAt, closedBy }`. `createdBy` / `closedBy` are user ids (null once that user is deleted);
`closedAt` / `closedBy` are null while open.
- Every user of the account (owner and staff) sees and can close every ticket of the account.
- `subject` 1-200 characters, `description` 1-10000 (both trimmed); other fields are a 400.
- Tickets only go open -> closed. Closing a closed ticket returns it unchanged; a problem that
  comes back gets a new ticket. There is no delete.
- Paging is the same as `/calls` and `/voicemails` (`limit` 1-200, default 50; pass `nextCursor`
  back as `cursor`).
- **Graded behaviour:** simulated customers open a ticket when something fails for them and close
  it when it works again. Put "Open a ticket" somewhere easy to find (a page listing the account's
  tickets with status, a form with subject + description, a Close button per open ticket).

### Provider (operator) access

The provider (us) must see the open tickets of **all** accounts as they come in. That is not a
customer feature, so it doesn't use the login cookie:

| Request | Who | Response |
|---|---|---|
| `GET /operator/tickets?status=open\|closed\|all&limit&cursor` | operator token | `{ items: [operatorTicket], nextCursor }`, newest first; `status` defaults to `open` |
| `GET /operator/tickets/:id` | operator token | `operatorTicket`; 404 |

operatorTicket = ticket + `{ tenantId, tenantName }`. Authenticate with
`Authorization: Bearer <OPERATOR_TOKEN>`; anything else (no header, wrong token, a customer
cookie, token not configured) is `401 unauthorized`. Quick look from an app node:

```sh
curl -s -H "Authorization: Bearer $OPERATOR_TOKEN" http://<app private IP>:3000/operator/tickets | jq
```

Why a separate token and not an "operator" user role: every user and every login token belongs to
exactly one account, and all account routes trust that account id (step 3 rules). An operator
user would have to live inside some customer account, with a cross-account power inside a
customer-style token. A separate secret keeps the provider outside accounts entirely: a bug in an
account route can't leak other accounts' tickets, and a customer cookie never opens an operator
route. It also needs no schema change, signup path or UI to manage operators; rotate it by
changing the vault value and redeploying role `api`. If the team later wants a provider
dashboard page, it can send this header (keep the token out of the customer bundle: paste it into
the page, keep it in `sessionStorage`).

### Errors to handle on upcoming forms (from step 3)

- `404 not_found` on a detail page: show "not found"; the id may simply belong to another
  business.
- `400 invalid_reference` on save: `message` starts with the field path (`config.options.2.id`,
  `memberIds.1`), so you can highlight the field. Usually means a picked item was deleted
  meanwhile; reload the options.

---

## Daniel (telephony: extensions / staff-to-staff calls)

- **Resolved 2026-11-09 (course-spec port):**
  - **Extensions:** the `extensions` table, with a number unique per account (digits, 1–8) that
    owners pick. The API routes are `routes/extensions.ts`.
  - **SIP accounts:** `kamailio.subscriber` rows belong to extensions. The username is generated
    (`x` + 16 hex chars). The row carries `tenant_id` + `extension_id`, which Kamailio uses to keep
    an account's calls on one pbx node.
  - **Registrations:** live in Kamailio memory (no `kamailio.location` rows to delete any more).
  - **Staff:** `POST /staff` creates a login only.
  - Contract: [telephony-contract.md](telephony-contract.md).
- `extensions.sip_username` is **globally** unique (Kamailio looks phones up by username only,
  `use_domain=0`), so a generated username can't be just the extension number.
- The API doesn't write `cdrs` (replaces `calls`), `usage_periods` or recordings; it only reads
  them (call history, invoices). Voicemails: the API marks them heard/deleted, the ARI app inserts.
- **Tenant isolation is enforced in the API, not the database** (step 3). The foreign keys only
  check that a row exists, not that it's the same tenant's, and `ivr_menus.config` has none. The
  API checks before writing, but code that writes these tables directly (ARI app, seeds, your
  extension work) must keep references within one tenant. If you add a table, give it a
  `tenant_id` column.
- New shared types: `Db` and `TransactionSql` in `services/shared/src/db.ts`, for helpers that
  should run on the pool or inside a transaction.
- **Bug fix in `services/shared` that affects the ARI app** (step 5): `createDb` used
  `postgres.camel`, which also renamed keys inside JSON columns, so `ivr_menus.config.on_timeout`
  came back as `onTimeout` and `parseIvrConfig` dropped it. Callers who pressed nothing were hung
  up instead of reaching `on_timeout`. Only column names are converted now; no ARI app code
  changed. Rebuild shared (`npm run build -w @pbx/shared`) and please recheck the on_timeout path
  on the phase-1 VM. Details: `docs/backend-step5.md`.
- **The API refuses to delete what call routing still depends on** (409 `in_use`): a mailbox, ring
  group, IVR menu, business hours schedule or extension that a Destination points at (IVR digits,
  number routing, ring group no-answer, forwarding, extension mailboxes), and an extension that
  is the only member of a ring group. Numbers released and past their paid period don't count.
- **Voicemails deleted with `*98` key 3:** the ARI app keeps deleting only the `voicemails` row
  (S13); the API's background ticker deletes the leftover `media` row and its object after an
  hour (`src/maintenance.ts`). Seeds or scripts that
  delete these rows directly should keep the same rule. Staff logins are not routing targets, so
  deleting one no longer checks anything.

---

## Muhammad (database HA + observability)

### Database

- The API connects with `DATABASE_URL` to the **local HAProxy at `127.0.0.1:5432`**, as in
  CLAUDE.md §4.3 #7. No multi-host connection strings.
- It survives failovers on its own: it starts and listens while the DB is down, reconnects
  automatically, retries transient errors (connection errors, `57P01`-`57P03`, `25006`
  read-only), and returns 503 to clients meanwhile. Tested against the dev Postgres
  (stop / start / pause).
- Pool: `DB_POOL_MAX` (default 10) connections per API process, shown as `api@<hostname>` in
  `pg_stat_activity`. Size `max_connections` for 2 app nodes + ARI apps + Kamailio.
- Migrations: dbmate (`npm run db:migrate`, `db/migrations/`). We need to decide who runs them
  during a deploy (once, before the new API version starts).

### Object store

- Needs: bucket `S3_BUCKET` (default `pbx-media`), an access key with read/write on it, and
  path-style S3 URLs (`forcePathStyle`). `/ready` uses `HeadBucket`.
- Please add the same store (Garage) to `dev/docker-compose.yml` or tell me the settings, so
  local dev matches production.

### Health checks (for HAProxy and alerts)

| Endpoint | Use for |
|---|---|
| `GET /health` | Process alive. Never checks dependencies. Use for systemd/docker restarts. |
| `GET /ready` | DB + object store reachable, not shutting down. Use for HAProxy routing and alerts. Answers within ~1.5 s even if a dependency hangs. Body names the failing check. |

- **The edge HAProxy routes on `/ready`** (decided 2026-11-12, `edge_haproxy` role: `inter 2s fall 2
  rise 2`, `retries 2` + `redispatch`). Reason: `/ready` turns 503 on SIGTERM, so rolling deploys
  drain without failed requests; with `/health` they didn't. Cost: a cluster-wide DB (or object
  store) outage marks every app replica down and HAProxy answers 503 itself; clients retry 503s
  either way.
- **Graceful shutdown:** on SIGTERM, `/ready` returns 503 for `SHUTDOWN_DRAIN_MS` (default 5 s)
  before the server closes. Keep this above HAProxy's check interval x fall count, so HAProxy
  stops routing before connections close.

### Metrics and logs

- `GET /metrics` (Prometheus) on the API port (default 3000, private IP only):
  - `pbx_api_http_request_duration_seconds{method,route,status}`: latency per route template,
    usable for error-rate alerts (`status=~"5.."`);
  - `pbx_api_support_tickets_opened_total`, `pbx_api_support_tickets_closed_total`: support
    tickets opened / closed by customers (per process; `sum` over app nodes). Customers open one
    when something fails for them, so `increase(...opened_total[5m]) > 0` is a useful Discord
    alert ("a customer is unhappy"); details via `GET /operator/tickets`.
  - standard Node process metrics (CPU, memory, event loop lag, GC).
- Logs: pino **JSON to stdout** (journald / docker), field `svc: "api"`. Your log retention
  settings cover the API; it writes no log files itself.
  - Cookies, `Authorization` and `Set-Cookie` are redacted.
  - `/health`, `/ready` and `/metrics` don't log every request; failed readiness checks log at
    `warn` with the failing check.
  - Each request has a `reqId`; if HAProxy sets `X-Request-Id`, that value is used.

### Deployment (role `api`)

- `site.yml` runs role `api` on the `app` hosts, `serial: 1`: Node 24 + ffmpeg from apt, the repo
  synced to `/opt/pbx/src`, `npm ci` + build of `@pbx/shared` and `@pbx/api`, systemd unit
  `pbx-api` (user `pbx-api`), env file `/etc/pbx/api.env`. It waits for `/ready` before moving to
  the next app node.
- **Migrations** run once per deploy in the `db_schema` role (dbmate against the current Patroni
  primary), which `site.yml` runs before any app node is updated. Migrations must stay backward
  compatible with the running API (split-contracts §5).
- To fill in before the first deploy: `did_provider_url` and `did_trunk_group_id` (or
  `did_trunk_id`) in `group_vars/all/main.yml`; `vault_jwt_secret`, `vault_did_api_key`,
  `vault_stripe_secret_key`, `vault_stripe_publishable_key`, `vault_operator_token` in `vault.yml`.
  The role refuses to run without them. `web_domain` defaults to `sip_domain`.
- A container image is also available: `docker build -f services/api/Dockerfile -t pbx-api .` from
  the repo root (Node 24 + ffmpeg).

### Config and secrets (for Ansible / Vault)

- Required: `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `JWT_SECRET`, `DID_PROVIDER_URL`, `DID_PROVIDER_API_KEY` (Vault),
  `DID_TRUNK_GROUP_ID` or `DID_TRUNK_ID` (the DIDWW inbound trunk group / trunk bought numbers
  are pointed at), `SIP_WS_URI`, `SIP_DOMAIN`, `STRIPE_SECRET_KEY` (Vault),
  `STRIPE_PUBLISHABLE_KEY`. Production also sets `OPERATOR_TOKEN` (Vault, at least 32
  characters; provider access to every account's support tickets; unset = those routes refuse
  everyone). Optional: `DID_PROVIDER_MODE` (`didww` default; `fake` only for dev), `STRIPE_API_URL`,
  `STRIPE_JS_URL` (defaults: the course gateway), `FFMPEG_PATH` (default `ffmpeg`; app nodes need ffmpeg installed), `S3_REGION` (default `garage`; must match
  Garage's `s3_region`), `COOKIE_SECURE` (default `true`; keep it in production),
  `ACCESS_TOKEN_TTL_SEC` (900) / `REFRESH_TOKEN_TTL_SEC` (7 days), `HOST`, `PORT` (3000),
  `LOG_LEVEL` (info), `DB_POOL_MAX` (10), `SHUTDOWN_DRAIN_MS` (5000), `SHUTDOWN_TIMEOUT_MS`
  (10000). The process refuses to start, listing the missing ones, if any are absent.
- **`JWT_SECRET` must be identical on every app node** (otherwise logins break when HAProxy
  switches replicas) and at least 16 characters; keep it in Vault.
- Production: set `HOST` to the app node's private IP (default `127.0.0.1`).
- Capacity: each login or signup hashes with argon2id (19 MiB memory, ~25 ms CPU; OWASP minimum
  parameters, chosen 2026-11-12 for latency). Up to 4 run at once per process (libuv thread
  pool), so budget roughly 80 MiB of extra memory per app node at peak. Measured on a 16-vCPU dev
  machine with `loadtest/api/argon2-bench.mjs`: ~160 hashes/s per process, p95 0.2 s at 32
  concurrent (the old 64 MiB default: ~28/s, p95 1.1 s). Re-measure on an app VM.

---

## Decisions taken in the 2026-11-12 review fixes

Taken while implementing the backend review (branch `feature/backend-review-fixes`). Each is
local to the code it names; change it there. **Review** marks the ones the team should confirm
before merging.

| # | Decision | Why | Where |
|---|---|---|---|
| R1 | A released number counts as "in use" (blocks deleting its target) only while it still routes calls (`paid_until > now`), and can be re-routed until then | Otherwise its target could never be deleted, and the number was invisible and un-routable after `paidUntil` | `references.ts`, `routes/numbers.ts` |
| R2 | `/billing/rates` and `/billing/rates/lookup` are **public** and compute prices with the ARI app's rules (US flat price; else intl vendor rate x multiplier, at least the minimum; no deck row = the minimum) | Spec: prices shown before purchase and in the API; one rule set so shown = charged | `billing/rates.ts` |
| R3 | **Review:** one table `account_items` for every recurring item (plan, extension slot, number, intl_calling, recording) with `price_cents` locked at purchase, `paid_through`, `removed_at` | billing-flows §7; one renewal loop for everything; existing plans/numbers backfilled at the catalog prices of the migration | migration `20261112000000_account_items.sql` |
| R4 | **Review:** `tenant_settings.intl_calling` / `record_calls` / `extra_extensions` are **derived** from the items on every purchase, cancellation and lapse. The call path keeps reading `tenant_settings` | No telephony change. Side effect: flags set by hand on an account that has items of that kind are overwritten (accounts without items are left alone) | `billing/items.ts` `syncSettings()` |
| R5 | **Review:** add-on and extension purchases reuse the number purchase's idempotency (`purchase_requests`, kind `item`) and hold a row lock on the account's `tenant_settings` **while the card is charged** | Two purchases of the same add-on with different keys can't both charge. Cost: one DB connection held for up to the gateway timeout (10 s) per purchase | `billing/items.ts`, `billing/purchase-requests.ts` |
| R6 | Buying an add-on that already renews is `409 already_active`; buying one that was cancelled but is still paid for renews it again for free | No double charge for the same period | `billing/items.ts` |
| R7 | **Review:** a cancelled extension slot lowers the limit **at once** (`extra_extensions` counts renewing slots), so cancelling is `409 extension_limit` while the extensions in use need it | Otherwise an owner could cancel and still create an extension in the slot, leaving more extensions than paid for at period end | `billing/items.ts` `cancelItem()` |
| R8 | Past-due accounts can't buy add-ons or extensions (402), like numbers | Same rule as number purchases | `billing/purchase-requests.ts` `assertCanBuy()` |
| R9 | **Review:** the billing scheduler runs in **every** API process (tick `BILLING_TICK_SEC`, 60 s); each unit of work is claimed with `FOR UPDATE SKIP LOCKED`; no leader | Survives losing any app node without failover logic | `billing/scheduler.ts` |
| R10 | The account's **plan item** drives its periods: when it is paid only up to now, the next period is invoiced. Accounts that never paid the plan get no invoices. Missed periods are caught up one per pass | The plan is the one item every paying account has | `billing/scheduler.ts` |
| R11 | Invoice = new period's recurring items (each renewed to the new period end; numbers' `paid_until` and `plan_paid_through` follow) + one usage line per leg with `charge > 0` in the ended period | Spec §5 ("itemized by call") | `billing/scheduler.ts` |
| R12 | Usage is summed per invoice, **then rounded once** to the nearest cent | billing-flows §8.3: never round each call up | `billing/scheduler.ts` |
| R13 | An invoice below Stripe's 50-cent minimum is marked paid without a charge (same as prorated amounts) | The gateway rejects smaller charges | `billing/scheduler.ts` |
| R14 | Each charge attempt has its own Idempotency-Key `invoice:<id>:<attempt>`; retries after 5 min, 15 min, 1 h, 3 h, then every 6 h; a gateway outage counts as a failed attempt | A new attempt (later or with a new card) must really retry; Stripe replays a reused key's decline | `billing/scheduler.ts` |
| R15 | Past due = an invoice still unpaid 24 h after its period ended. A paid invoice sets the account `active` once nothing else is unpaid. A replacement card (`POST /billing/card`) charges every unpaid invoice at once; `402 payment_failed` if declined (the card stays saved) | billing-flows §5; unblocking goes through `tenants` -> NOTIFY, well inside one minute | `billing/scheduler.ts`, `billing/account.ts` |
| R16 | Cancelled add-ons are switched off by the scheduler once their period ends; only accounts that ever had items of that kind are touched | Keeps hand-set flags (seeds, tests) on accounts without items | `billing/scheduler.ts` `expireLapsedAddons()` |
| R17 | The scheduler makes **no DIDWW calls**: DIDWW renews kept numbers from our prepaid balance and stops renewing released ones (`billing_cycles_count = 0` at release) | Fewer moving parts; [VERIFY] the clone behaves that way | `billing/scheduler.ts` |
| R18 | **Review:** the edge HAProxy routes on `/ready` (`inter 2s fall 2 rise 2`, `retries 2` + `redispatch`); the API drains 6 s on SIGTERM | Rolling deploys without failed requests. Cost: a cluster-wide DB or object-store outage marks every app node down. The `edge_haproxy` role belongs to T2 | `edge_haproxy` template, role `api` |
| R19 | The API runs under systemd (role `api`, user `pbx-api`), built on the host like the ARI app; the Dockerfile is an alternative, not what Ansible deploys. Migrations stay in `db_schema` (dbmate on the current primary, before app nodes update) | Same deployment pattern as the other Node service | role `api`, `services/api/Dockerfile` |
| R20 | **Revised 2026-11-11:** the toll-free incoming cost comes from the rates the Course Services tab publishes (US $0.025/min, UK $0.05/min), not from the API. Other countries: `null` = `call_pricing` default | Probed the clone: no DID group, SKU or offer has a per-minute field, and the tab says only setup and weekly prices are in the API. Update the table if the tab changes | `numbers/didww.ts` `TOLL_FREE_IN_COST_PER_MIN` |
| R21 | Voicemail audio whose message was deleted by phone (`*98`) is deleted by the scheduler after a 1 h grace | S13 left it behind; the ARI app writes media + voicemail together, the grace is extra safety | `maintenance.ts` |
| R22 | Deleting an extension that is a ring group's **only** member is `409 in_use`; memberships in groups with other members still cascade | A group with no members rings nobody | `routes/extensions.ts` |
| R23 | **Review:** dashboard passwords use argon2id with OWASP's minimum parameters (19 MiB, t=2, p=1) instead of the library default (64 MiB, t=3, p=4) | Measured ~160 vs ~28 hashes/s per process, p95 0.2 s vs 1.1 s at 32 concurrent (16-vCPU dev box). A weaker hash for latency under graded load; old hashes still verify | `passwords.ts`, `loadtest/api/argon2-bench.mjs` |

---

## Outstanding backend items

Everything backend-related that is still missing or undecided. Remove items as they're done.

### Decisions needed from others

- **Justin:** whether the response shapes (all in `GET /openapi.json`) suit each dashboard page,
  including the new billing pages (items, invoices, rates).
- **Daniel:** confirm on the phase-1 VM that an IVR `on_timeout` action now runs (fixed in
  `services/shared` in step 5; see the Daniel section above).
- **Muhammad:** the production Garage key and bucket must match what the dev setup assumes:
  bucket `pbx-media`, `s3_region = "garage"`, path-style S3 API, a key with read/write on the
  bucket (`dev/garage-setup.sh` shows the commands).
- **Muhammad:** Postgres `max_connections` sizing for API + ARI apps + Kamailio pools. Needed
  before the Patroni setup.
- **Team:** the plan contents and prices chosen in `services/api/src/billing/catalog.ts`
  ($19 / 7 days, 2 extensions, 100 US minutes; see [backend-card-signup.md](backend-card-signup.md)).
  Number prices must be checked against DIDWW's fees.
- **Course staff:** the payment gateway's API base URL (assumed
  `https://stripe.cse356.compas.cs.stonybrook.edu`); and whether grader tools keep cookies (the API
  authenticates with cookies only).
- **Course staff / whoever has the Course Services credentials:** check the DIDWW clone against
  the [VERIFY] list at the top of `services/api/src/numbers/didww.ts` (filters, includes, order
  status, trunk assignment, release by `billing_cycles_count = 0`), and create our inbound trunk
  group (both edges) for `DID_TRUNK_GROUP_ID`.

### Not built yet

- Changing a staff member's dashboard password (no reset or change-password route yet).
- **Web UI for support tickets** (frontend track): the account pages (list / open / close), and
  optionally a provider page for `GET /operator/tickets`.
- **Alert on new support tickets** (monitoring track): a Prometheus rule on
  `pbx_api_support_tickets_opened_total` -> Discord.

### Gaps in what exists

- **`npm run typecheck` skips `services/api/test/`** (the tsconfig only includes `src`). Test type
  errors are only caught by running a separate check.
- **Stale `services/shared/dist` breaks types silently.** Today the fix is a manual
  `npm run build -w @pbx/shared`; a build step (or pointing the package at its sources in dev)
  would remove the trap.
- **No end-to-end test over a real socket or browser yet.** Auth and staff are covered by
  `app.inject()` tests only; a curl/browser run with the Vite proxy is still to do.
- **No call has gone through an API-created IVR menu yet** (phase-1 VM test).
- **No softphone has registered with API-created credentials yet.** Needs the phase-1 VM (or a
  local Kamailio) pointed at the same database.
- **`@types/node` is `^22`** while the project targets Node 24.

### Known limitations to revisit (hardening phase)

- **No limit on how many tickets an account opens** (only the body size is bounded). Add a
  per-account cap of open tickets if this is ever abused.
- **`POST /tickets` takes no `Idempotency-Key`:** a client retry after a lost response can open
  a duplicate ticket (harmless; the customer can close it).
- **No login rate limiting.** `@fastify/rate-limit` isn't installed, and with several replicas it
  needs shared state.
- **Tokens can't be revoked before they expire** (stateless design): up to 15 min for access
  tokens, 7 days for refresh tokens of a user who still exists.
- **Cross-tenant references are checked by the API only.** Composite foreign keys (e.g.
  `(fallback_mailbox_id, tenant_id) -> mailboxes (id, tenant_id)`) would make the database enforce
  it too; needs a coordinated migration.
- **SIP passwords are stored in plaintext** in `subscriber` (CLAUDE.md §6 course-scope decision);
  future improvement is an encrypted copy + `ha1` only.
