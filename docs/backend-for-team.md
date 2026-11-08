# Backend API: what the rest of the team needs to know

From: Aaron (Track 3 backend). As of 2026-11-06.
Details: `docs/backend-step1.md` to `docs/backend-step5.md`. Code: `services/api/`.

## Status

| Step | What | State |
|---|---|---|
| 1 | Server skeleton: config, logging, `/health`, `/ready`, `/metrics`, error format, graceful shutdown | Done |
| 2 | Auth: signup, login, refresh, logout (cookies + JWT) | Done, `GET /me` deliberately postponed |
| 3 | Tenant isolation: scoped queries, 404 for other tenants' ids, reference checks | Done |
| 4 | Staff + SIP credentials (`users` + Kamailio `subscriber` rows) | Done (no extensions yet) |
| 5 | IVR menus, ring groups, mailboxes, number routing | Done |
| 6 | Greeting upload, media URLs | Next (needs Garage in dev) |
| 7-8 | History/voicemail views, settings, number purchase | Planned |

## For everyone

**Error format.** Every error response, on every route, has this shape:

```json
{ "error": "<machine-readable code>", "message": "<human-readable text>" }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Bad body or malformed id; `message` names each bad field (`email: Invalid email; password: ...`) |
| 400 | `invalid_reference` | The body points at an id that doesn't exist or belongs to another business; `message` names the field (`members.1: no such user`) |
| 401 | `unauthorized` / `invalid_credentials` | Not logged in, session expired / wrong email or password |
| 403 | `forbidden` | Logged in, but wrong role (e.g. staff on an owner-only route) |
| 404 | `not_found` | Doesn't exist, **or belongs to another business** (deliberately indistinguishable) |
| 409 | `email_taken`, `in_use` | Conflict with existing data (`in_use`: can't delete, still used by an IVR menu, ring group or phone number; `message` names them) |
| 415 | | Body wasn't JSON (only `application/json` is accepted) |
| 503 | `unavailable` | Database failing over; comes with `Retry-After: 2`. Retry, it's not a bug |
| 500 | `internal_error` | A bug; details are only in the server log |

**Running the API locally:**

```sh
cp .env.example .env          # add SHUTDOWN_DRAIN_MS=0 for fast restarts
npm run dev:up                # Postgres (Docker Desktop with WSL integration)
npm run db:migrate
npm run db:kamailio           # Kamailio tables (subscriber, location); safe to re-run
npm run dev -w @pbx/api       # http://127.0.0.1:3000
```

`/ready` reports 503 locally until an object store is added to `dev/docker-compose.yml`. That's
expected; everything else works.

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
| `POST /auth/signup` `{ "businessName", "email", "password" }` | `201 { "userId", "tenantId", "role": "owner" }` + cookies |
| `POST /auth/login` `{ "email", "password" }` | `200 { "userId", "tenantId", "role" }` + cookies |
| `POST /auth/refresh` (no body) | `200 { "userId", "tenantId", "role" }` + new cookies |
| `POST /auth/logout` (no body) | `204` + cookies cleared |

Validation rules (show them in the forms):
- `businessName`: 1-100 characters.
- `email`: valid email, case-insensitive (stored lowercased).
- `password`: 8-128 characters at signup.

Error codes: wrong email and wrong password return the same `401 invalid_credentials` (on
purpose). A taken email at signup returns `409 email_taken`.

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

### Staff endpoints (available now, step 4)

| Request | Who | Success response |
|---|---|---|
| `POST /staff` `{ "email", "password" }` | owner | `201 { "id", "email", "role": "staff", "sipUsername", "createdAt" }` |
| `GET /staff` | owner | `200 [ { same fields }, ... ]`, oldest first |
| `DELETE /staff/:id` | owner | `204` |
| `GET /me/sip-credentials` | staff | `200 { "wsUri", "sipUri", "username", "password" }` |

- The owner sets the staff member's first dashboard password (same rules as signup) and gives it
  to them; the staff member then logs in normally with `/auth/login`.
- Errors: `409 email_taken` on create; `409 in_use` on delete while an IVR menu routes to that
  person (show `message`, it names the menu); `404` if already deleted.
- Softphone: after a staff login, fetch `/me/sip-credentials` and pass the fields to SIP.js
  (`wsUri` = WebSocket server, `sipUri` = AOR, `username`/`password` = digest auth). Keep the
  password in memory only, don't store it. Owners get `403` here: only staff have a softphone.

### Call configuration endpoints (available now, step 5)

Owner-only. Full field rules, defaults and an example: `docs/backend-step5.md`.

| Resource | Routes | Object |
|---|---|---|
| Mailboxes | `GET/POST /mailboxes`, `GET/PUT/DELETE /mailboxes/:id` | `{ id, name, greetingMediaId, ownerUserId }` |
| Ring groups | `GET/POST /ring-groups`, `GET/PUT/DELETE /ring-groups/:id` | `{ id, name, strategy, ringTimeoutSec, fallbackMailboxId, memberIds }` |
| IVR menus | `GET/POST /ivr-menus`, `GET/PUT/DELETE /ivr-menus/:id` | `{ id, name, greetingMediaId, timeoutSec, maxRetries, config }` |
| Number routing | `PUT /numbers/:id/route` `{ ivrMenuId }` | `{ id, did, status, ivrMenuId }` |

- **`PUT` replaces the whole object**: omitted fields reset to defaults. Edit forms should send
  everything they got from `GET`.
- `memberIds` order is the ring order (matters for `strategy: "sequential"`). Only staff can be
  members or IVR `user` targets; offer only `GET /staff` people in those pickers.
- `config` uses the ARI app's keys as-is: `{ options: { "1": { action, target } }, on_timeout }`
  (snake_case `on_timeout`, unlike the other fields).
- `409 in_use` on delete: show `message` (e.g. `Used by IVR menu "Main"; change that first`).
- There's no `GET /numbers` yet (step 8), so number routing can't be wired into the UI until then.

### Not available yet

- `GET /me` (current user + tenant name). Until then, keep `{ userId, tenantId, role }` from the
  login/signup/refresh response. Tell me what fields you need in `/me`.
  Proposed GET /me (not built yet; feedback welcome)
  {
    "user": {
      "id": "uuid",
      "email": "owner@tonys.test",
      "role": "owner",
      "sipUsername": null,
      "extension": null
    },
    "tenant": 
  {
- All other dashboard endpoints (CLAUDE.md §11). I'll share request/response shapes before
  building each group; tell me early if a shape doesn't suit the UI.

### Errors to handle on upcoming forms (from step 3)

- `404 not_found` on a detail page: show "not found"; the id may simply belong to another
  business.
- `400 invalid_reference` on save: `message` starts with the field path (`config.options.2.target`,
  `memberIds.1`), so you can highlight the field. Usually means a picked item was deleted
  meanwhile; reload the options.

---

## Daniel (telephony: extensions / staff-to-staff calls)

- **No extension column exists yet.** Staff calling each other probably needs a per-tenant
  extension, e.g. `users.extension` unique per `(tenant_id, extension)`. Let's agree on:
  - who writes the migration;
  - the format (digits only? length?);
  - whether the API assigns extensions automatically or owners pick them.
- **Step 4 (staff) is done** (`docs/backend-step4.md`):
  - `POST /staff` creates the `users` row and the Kamailio `subscriber` row in one transaction.
    The SIP username is generated: `s` + 16 hex chars; the domain is `SIP_DOMAIN`.
  - `DELETE /staff/:id` also deletes the user's `kamailio.location` rows, so their softphone
    stops ringing at once.
  - `GET /me/sip-credentials` returns `{ wsUri, sipUri, username, password }`.
  - If extensions need `subscriber` changes (aliases) or a different username format, tell me.
    The routes can take an `extension` field without breaking anything.
- `users.sip_username` is **globally** unique (Kamailio looks staff up by username only,
  `use_domain=0`), so a generated username can't be just an extension number.
- The API doesn't write `calls`, `voicemails` or other ARI-app tables; it only reads them
  (call history, voicemail inbox).
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
- **The API refuses to delete what calls still depend on** (409 `in_use`): a staff member, mailbox
  or ring group an IVR menu targets, a mailbox used as a ring group fallback, an IVR menu a number
  routes to. Seeds or scripts that delete these rows directly should keep the same rule.

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
  `S3_SECRET_ACCESS_KEY`, `JWT_SECRET`, `DID_PROVIDER_URL`, `SIP_WS_URI`, `SIP_DOMAIN`. The
  process refuses to start, listing the missing ones, if any are absent.
- **`JWT_SECRET` must be identical on every app node** (otherwise logins break when HAProxy
  switches replicas) and at least 16 characters; keep it in Vault.
- Production: set `HOST` to the app node's private IP (default `127.0.0.1`).
- Capacity: each login or signup hashes with argon2 (~64 MiB memory, ~50-100 ms CPU). Up to 4
  run at once per process, so budget roughly 256 MiB of extra memory per app node at peak.

---

## Outstanding backend items

Everything backend-related that is still missing or undecided. Remove items as they're done.

### Decisions needed from others

- **Daniel:** extensions schema (column, format, who writes the migration, auto-assigned or
  picked by owners). Step 4 shipped without it; needed before staff-to-staff calling.
- **Justin:** fields in `GET /me`, and request/response shapes for each dashboard page. Needed
  before `/me` and steps 6-7. (Staff and call configuration shapes are already built; say if they
  don't suit the UI.)
- **Daniel:** confirm on the phase-1 VM that an IVR `on_timeout` action now runs (fixed in
  `services/shared` in step 5; see the Daniel section above).
- **Muhammad:** Garage in `dev/docker-compose.yml` (bucket, keys, endpoint matching production).
  Needed before step 6; until then `/ready` is 503 locally.
- **Muhammad:** who runs `dbmate` migrations during a deploy (once, before the new API version
  starts). Needed before the first multi-node deploy.
- **Muhammad / edge owner:** whether the edge HAProxy routes on `/ready` (a cluster-wide DB
  outage then marks every app replica down). Needed before the edge HAProxy role.
- **Muhammad:** Postgres `max_connections` sizing for API + ARI apps + Kamailio pools. Needed
  before the Patroni setup.
- **Course staff:** DID endpoint API shape and how purchases work (CLAUDE.md §3 A6). Needed
  before step 8.

### Not built yet

- `GET /me` (postponed on purpose).
- Staff extensions (step 4 follow-up, waiting on the schema decision with Daniel).
- Changing a staff member's dashboard password (no reset or change-password route yet).
- Step 6: greeting upload (ffmpeg conversion to 8 kHz mono wav) and presigned media URLs.
- Step 7: call history, voicemail inbox (list, mark heard, delete), settings.
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
