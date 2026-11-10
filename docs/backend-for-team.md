# Backend API: what the rest of the team needs to know

From: Aaron (Track 3 backend). Updated 2026-11-09 (course-spec update).
Details: `docs/backend-step1.md` to `docs/backend-step6.md`, `docs/backend-card-signup.md`. Code:
`services/api/`. **Machine-readable reference: `GET /openapi.json`** (see "For everyone").

**What changed on 2026-11-09 (read this if you built against an earlier version):**
- `POST /auth/signup` needs `timezone`, and returns `cardSetup` for the card form.
- `GET /me` exists (user, business, time zone, `status`).
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

## Status

| Step | What | State |
|---|---|---|
| 1 | Server skeleton: config, logging, `/health`, `/ready`, `/metrics`, error format, graceful shutdown | Done |
| 2 | Auth: signup (with time zone), login, refresh, logout (cookies + JWT), `GET /me` | Done |
| 3 | Tenant isolation: scoped queries, 404 for other tenants' ids, reference checks | Done |
| 4 | Staff logins + SIP credentials; extensions (each with a Kamailio `subscriber` row) | Done |
| 5 | IVR menus, ring groups, mailboxes, number routing, business hours, caller blocklist | Done |
| — | Course spec: time zone, `GET /me`, business hours, blocklist, `/openapi.json`, card at signup + first plan charge, extension limit | Done (2026-11-09) |
| 6 | Greeting upload (ffmpeg → 8 kHz WAV), media list / audio download / delete | Done |
| 7-8 | History/voicemail views, settings, number purchase | Planned |

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
| 401 | `unauthorized` / `invalid_credentials` | Not logged in, session expired / wrong email or password |
| 402 | `payment_required`, `payment_failed` | Plan not paid yet / a card charge was declined |
| 403 | `forbidden` | Logged in, but wrong role (e.g. staff on an owner-only route) |
| 404 | `not_found` | Doesn't exist, **or belongs to another business** (deliberately indistinguishable) |
| 409 | `email_taken`, `in_use`, `number_taken`, `extension_limit` | Conflict with existing data (`in_use`: can't delete, still used by call routing; `message` names what uses it) |
| 416 | `range_not_satisfiable` | `Range` header outside the file (`GET /media/:id/audio`) |
| 4xx | Fastify's code, e.g. `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415) | Errors raised by Fastify itself: body wasn't JSON (only `application/json` is accepted, except audio uploads to `POST /media`), body too large, malformed JSON. Same shape, but `error` is Fastify's code, not one of ours |
| 500 | `internal_error` | A bug; details are only in the server log |
| 502 | `payment_gateway_error` | The payment service failed. Safe to retry (billing calls are idempotent) |
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
| `POST /auth/signup` `{ "businessName", "timezone", "email", "password" }` | `201 { "userId", "tenantId", "role": "owner", "cardSetup" }` + cookies |
| `POST /auth/login` `{ "email", "password" }` | `200 { "userId", "tenantId", "role" }` + cookies |
| `POST /auth/refresh` (no body) | `200 { "userId", "tenantId", "role" }` + new cookies |
| `POST /auth/logout` (no body) | `204` + cookies cleared |
| `GET /me` | `200 { "user": { "id", "email", "role", "createdAt" }, "tenant": { "id", "name", "timezone", "status", "createdAt" } }` |

Validation rules (show them in the forms):
- `businessName`: 1-100 characters.
- `timezone`: IANA name, e.g. `America/New_York` (offer a picker; the browser's own zone is
  `Intl.DateTimeFormat().resolvedOptions().timeZone`). **Fixed after signup**: it sets billing
  periods and business hours. Returned in its canonical spelling.
- `email`: valid email, case-insensitive (stored lowercased).
- `password`: 8-128 characters at signup.

Error codes: wrong email and wrong password return the same `401 invalid_credentials` (on
purpose). A taken email at signup returns `409 email_taken`.

### Card at signup and billing (spec §1, §2)

The signup form must also save a card. Card fields go to Stripe.js only, **never** to our API.
1. `POST /auth/signup`. The response's `cardSetup` = `{ setupIntentId, clientSecret, publishableKey,
   stripeJsUrl }` (`null` if the gateway failed: call `POST /billing/setup-intent`).
2. Load Stripe.js from `stripeJsUrl`, `Stripe(publishableKey)`, card element,
   `stripe.confirmCardSetup(clientSecret, { payment_method: { card } })` (handles 3-D Secure).
3. `POST /billing/card { setupIntentId }` → `200` billing state; the plan is charged now,
   prorated. `402 payment_failed` = card declined: restart from `POST /billing/setup-intent`.

Other routes: `GET /billing/prices` (public; show the plan price on the signup page),
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
| `POST /staff` `{ "email", "password" }` | owner | `201 { "id", "email", "role": "staff", "createdAt" }` |
| `GET /staff` | owner | `200 [ { same fields }, ... ]`, oldest first |
| `DELETE /staff/:id` | owner | `204` (an extension assigned to them stays, unassigned) |
| `GET /me/sip-credentials[?extensionId=]` | any user | `200 { "wsUri", "sipUri", "username", "password", "extensionId", "extensionNumber" }` |

- The owner sets the staff member's first dashboard password (same rules as signup) and gives it
  to them; the staff member then logs in normally with `/auth/login`.
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
| `DELETE /extensions/:id` | owner | `204`; `409 in_use` while something routes to it |

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
| Number routing | `PUT /numbers/:id/route` `{ destination }` | `{ id, did, status, kind, destination }` |
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
- There's no `GET /numbers` yet (step 8), so number routing can't be wired into the UI until then.

### Not available yet

- All other dashboard endpoints (CLAUDE.md §11). I'll share request/response shapes before
  building each group; tell me early if a shape doesn't suit the UI.

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
  number routing, ring group no-answer, forwarding, extension mailboxes). Seeds or scripts that
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

- If HAProxy routes on `/ready`, a cluster-wide DB outage marks **every** app replica down. That
  matches CLAUDE.md §11, but please make it a conscious choice.
- **Graceful shutdown:** on SIGTERM, `/ready` returns 503 for `SHUTDOWN_DRAIN_MS` (default 5 s)
  before the server closes. Keep this above HAProxy's check interval x fall count, so HAProxy
  stops routing before connections close.

### Metrics and logs

- `GET /metrics` (Prometheus) on the API port (default 3000, private IP only):
  - `pbx_api_http_request_duration_seconds{method,route,status}`: latency per route template,
    usable for error-rate alerts (`status=~"5.."`);
  - standard Node process metrics (CPU, memory, event loop lag, GC).
- Logs: pino **JSON to stdout** (journald / docker), field `svc: "api"`. Your log retention
  settings cover the API; it writes no log files itself.
  - Cookies, `Authorization` and `Set-Cookie` are redacted.
  - `/health`, `/ready` and `/metrics` don't log every request; failed readiness checks log at
    `warn` with the failing check.
  - Each request has a `reqId`; if HAProxy sets `X-Request-Id`, that value is used.

### Config and secrets (for Ansible / Vault)

- Required: `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `JWT_SECRET`, `DID_PROVIDER_URL`, `SIP_WS_URI`, `SIP_DOMAIN`,
  `STRIPE_SECRET_KEY` (Vault), `STRIPE_PUBLISHABLE_KEY`. Optional: `STRIPE_API_URL`,
  `STRIPE_JS_URL` (defaults: the course gateway), `FFMPEG_PATH` (default `ffmpeg`; app nodes need ffmpeg installed), `S3_REGION` (default `garage`; must match
  Garage's `s3_region`), `COOKIE_SECURE` (default `true`; keep it in production),
  `ACCESS_TOKEN_TTL_SEC` (900) / `REFRESH_TOKEN_TTL_SEC` (7 days), `HOST`, `PORT` (3000),
  `LOG_LEVEL` (info), `DB_POOL_MAX` (10), `SHUTDOWN_DRAIN_MS` (5000), `SHUTDOWN_TIMEOUT_MS`
  (10000). The process refuses to start, listing the missing ones, if any are absent.
- **`JWT_SECRET` must be identical on every app node** (otherwise logins break when HAProxy
  switches replicas) and at least 16 characters; keep it in Vault.
- Production: set `HOST` to the app node's private IP (default `127.0.0.1`).
- Capacity: each login or signup hashes with argon2 (~64 MiB memory, ~50-100 ms CPU). Up to 4
  run at once per process, so budget roughly 256 MiB of extra memory per app node at peak.

---

## Outstanding backend items

Everything backend-related that is still missing or undecided. Remove items as they're done.

### Decisions needed from others

- **Justin:** whether `GET /me` has the fields the UI needs, and request/response shapes for each
  dashboard page. Needed before steps 6-7. (Staff and call configuration shapes are already built; say if they
  don't suit the UI.)
- **Daniel:** confirm on the phase-1 VM that an IVR `on_timeout` action now runs (fixed in
  `services/shared` in step 5; see the Daniel section above).
- **Muhammad:** the production Garage key and bucket must match what the dev setup assumes:
  bucket `pbx-media`, `s3_region = "garage"`, path-style S3 API, a key with read/write on the
  bucket (`dev/garage-setup.sh` shows the commands).
- **Muhammad:** who runs `dbmate` migrations during a deploy (once, before the new API version
  starts). Needed before the first multi-node deploy.
- **Muhammad / edge owner:** whether the edge HAProxy routes on `/ready` (a cluster-wide DB
  outage then marks every app replica down). Needed before the edge HAProxy role.
- **Muhammad:** Postgres `max_connections` sizing for API + ARI apps + Kamailio pools. Needed
  before the Patroni setup.
- **Team:** the plan contents and prices chosen in `services/api/src/billing/catalog.ts`
  ($19 / 7 days, 2 extensions, 100 US minutes; see [backend-card-signup.md](backend-card-signup.md)).
  Number prices must be checked against DIDWW's fees.
- **Course staff:** the payment gateway's API base URL (assumed
  `https://stripe.cse356.compas.cs.stonybrook.edu`); and whether grader tools keep cookies (the API
  authenticates with cookies only).
- **Course staff:** DID endpoint API shape and how purchases work (CLAUDE.md §3 A6). Needed
  before step 8.

### Not built yet

- Changing a staff member's dashboard password (no reset or change-password route yet).
- Step 7: call history, voicemail inbox (list, mark heard, delete), settings.
- Billing: buying extra extensions / numbers / add-ons, weekly invoices, past due and recovery
  (billing-flows §3-§5).
- Step 8: number listing and purchase (idempotent, behind a fake provider until the DID endpoint
  is known).
- `services/api/Dockerfile`: still a TODO. It also names `node:20`; should be Node 24 and include
  ffmpeg.

### Gaps in what exists

- **`npm run typecheck` skips `services/api/test/`** (the tsconfig only includes `src`). Test type
  errors are only caught by running a separate check.
- **Stale `services/shared/dist` breaks types silently.** Today the fix is a manual
  `npm run build -w @pbx/shared`; a build step (or pointing the package at its sources in dev)
  would remove the trap.
- **No end-to-end test over a real socket or browser yet.** Auth and staff are covered by
  `app.inject()` tests only; a curl/browser run with the Vite proxy is still to do.
- **Deleting a mailbox leaves its voicemail audio behind.** The voicemail rows cascade, but their
  `media` rows and object-store files stay. Step 7 (voicemail delete) should add the cleanup.
- **No call has gone through an API-created IVR menu yet** (phase-1 VM test).
- **No softphone has registered with API-created credentials yet.** Needs the phase-1 VM (or a
  local Kamailio) pointed at the same database.
- **`@types/node` is `^22`** while the project targets Node 24.

### Known limitations to revisit (hardening phase)

- **No login rate limiting.** `@fastify/rate-limit` isn't installed, and with several replicas it
  needs shared state.
- **Tokens can't be revoked before they expire** (stateless design): up to 15 min for access
  tokens, 7 days for refresh tokens of a user who still exists.
- **Cross-tenant references are checked by the API only.** Composite foreign keys (e.g.
  `(fallback_mailbox_id, tenant_id) -> mailboxes (id, tenant_id)`) would make the database enforce
  it too; needs a coordinated migration.
- **SIP passwords are stored in plaintext** in `subscriber` (CLAUDE.md §6 course-scope decision);
  future improvement is an encrypted copy + `ha1` only.
