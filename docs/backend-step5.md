# Backend step 5: mailboxes, ring groups, IVR menus, number routing

Owner: Aaron (Track 3 backend). Status: done (2026-11-06); updated for the course spec
2026-11-09 (see the next section first).

## Course-spec update (2026-11-09)

What changed since the original step 5 (the sections after this one are the original text; where
they disagree, this section wins):

- **Destinations replace `{action, target}`** (ported by Daniel in `570cda8`). Every "where does
  the call go" field is a `Destination` (`DestinationSchema` in `services/shared`):
  `{type: extension|ring_group|ivr_menu|voicemail|business_hours, id}`, `{type: "external",
  number: "+E.164"}` or `{type: "hangup"}`.
  - IVR `config` = `{ options: { "<0-9*#>": Destination }, timeout?, invalid?, repeat_digit? }`.
    Phase-1 `{action: ring_group|voicemail}` and `on_timeout` are still accepted and stored in
    the new format. **`{action: "user"}` is now a 400** (users don't ring any more; the shared
    parser would have stored it as `hangup` without telling anyone).
  - Ring groups: `memberIds` are **extension** ids; `noAnswerDestination` replaces
    `fallbackMailboxId`.
  - `PUT /numbers/:id/route` takes `{ destination }` (phase-1 `{ ivrMenuId }` still accepted) and
    returns `{ id, did, status, kind, destination }`.
  - "Only staff can be rung" (rule 1 below) is gone: extensions ring, and any extension can.
- **409 `in_use`** covers every place a Destination can be stored (`destinationUsages()` in
  `src/references.ts`): IVR menus, phone numbers, ring group no-answer, business hours, extension
  forwarding and extension mailboxes.
- **New: business hours** (`src/routes/business-hours.ts`, owner-only):
  - `GET/POST /business-hours`, `GET/PUT/DELETE /business-hours/:id`.
  - Object `{ id, name, schedule, openDestination, closedDestination, openNow }`.
  - `schedule` = `{ intervals: [{ day: 0-6 (0 = Sunday), start: "HH:MM", end: "HH:MM" }] }` in the
    account's time zone; `end <= start` runs past midnight; `"24:00"` allowed; at most 70
    intervals. Same schema and `isOpen()` as the ARI app.
  - `openDestination` / `closedDestination` are required Destinations.
  - `openNow` is a read-only preview (ignored on input), so `GET` → `PUT` round trips work.
  - Delete: 409 while anything routes to it.
- **New: caller blocklist** (`src/routes/blocked-numbers.ts`, owner-only):
  - `GET /blocked-numbers` (newest first), `POST /blocked-numbers { number }`,
    `DELETE /blocked-numbers/:number`. Object `{ number, createdAt }`.
  - Input in any dialing format (+E.164, 10-digit US, 1+10, 011...; separators ignored); stored and
    returned as E.164, the form the ARI app compares caller numbers in.
  - `POST` is idempotent: 201 when newly blocked, 200 with the existing row otherwise.
  - In the DELETE URL encode `+` as `%2B` (or use the 10-digit / 1+10 form for US numbers).
- Tests: 23 in `test/call-config.test.ts` (business hours CRUD + `openNow` + validation +
  tenant 404s + in-use both ways; blocklist normalization, idempotency, tenant separation; the
  `{action:"user"}` 400; role checks on the new routes).

Owners configure what happens to a call. CLAUDE.md §6 and §11.
- A **phone number** routes to an **IVR menu**.
- Each IVR digit goes to a **ring group**, a **mailbox** (voicemail) or one **staff member**.
- A ring group falls back to a mailbox when nobody answers.

The ARI app reads exactly these rows on every call.

## Files

All under `services/api/`.

