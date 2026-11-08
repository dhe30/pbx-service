# Backend step 1: API server skeleton

Owner: Aaron (Track 3 backend). Status: done (2026-11-06).

Step 1 of the backend plan: a Fastify server in `services/api` with config validation, structured
logging, health/readiness/metrics endpoints, a common error format and graceful shutdown. No
business endpoints yet (auth is step 2).

## Files

All under `services/api/`.

| File | Purpose |
|---|---|
| `src/config.ts` | Validates all env vars with zod at startup. Fails fast with one line per bad variable; never prints values. |
| `src/app.ts` | `buildApp(cfg, deps)` builds the Fastify instance without listening, so tests use `app.inject()`. |
| `src/index.ts` | Entrypoint: wires the real DB and object store, starts listening, handles SIGTERM/SIGINT. |
| `src/routes/health.ts` | `GET /health`, `GET /ready`, `GET /metrics`. |
| `src/errors.ts` | `HttpError` class + global error and 404 handlers. |
| `src/metrics.ts` | prom-client registry, default process metrics, request latency histogram. |
| `src/object-store.ts` | S3 client for Garage (path-style). Only `ping()` for now; grows in step 6. |
| `test/health.test.ts` | 10 vitest tests (endpoints, error mapping, config). |
| `package.json` | `dev` script now loads the repo-root `.env` if present (`--env-file-if-exists`). |

## Endpoints

| Endpoint | Meaning | Status codes |
|---|---|---|
| `GET /health` | Liveness: the process answers. Never checks dependencies. | 200 |
| `GET /ready` | Readiness: DB (`select 1`) and object store (`HeadBucket`) reachable, and not shutting down. | 200 `{"status":"ok","checks":{...}}`, 503 `{"status":"fail","checks":{"db":"ok","objectStore":"fail"}}` or `{"status":"draining"}` |
| `GET /metrics` | Prometheus scrape. | 200 |

## Configuration

Required (see `.env.example`): `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `JWT_SECRET` (min 16 chars), `DID_PROVIDER_URL`, `SIP_WS_URI`, `SIP_DOMAIN`.

Optional, with defaults:

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Production: the app node's private IP. |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | |
| `DB_POOL_MAX` | `10` | |
| `S3_REGION` | `garage` | |
| `SHUTDOWN_DRAIN_MS` | `5000` | How long `/ready` reports 503 before closing. Use `0` locally. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Hard limit for in-flight requests after draining. |

## Design decisions

- **`/health` never touches the DB.** If it did, a DB outage would make systemd/docker restart
  every healthy API process at once.
- **`/ready` runs checks in parallel, each limited to 1.5 s** (aborted on timeout), so a hung
  dependency can't make HAProxy's own check time out.
- **Startup does not wait for dependencies.** The server listens even while Postgres is down or
  failing over and reports 503 until it answers; postgres.js reconnects on its own. Needed for the
  "restart all VMs" chaos drill.
- **Graceful shutdown:** on SIGTERM, `/ready` returns `draining` for `SHUTDOWN_DRAIN_MS` so the
  edge HAProxies stop routing here, then in-flight requests finish, the DB pool closes and the
  process exits. A hard timeout guarantees exit.
- **One error format** for every route: `{ "error": "<code>", "message": "<text>" }`.
  - Routes throw `new HttpError(status, code, message)` for expected failures.
  - Transient DB errors (failover) -> 503 with `Retry-After: 2`.
  - Fastify 4xx errors (bad JSON, validation) pass through.
  - Anything else -> 500 `internal_error`; details are logged, never returned.
- **Logging:** pino JSON to stdout with `svc: "api"`; cookies, `Authorization` and `Set-Cookie`
  are redacted. Request ids come from HAProxy's `X-Request-Id` when present. Probe routes
  (`/health`, `/ready`, `/metrics`) don't log every request at info level; failed checks still log
  a warning.
- **Metrics:** `pbx_api_http_request_duration_seconds{method,route,status}`, labelled by route
  template (`/voicemails/:id`), not raw URL, to keep cardinality low.
- **`trustProxy: true`**: safe only because the API port is reachable on the private network only
  (host firewall).

## Verification

- `npm run typecheck -w @pbx/api`, `npm test -w @pbx/api` (10/10 pass), `npm run build -w @pbx/api`.
- Run against the docker-compose Postgres (`dev-postgres-1`, migrations already applied):

  | DB state | `/ready` db check | `/health` |
  |---|---|---|
  | Running | ok (connection visible as `api@<hostname>` in `pg_stat_activity`) | 200 |
  | Stopped | fail | 200 |
  | Started again | ok, no API restart | 200 |
  | Paused (hung) | fail after the 1.5 s timeout | 200 |

- SIGTERM: `/ready` switched to `draining`, process exited 0.
- Missing env vars: lists each one, exits 1.

## Open items

- **No object store in `dev/docker-compose.yml` yet**, so `/ready` is 503 locally
  (`objectStore: fail`). Add Garage, matching Muhammad's production setup, by step 6.
- **Edge HAProxy (whoever writes the role):** if it health-checks `/ready`, a cluster-wide DB
  outage marks every app replica down. That's correct per CLAUDE.md §11, but should be a
  conscious choice.
- **Dependency versions:** still Fastify 4.29 / vitest 2 as installed. Decide on Fastify 5 before
  step 2, while it's cheap.
- **`services/api/Dockerfile`** is still a TODO (deployment, phase 3 / CI).
- **For Muhammad (observability):** scrape `/metrics`, alert on `/ready`; logs go to stdout
  (journald), so his retention settings cover the API.

## Running locally

```sh
cp .env.example .env          # add SHUTDOWN_DRAIN_MS=0 for fast restarts
npm run dev:up                # Postgres (needs Docker Desktop WSL integration)
npm run db:migrate
npm run dev -w @pbx/api       # http://127.0.0.1:3000/health
```
