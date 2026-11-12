# Backend step 7: call history, voicemail inbox, settings

Owner: Aaron (Track 3 backend). Status: done (2026-11-09). Builds on step 6 (audio streaming).

## Routes

Any logged-in user (see "Who sees what").

| Route | Result | Errors |
|---|---|---|
| `GET /calls?from&to&direction&outcome&extension&number&limit&cursor` | `200 { items: [leg], nextCursor }` | 400 |
| `GET /calls/:callId` | `200 { callId, legs: [leg], recordingUrl }` | 404 |
| `GET /calls/:callId/recording` | `200`/`206` WAV | 404, 416 |
| `GET /voicemails?mailboxId&heard&limit&cursor` | `200 { items: [voicemail], nextCursor }` | 400 |
| `GET /voicemails/:id` | `200 voicemail` | 404 |
| `PATCH /voicemails/:id { heard }` | `200 voicemail` | 400, 404 |
| `DELETE /voicemails/:id` | `204` | 404 |
| `GET /voicemails/:id/audio` | `200`/`206` WAV | 404, 416 |
| `GET /settings` | `200 settings` | |

Code: `services/api/src/routes/{calls,voicemails,settings}.ts`, `src/paging.ts`,
`src/visibility.ts`, `src/audio-response.ts` (shared with `GET /media/:id/audio`). Tests:
`services/api/test/history.test.ts`.

## Call history

Rows are the CDRs the ARI app writes: **one per leg** (docs/telephony-contract.md §6). The main
leg has `parentId: null`; each extra leg we placed to an external number (simultaneous ring,
forwarding, transfer to a number) has the same `callId` and `parentId` = the main leg.

leg = `{ id, callId, parentId, direction, fromNumber, toNumber, did, fromExtension, toExtension,
startedAt, answeredAt, endedAt, billableSec, outcome, voicemail, vendor, cost, charge, includedSec,
recordingUrl }`
- `charge`: what the customer pays for the leg, in USD (a JSON number; the column is
  `numeric(12,6)`). `cost`: what we pay the vendor / DID provider for it (course spec §5: CDRs
  include cost and charge; the course adapter requires it, 2026-11-12). `rate_prefix`,
  `hangup_cause` and `pbx_node` are internal and not returned.
- `fromExtension` / `toExtension`: extension NUMBERS ("101"), not ids.
- `recordingUrl` / recordings in `GET /media`: appear only once the recording is uploaded
  (seconds after the call ends); there is no "in progress" state.
- `recordingUrl`: `/calls/<callId>/recording` if the call was recorded, else `null`.

Filters (all optional, combinable):
- `from` (inclusive) / `to` (exclusive): ISO 8601 times on `started_at`. `from` must be before
  `to`.
- `direction`: `incoming | outgoing | internal`. `outcome`: `answered | busy | no_answer | failed
  | blocked`.
- `extension`: legs from or to that extension number.
- `number`: digits found anywhere in `fromNumber`, `toNumber` or `did`. Non-digits are dropped
  first, so `(201) 555-01` and `+1201555` work. At least one digit.

The query is the contract's search shape, with the numbers expression copied exactly, so the
indexes in `20261109000000_course_spec_telephony.sql` serve it. Checked with `EXPLAIN`: the
trigram index matches the expression. On the near-empty dev table the planner picks the
`(tenant_id, started_at)` index instead, which is right at that size.

## Paging

Newest first, keyset paging on `(started_at, id)` for calls and `(created_at, id)` for
voicemails: `limit` 1-200 (default 50), and `nextCursor` is passed back as `cursor`. It is `null`
on the last page.

- Keyset instead of OFFSET: stays fast deep into millions of CDRs, and calls arriving while
  someone pages don't shift rows between pages.
- The cursor is opaque (base64url of `timestamp|id`). The timestamp is Postgres text with
  **microseconds**. A JS `Date` has milliseconds only, so a cursor built from it would skip or
  repeat legs that start in the same millisecond (tested with three legs at one instant).
- A bad cursor is 400 `invalid_request`.

## Voicemail

voicemail = `{ id, mailboxId, mailboxName, callerNumber, callId, heard, durationMs, createdAt,
audioUrl }`
- `heard: false` = new, `true` = saved (Cisco Unity terms used by `*98`). The web and the phone
  share the row, so each sees the other's changes at once. `PATCH` takes exactly `{ heard }`.
- Playing the audio does not mark it heard (the UI sends the `PATCH`, as with email "read").
- `DELETE` removes the message, its `media` row and its object. Deleting the media row cascades
  to the voicemail, so both go in one statement; the object goes after the commit.
- **Deleting a mailbox** now also deletes its voicemails' media rows and objects. It used to
  leave them behind (a gap in the team doc).
- Still open: `*98` key 3 deletes only the `voicemails` row (spec-transition S13), so audio
  deleted by phone stays until a cleanup job exists.

## Who sees what (`src/visibility.ts`)

| | Owner | Staff |
|---|---|---|
| Calls, legs, recordings | all | calls where one of their extensions (`extensions.user_id`) is `from_extension` or `to_extension` on any leg. Such a call is shown whole, including its external legs |
| Voicemails | all | mailboxes they own (`mailboxes.owner_user_id`) and their extensions' mailboxes (`extensions.mailbox_id`); they may mark and delete those |
| Settings | yes | yes (read-only) |
| `GET /media/...` (step 6) | yes | no (owner-only) |

Everything else is 404, like another account's ids (step 3 rule 2). A staff member with no
extensions sees no calls.

Why: the course spec doesn't define staff access. This follows what a desk phone shows (its own
calls, its own mailbox, as `*98` does) and keeps other people's voicemail private. If staff
should see the whole account's history, drop the `visibleExtensions` filter.

## Settings: read-only

`GET /settings` = `{ recordCalls, intlCalling, includedUsMinutes, includedExtensions,
extraExtensions }` from `tenant_settings`. An account without a row gets all false/0.

CLAUDE.md §11 had `PUT /settings {record_calls}`, but that predates the course spec. Call
recording and international calling are **paid add-ons** (docs/billing-flows.md §2-§3). Turning
one on means a prorated charge and then the flag; turning it off means it keeps working until the
paid period ends. A free toggle here would bypass both. The add-on purchase routes (billing,
not built yet) will write these flags. Nothing else in `tenant_settings` is customer-editable.

## Tests (`test/history.test.ts`)

- Without a DB: every route needs login.
- With Postgres: ordering and fields (no internal columns), each filter and combinations, paging
  across a tie of three legs at one microsecond, bad queries (cursor, enum, extension, number
  without digits, from ≥ to, limit), staff visibility (own extension, none, other staff's calls),
  other accounts, one call with its legs, recording access, voicemail filters / paging / staff
  scope, `PATCH` (strict body), delete removing row + media + object, mailbox delete cleaning up
  audio, settings defaults and values, no `PUT /settings`.
