# Backend API: what the rest of the team needs to know

From: Aaron (Track 3 backend). As of 2026-11-06.
Details: `docs/backend-step1.md`. Code: `services/api/`.

## Status

| Step | What | State |
|---|---|---|
| 1 | Server skeleton: config, logging, `/health`, `/ready`, `/metrics`, error format, graceful shutdown | Done |
| 2 | Auth: signup, login, refresh, logout (cookies + JWT) | Done, `GET /me` deliberately postponed |
| 3 | Tenant isolation helper | Next |
| 4 | Staff + SIP credentials (`users` + Kamailio `subscriber` rows) | Planned |
| 5-8 | IVR / ring groups / mailboxes, media, history/voicemail views, number purchase | Planned |

## For everyone

**Error format.** Every error response, on every route, has this shape:

```json
{ "error": "<machine-readable code>", "message": "<human-readable text>" }
```

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Bad body; `message` names each bad field (`email: Invalid email; password: ...`) |
| 401 | `unauthorized` / `invalid_credentials` | Not logged in, session expired / wrong email or password |
| 403 | `forbidden` | Logged in, but wrong role (e.g. staff on an owner-only route) |
| 404 | `not_found` | |
| 409 | e.g. `email_taken` | Conflict with existing data |
| 415 | | Body wasn't JSON (only `application/json` is accepted) |
| 503 | `unavailable` | Database failing over; comes with `Retry-After: 2`. Retry, it's not a bug |
| 500 | `internal_error` | A bug; details are only in the server log |

**Running the API locally:**

```sh
cp .env.example .env          # add SHUTDOWN_DRAIN_MS=0 for fast restarts
npm run dev:up                # Postgres (Docker Desktop with WSL integration)
npm run db:migrate
npm run dev -w @pbx/api       # http://127.0.0.1:3000
```

`/ready` reports 503 locally until an object store is added to `dev/docker-compose.yml`. That's
expected; everything else works.

**Schema changes.** The API, the ARI app and Kamailio all read the same tables. Please send
migrations (`db/migrations/`, dbmate) through one reviewed PR at a time and tell the other
owners.

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

### Not available yet

- `GET /me` (current user + tenant name). Until then, keep `{ userId, tenantId, role }` from the
  login/signup/refresh response. Tell me what fields you need in `/me`.
- All other dashboard endpoints (CLAUDE.md §11). I'll share request/response shapes before
  building each group; tell me early if a shape doesn't suit the UI.

---

## Daniel (telephony: extensions / staff-to-staff calls)

- **No extension column exists yet.** Staff calling each other probably needs a per-tenant
  extension, e.g. `users.extension` unique per `(tenant_id, extension)`. Let's agree on:
  - who writes the migration;
  - the format (digits only? length?);
  - whether the API assigns extensions automatically or owners pick them.
- **Step 4 (staff) is where our work meets.** `POST /staff` will create the `users` row and the
  Kamailio `subscriber` row in one transaction, and `GET /me/sip-credentials` will return
  `{ wsUri, sipUri, username, password }`. If extensions affect `subscriber` rows (e.g. aliases)
  or the SIP username format, tell me before then.
- `users.sip_username` is **globally** unique (Kamailio looks staff up by username only,
  `use_domain=0`), so a generated username can't be just an extension number.
- The API doesn't write `calls`, `voicemails` or other ARI-app tables; it only reads them
  (call history, voicemail inbox).

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