| File | Purpose |
|---|---|
| `src/routes/mailboxes.ts` | `/mailboxes` CRUD. |
| `src/routes/ring-groups.ts` | `/ring-groups` CRUD, including members. |
| `src/routes/ivr-menus.ts` | `/ivr-menus` CRUD (config validated by `IvrConfigSchema` from `services/shared`). |
| `src/routes/numbers.ts` | `PUT /numbers/:id/route`. The rest of `/numbers` is step 8. |
| `src/references.ts` | Checks beyond "same tenant": greeting kind, "can be rung", and the 409 `in_use` checks for deletes. |
| `src/tenancy.ts` | `assertOwned` now locks the rows it checks (`FOR SHARE`). |
| `src/validation.ts` | Shared `name` and `nullableId` field rules. |
| `test/call-config.test.ts` | 15 tests (14 against Postgres). |
| `services/shared/src/db.ts` | Bug fix: JSON keys are no longer camelCased on read (see below). Affects the ARI app too. |

## Endpoints

All are **owner-only** (401 without login, 403 for staff). Every `:id` belongs to the caller's
business, or the route answers 404.

| Resource | Routes | Object |
|---|---|---|
| Mailboxes | `GET /mailboxes`, `GET /mailboxes/:id`, `POST /mailboxes`, `PUT /mailboxes/:id`, `DELETE /mailboxes/:id` | `{ id, name, greetingMediaId, ownerUserId }` |
| Ring groups | same five under `/ring-groups` | `{ id, name, strategy, ringTimeoutSec, fallbackMailboxId, memberIds }` |
| IVR menus | same five under `/ivr-menus` | `{ id, name, greetingMediaId, timeoutSec, maxRetries, config }` |
| Number routing | `PUT /numbers/:id/route` `{ ivrMenuId }` | `{ id, did, status, ivrMenuId }` |

Status codes:
- `GET` (list) returns 200, sorted by name. `GET /:id` returns 200 or 404.
- `POST` returns 201 with the created object; `PUT` returns 200 with the updated object.
- `DELETE` returns 204, or 409 `in_use`.
- Bad input is 400 `invalid_request`. An id that doesn't exist, belongs to another business, or
  is the wrong kind is 400 `invalid_reference`, and `message` names the field.

**`PUT` is a full replace.** Omitted optional fields go back to their defaults. Send the whole
object, as returned by `GET`.

### Fields

| Field | Rule | Default |
|---|---|---|
| `name` | 1-100 chars, trimmed | required |
| `greetingMediaId` | a `media` row of kind `greeting` (upload is step 6), or null | null |
| `ownerUserId` (mailbox) | any user of the business, or null. The ARI app uses it as that user's voicemail when an IVR digit rings them directly | null |
| `strategy` | `"all"` (ring everyone, first answer wins) or `"sequential"` (in `memberIds` order) | `"all"` |
| `ringTimeoutSec` | 5-120 (per member for sequential) | 20 |
| `fallbackMailboxId` | a mailbox, or null (= hang up when nobody answers) | null |
| `memberIds` | up to 50 distinct **staff** user ids, in ring order | `[]` |
| `timeoutSec` | 1-30, wait for a digit | 5 |
| `maxRetries` | 1-10, replays before `on_timeout` | 3 |
| `config` | `{ options: { "<0-9*#>": action }, on_timeout?: action }` | `{ options: {} }` |
| action | `{ action: "ring_group" \| "voicemail" \| "user", target: <ring group / mailbox / staff user id> }` | |
| `ivrMenuId` (number route) | an IVR menu, or null (= unrouted: calls are hung up) | null |

`config` keeps the ARI app's snake_case keys (`on_timeout`), since it is stored and read as-is.

Example:

```json
POST /ivr-menus
{
  "name": "Main menu",
  "config": {
    "options": {
      "1": { "action": "ring_group", "target": "<ring group id>" },
      "2": { "action": "voicemail",  "target": "<mailbox id>" }
    },
    "on_timeout": { "action": "voicemail", "target": "<mailbox id>" }
  }
}
```

## Rules beyond tenant isolation

Step 3's rules apply to every route. Step 5 adds three more, because a bad reference here means
a caller gets hung up on:

1. **Only staff can be rung.** Ring group members and IVR `user` targets must have a SIP account.
   Today that means role `staff`; owners have none. Otherwise the request fails with:
   `400 invalid_reference "memberIds.0: user has no softphone (only staff can be called)"`.
   - Why: the ARI app silently skips such members, and hangs up on such an IVR target.
