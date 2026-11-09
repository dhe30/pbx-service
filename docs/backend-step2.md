# Backend step 2: authentication

Owner: Aaron (Track 3 backend). Status: done (2026-11-06), commit `2d7fd20`.

Signup, login, token refresh and logout, plus the helpers every later route uses to require a
logged-in user (`authenticate`) or a role (`requireRole`). Follows CLAUDE.md §11: signed JWT in an
httpOnly cookie, stateless across replicas, short expiry + refresh.

**Updated 2026-11-09 for the course spec:** signup takes the business's `timezone`, and `GET /me`
exists (see "Course-spec update" below).

## Files

All under `services/api/`.

| File | Purpose |
|---|---|
| `src/routes/auth.ts` | The four `/auth/*` routes. |
| `src/auth.ts` | Cookie + JWT setup, `authenticate`, `requireRole`, setting/clearing cookies. |
| `src/passwords.ts` | argon2id hashing and timing-safe verification. |
| `src/validation.ts` | `parse(schema, input)`: zod validation -> 400 `invalid_request`. |
| `src/config.ts` | New: `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_SEC`, `COOKIE_SECURE`. |
| `test/auth.test.ts`, `test/helpers.ts` | 16 tests (8 against Postgres); shared test app builder. |

## Endpoints

| Request | Success | Errors |
|---|---|---|
| `POST /auth/signup` `{ businessName, timezone, email, password }` | `201 { userId, tenantId, role: "owner" }` + cookies | 400 `invalid_request`, 409 `email_taken` |
| `POST /auth/login` `{ email, password }` | `200 { userId, tenantId, role }` + cookies | 400, 401 `invalid_credentials` |
| `POST /auth/refresh` | `200 { userId, tenantId, role }` + new cookies | 401 `unauthorized` (cookies cleared) |
| `POST /auth/logout` | `204`, cookies cleared | |
| `GET /me` | `200 { user: { id, email, role, createdAt }, tenant: { id, name, timezone, status, createdAt } }` | 401 (also once the user is deleted) |

Validation: `businessName` 1-100 chars; `timezone` an IANA name (`America/New_York`), stored in
its canonical spelling; `email` valid, stored lowercased; `password` 8-128 chars.

## Using it in a route

```ts
app.get('/staff', { preHandler: [authenticate, requireRole('owner')] }, async (req) => {
  req.auth; // { userId, tenantId, role }, from the verified access token
});
```

## Design decisions

- **Two cookies**, both httpOnly, `Secure`, `SameSite=Lax`, signed HS256 with `JWT_SECRET`:
  - `pbx_access`: 15 min, path `/`.
  - `pbx_refresh`: 7 days, path `/auth` (never sent to other routes).
  - Each token carries a `typ` claim; a refresh token is rejected as an access token and vice versa.
- **Stateless.** No session table, so any app-N replica serves any request. Trade-off: logout
  clears the cookies but can't revoke a copied token before it expires. Short access tokens keep
  that window small.
- **Refresh re-reads the user**, so a deleted user loses access within 15 minutes and role
  changes apply at the next refresh.
- **Signup is one transaction** (tenant + `tenant_settings` + owner user), retried on failover
  errors. A duplicate email returns 409 and leaves no orphan tenant.
- **No account enumeration at login**: unknown email and wrong password give the same 401 and
  take about the same time (a dummy argon2 verify runs for unknown emails).
- **Emails are lowercased** because `users.email` is a case-sensitive `UNIQUE` column.
- **Seed users with password hash `'!'`** can't log in.
- **CSRF**: `SameSite=Lax` plus JSON-only bodies (Fastify answers 415 to form posts).
- **Stayed on Fastify 4** (decision 2026-11-06).

## Verification

- 26 tests passed at the time (16 new); the 8 DB tests ran against the docker-compose Postgres
  and left no rows behind. Source and test files type-check.
- Not run: an end-to-end curl session (declined during the session). The same flows are covered
  by `app.inject()` tests, which go through Fastify's real request handling but not a socket.

## Course-spec update (2026-11-09)

- **Time zone at signup** (spec §1: "time zone (fixed after signup; governs billing periods and
  business hours)"). Required. Stored in `tenants.timezone`, which the ARI app reads for business
  hours and billing periods. Before this, every account got the column default
  `America/New_York`. There is no route that changes it, on purpose.
- **`GET /me`**: the user and their business. `tenant.status` is `active` or `past_due` (the API
  has to report it; past due blocks outgoing calls). Billing fields are added with the card flow.
- 2 more tests (`timezone` required and canonicalized, `/me` incl. 401 after the user is deleted).

## Open items

- Login rate limiting (`@fastify/rate-limit` not installed; with several replicas it needs
  shared state). Hardening phase.
