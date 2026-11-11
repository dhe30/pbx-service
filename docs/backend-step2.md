# Backend step 2: authentication

Owner: Aaron (Track 3 backend). Status: done; account/business lifecycle updated 2026-11-15.

Signup, login, token refresh and logout, plus the helpers every later route uses to require a
logged-in user (`authenticate`) or a role (`requireRole`). Follows CLAUDE.md §11: signed JWT in an
httpOnly cookie, stateless across replicas, short expiry + refresh.

Signup creates a user account without a business. The user can later create a business or be
attached to one by its owner. `GET /me` returns `tenant: null` until then.

## Files

All under `services/api/`.

| File | Purpose |
|---|---|
| `src/routes/auth.ts` | Signup, login, refresh, logout, and `GET /me`. |
| `src/routes/businesses.ts` | Create a business for the logged-in unassigned user. |
| `src/auth.ts` | Cookie + JWT setup, `authenticate`, `requireRole`, setting/clearing cookies. |
| `src/tenancy.ts` | Tenant guards; unassigned users receive `403 business_required`. |
| `src/passwords.ts` | argon2id hashing and timing-safe verification. |
| `src/validation.ts` | `parse(schema, input)`: zod validation -> 400 `invalid_request`. |
| `src/config.ts` | New: `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_SEC`, `COOKIE_SECURE`. |
| `test/auth.test.ts`, `test/helpers.ts` | Auth and account lifecycle tests; shared test app builder. |

## Endpoints

| Request | Success | Errors |
|---|---|---|
| `POST /auth/signup` `{ email, password }` | `201 { userId, tenantId: null, role: "unassigned" }` + cookies | 400 `invalid_request`, 409 `email_taken` |
| `POST /businesses` `{ name, timezone }` | `201 { userId, tenantId, role: "owner", cardSetup }` + refreshed cookies | 400, 403 `forbidden`, 409 `business_exists` |
| `POST /auth/login` `{ email, password }` | `200 { userId, tenantId: string \| null, role }` + cookies | 400, 401 `invalid_credentials` |
| `POST /auth/refresh` | `200 { userId, tenantId: string \| null, role }` + new cookies | 401 `unauthorized` (cookies cleared) |
| `POST /auth/logout` | `204`, cookies cleared | |
| `GET /me` | `200 { user: { id, email, role, createdAt }, tenant: object \| null }` | 401 (also once the user is deleted) |

Validation: signup `email` is valid and stored lowercased; `password` is 8-128 chars.
Business creation validates `name` (1-100 chars) and `timezone` as an IANA name
(`America/New_York`), stored in its canonical spelling.

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
- **Refresh re-reads the user**, so a deleted user loses access within 15 minutes and role or
  business membership changes apply on refresh. `GET /me` also refreshes cookies when membership
  changed since the access token was issued.
- **Signup creates an unassigned user only.** `POST /businesses` transactionally creates the
  tenant and settings, then assigns that user as its owner. A user can belong to one business.
- **Business membership is optional** (`users.tenant_id` nullable); the `unassigned` role is valid
  only when `tenant_id` is null. Tenant-scoped routes return 403 `business_required` otherwise.
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

## Account and business lifecycle update (2026-11-15)

- Registration now collects email, password, and confirmation in the web client; confirmation is
  checked client-side. The API accepts only email and password.
- Authenticated users without a business are routed to Create Business. Business name and time
  zone are submitted to `POST /businesses`; the existing card SetupIntent and `/billing/card`
  flow then saves the card and charges the first plan period.
- Owners can attach an existing unassigned account by email through `POST /staff`; a password is
  required only when creating a brand-new staff login.

## Open items

- Login rate limiting (`@fastify/rate-limit` not installed; with several replicas it needs
  shared state). Hardening phase.