2. **Greetings must be greetings.** `greetingMediaId` must be a `media` row of kind `greeting`,
   not a recording or voicemail.
3. **No deleting what's still in use** (409 `in_use`, `message` names the users):

   | Deleting | Refused while used by |
   |---|---|
   | staff member (step 4) | an IVR menu `user` target |
   | mailbox | an IVR menu `voicemail` target, or a ring group's `fallbackMailboxId` |
   | ring group | an IVR menu `ring_group` target |
   | IVR menu | a phone number routed to it |

   Example: `409 { "error": "in_use", "message": "Used by IVR menu \"Main\", ring group \"Sales\"; change those first" }`.

   - Why: the IVR references are JSON with no foreign key, so they would be left dangling.
     The other two foreign keys are `ON DELETE SET NULL`, which would silently turn "go to
     voicemail" or "answer this number" into "hang up".
   - Not refused: deleting a mailbox **also deletes its voicemails** (foreign key cascade).
     Deleting staff removes them from ring groups.

## Concurrency

Rule 3 needs both sides to take locks, or a save and a delete running at the same moment could
both succeed:

- Saves: `assertOwned()` now locks every row it checks `FOR SHARE` until the transaction ends.
  `assertGreeting()` does the same.
- Deletes: lock the row `FOR UPDATE` first, then look for references.

The delete either waits for the save and then sees the new reference (409), or runs first, and
then the save's reference check fails (400). A test holds a save open and checks that the
delete waits, then refuses.

## Bug fixed in `services/shared` (affects the ARI app)

`createDb` used `transform: postgres.camel`. That renames column names, and also **keys inside
json/jsonb values**: `ivr_menus.config.on_timeout` came back as `onTimeout`, and
`IvrConfigSchema` stripped the unknown key. Writes were not affected (`sql.json` stores keys as
given). Two consequences:

- **ARI app:** `findInboundRoute` (`services/ari-app/src/repo.ts`) never saw an `on_timeout`
  action. Callers who pressed nothing were hung up instead of going to voicemail.
- **API:** `GET /ivr-menus` would have returned `onTimeout`, so a dashboard edit (send back what
  `GET` returned) would have silently removed the menu's `on_timeout` action.

Now only column names are converted:
`transform: { column: { from: postgres.toCamel, to: postgres.fromCamel } }`. No code relied on
camelCased JSON keys (`ivr_menus.config` is the only json/jsonb column). The ARI app code is
unchanged; it gets the fix through the shared package.

Covered by the API test "create, read back and re-save": it reads the config the way the ARI app
does (`createDb` + `parseIvrConfig`) and does a get -> re-save round trip. Rebuild shared after
pulling: `npm run build -w @pbx/shared`. Still to check on the phase-1 VM: a call that times out in
the IVR reaches its `on_timeout` action.

## Design decisions

- **Owner-only, including reads.** Staff only need the softphone (and the voicemail inbox later,
  step 7). Easy to open up if the frontend needs it.
- **Members in one array.** `memberIds` order is the ring order, stored as
  `ring_group_members.position` 0..n-1, and replaced as a whole on `PUT`. There are no separate
  member routes.
- **Routing a number to `null` is allowed.** It's an explicit owner choice, unlike a delete
  silently unrouting the number.
- **Not done here:** `GET /numbers` and purchasing (step 8). Until then numbers only exist from seeds
  or tests.

## Verification

- 62 API tests pass (15 new), against the docker-compose Postgres. They cover:
  - CRUD round trips for each resource; `PUT` reset semantics;
  - another tenant's ids are 404 on every route and are never listed;
  - cross-tenant references, non-staff members and IVR users, non-greeting media, duplicate
    members and bad bounds are all 400 with the field named;
  - each 409 `in_use` case;
  - number routing, including released and foreign numbers;
  - the ARI app's read path for `on_timeout`;
  - the save-vs-delete lock race;
  - 401/403 on every route.
- Shared (4) and ari-app (8) tests pass; all workspaces and test files type-check; no test rows
  left behind.
- Not run: a call through the phase-1 VM using a menu created by the API.
