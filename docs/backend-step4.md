# Backend step 4: staff and SIP credentials

Owner: Aaron (Track 3 backend). Status: done (2026-11-06).

Owners create and delete staff accounts. Each staff member gets a dashboard login plus a
generated SIP account (a Kamailio `subscriber` row), which the browser softphone fetches after
login to register with Kamailio. Follows CLAUDE.md §6 and §11.

## Files

All under `services/api/` unless noted.

| File | Purpose |
|---|---|
| `src/routes/staff.ts` | The four routes below. |
| `src/validation.ts` | `email` / `password` field rules, now shared by signup, login and staff. |
| `src/errors.ts` | `isUniqueViolation(err, constraint)`, moved here from the auth routes. |
| `src/app.ts` | Registers the staff routes; `AppConfig` now includes `SIP_WS_URI`, `SIP_DOMAIN`. |
| `test/staff.test.ts` | 9 tests (7 against Postgres + the Kamailio tables). |
| `dev/kamailio-schema.sh` (repo root) | `npm run db:kamailio`: creates the Kamailio tables in the dev DB. |

## Endpoints

| Request | Who | Success | Errors |
|---|---|---|---|
| `POST /staff` `{ email, password }` | owner | `201` staff object | 400 `invalid_request`, 409 `email_taken` |
| `GET /staff` | owner | `200 [staff object, ...]`, oldest first | |
| `DELETE /staff/:id` | owner | `204` | 404 `not_found`, 409 `in_use` |
| `GET /me/sip-credentials` | staff | `200 { wsUri, sipUri, username, password }` | 404 `not_found` |

Staff object: `{ id, email, role: "staff", sipUsername, createdAt }`. It never includes a
password or hash.

All routes need a login (401 otherwise) and the right role (403 otherwise). `email` and
`password` follow the signup rules: the email is lowercased, the password is 8-128 chars. The
owner picks the staff member's first dashboard password and passes it on.

Example `/me/sip-credentials` response, ready for SIP.js:

```json
{
  "wsUri": "wss://pbx.example/ws",
  "sipUri": "sip:s3f9a0c2d4e6b8a1c@pbx.local",
  "username": "s3f9a0c2d4e6b8a1c",
  "password": "Qm9sZC1yYW5kb20tMTQ0Yml0"
}
```

## What each route writes

- **`POST /staff`**, in one transaction (retried on failover):
  - `users` row: role `staff`, argon2id password hash, generated `sip_username`;
  - `kamailio.subscriber` row: `(sip_username, SIP_DOMAIN, generated password)`.
  - A taken email rolls back both rows.
- **`DELETE /staff/:id`**, in one transaction:
  1. Lock the user row (`FOR UPDATE`).
  2. Refuse with 409 if an IVR menu routes to this user.
  3. Delete `kamailio.location_attrs`, `kamailio.location` (live registrations), the subscriber row, and the user.
  4. Foreign keys then delete the user's `ring_group_members` rows and set `mailboxes.owner_user_id`
     and `calls.answered_by_user_id` to NULL, so call history is kept.
- **`GET /me/sip-credentials`** reads the user joined to their subscriber row, filtered by tenant.
  It sends `Cache-Control: no-store`.

## Design decisions

- **Generated SIP usernames: `s` + 16 hex characters.**
  - They must be globally unique: Kamailio looks users up by username only (`use_domain=0`).
    That rules out per-tenant names like "alice" or extension numbers.
  - They contain only letters and digits, because they appear in Asterisk dial strings
    (`PJSIP/<username>@edge-a`).
  - A collision is retried; with 2^64 possible names it should never happen.
- **SIP password: 24 random base64url characters (144 bits)**, stored in plaintext in
  `subscriber.password`. Kamailio's `calculate_ha1=yes` needs plaintext, and so does
  `/me/sip-credentials` (CLAUDE.md §6 course-scope decision). Staff never see or type it.
- **One transaction for `users` + `subscriber`.** Both live in the same database (the Kamailio
  tables are in the `kamailio` schema), so there are never half-created accounts.
- **Delete also removes registrations.** With usrloc `db_mode=3`, Kamailio reads `location` on
  every lookup, so a deleted staff member's open softphone stops ringing immediately instead of
  when its registration expires. Its REGISTER refreshes then fail authentication.
- **409 `in_use` instead of leaving a dangling IVR target.** `ivr_menus.config` references
  users in JSON with no foreign key. The ARI app hangs up when a `user` target is missing
  (`inbound.ts`), so a caller pressing that digit would be cut off. The owner must change the
  menu first; the message names it.
  - Race: the delete locks the user row `FOR UPDATE`; IVR and ring group saves lock the users
    they reference `FOR SHARE` (via `assertOwned`, step 5), so they can't interleave.
- **Only staff are managed here.** `DELETE /staff/:id` on an owner returns 404 like an unknown id.
  Owners get no SIP account, and `/me/sip-credentials` is staff-only (CLAUDE.md §11).
- **`SIP_DOMAIN` must equal Ansible's `sip_domain`** (`infra/ansible/group_vars/all/main.yml`,
  default `pbx.local`). `/me/sip-credentials` only finds subscriber rows in that domain.
- **No extensions yet.** That schema is still to be agreed with Daniel (see
  `docs/backend-for-team.md`). Adding a `users.extension` column later doesn't change these routes'
  existing fields.

## Local setup

The dev database now also needs Kamailio's tables (once per fresh database):

```sh
npm run dev:up
npm run db:migrate
npm run db:kamailio      # creates schema kamailio from db/kamailio/*.sql; safe to re-run
```

In production the `db_schema` Ansible role creates the same tables and grants the API's DB role
access to them.

## Verification

- 47 API tests pass (9 new; the staff DB tests run against the docker-compose Postgres with the
  Kamailio tables). They cover:
  - create, then log in as the new staff member;
  - validation errors, and a duplicate email leaving no subscriber row behind;
  - the list is tenant-scoped and has no secrets;
  - credentials match the subscriber row and are `no-store`;
  - delete removes the user, subscriber, location and ring group membership, and the deleted
    user's still-valid token gets 404 for credentials;
  - another tenant's staff, an owner, or an unknown id all give the same 404;
  - 409 while an IVR menu references the user;
  - role checks (401/403) on every route.
- Source and test files type-check; no test rows left behind.
- Not run: a real softphone registering with credentials from this API (needs the phase-1 VM or
  a local Kamailio).
