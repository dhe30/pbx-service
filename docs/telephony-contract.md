# Telephony ↔ API/web contract

What the call path (Kamailio + Asterisk/ARI app) reads and writes, so the API and web can be built
against it. Purchases, payments and invoicing (Stripe, proration, past due): [billing-flows.md](billing-flows.md). The schema is in `db/migrations/` (latest:
`20261109000000_course_spec_telephony.sql`). Shared types, zod schemas and rules are in
`services/shared` (import from `@pbx/shared`). Why it looks like this:
[spec-transition.md](spec-transition.md).

**Rule:** the telephony side **only reads** account configuration and **only writes** `cdrs`,
`usage_periods`, `media` and `voicemails` rows (plus `voicemails` updates and deletes from `*98`).
Everything else is written by the API.

## 1. Who writes what

| Table / column | Written by | Read by telephony for |
|---|---|---|
| `tenants.timezone` (IANA, fixed after signup), `tenants.status` (`active` / `past_due`) | API / billing | business hours, billing period, outgoing-call blocking |
| `tenant_settings.record_calls`, `.intl_calling`, `.included_us_minutes` | API (add-ons, plan) | recording, international blocking, included US minutes |
| `extensions` + `kamailio.subscriber` | API | ringing, forwarding, outgoing calls, auth |
| `phone_numbers.destination`, `.kind`, `.incoming_cost_per_min`, `.paid_until`, `.status` | API (purchase, routing, release) | where calls to a DID go; toll-free billing |
| `ivr_menus`, `ring_groups`, `ring_group_members`, `mailboxes`, `business_hours`, `blocked_numbers` | API | routing |
| `call_pricing` (1 row), `rate_decks` | API / ops (`rates:import`) | rating every leg |
| `cdrs`, `usage_periods` | **ARI app** (insert-only) | — (API reads them: history, search, invoices) |
| `media` (kind recording/voicemail), `voicemails` | **ARI app** inserts; API and `*98` update/delete | — |

**Freshness:** every write to the account-config tables fires `NOTIFY pbx_config '<tenant id>'`
(triggers), and every pbx node drops its cached copy of that account. Changes take effect on the
next call, within about a second. If a notification is lost, a snapshot is still never older than
`CONFIG_TTL_SEC` (30 s). So "unblock within one minute of payment" only needs the API to set
`tenants.status = 'active'`.

## 2. Extensions (spec §3)

Create one, in **one transaction**:
```sql
insert into extensions (tenant_id, number, name, sip_username, mailbox_id, ring_timeout_sec,
                        forward_always, forward_busy, forward_no_answer, external_numbers,
                        caller_id_number, user_id) values (...);
insert into kamailio.subscriber (username, domain, password, tenant_id, extension_id)
  values (<sip_username>, <sip_domain>, <generated password>, <tenant_id>, <extension id>);
```
- `number`: digits, unique within the account (`101`). `sip_username`: **globally** unique (one
  SIP domain for every account), e.g. generated `t<short-tenant>-<number>`. The SIP password is
  stored in plaintext because the spec says the API returns it (`auth_db calculate_ha1=yes`).
- `tenant_id` / `extension_id` on the subscriber row are what keep an account's calls on one pbx
  node. Leave them out and calls still work, but attended transfer can break.
- `forward_*`: `null`, `{"type":"extension","id":"<uuid>"}` or
  `{"type":"external","number":"+12015550123"}` (`ForwardDestinationSchema`).
- `external_numbers`: E.164 array, rung together with the extension's devices; each is a charged
  outgoing leg.
- `caller_id_number`: one of the account's numbers, used for outgoing calls (otherwise the
  account's first number is used).
- Delete: delete the subscriber row and the extension row (same transaction). Its registrations
  expire on their own.
- **SIP credentials returned by the API** (per extension): `username` = `sip_username`, `password`,
  `domain` = `sip_domain` (`group-4.cse356.compas.cs.stonybrook.edu`), and for the softphone
  `wsUri` = `wss://<web host>/ws`. Desk phones need nothing else: they find
  `_sip._udp` / `_sips._tcp` SRV records for the domain.

## 3. Destinations (spec §3: number routing, IVR, ring groups, business hours)

Every "where does the call go" value is this JSON (`DestinationSchema` in
`services/shared/src/ivr-config.ts`; validate with it on write):
```json
{"type":"extension","id":"<uuid>"}       {"type":"ring_group","id":"<uuid>"}
{"type":"ivr_menu","id":"<uuid>"}        {"type":"voicemail","id":"<mailbox uuid>"}
{"type":"business_hours","id":"<uuid>"}  {"type":"external","number":"+E.164"}
{"type":"hangup"}
```
| Where | Column |
|---|---|
| Number routing | `phone_numbers.destination` (extension / ring group / IVR menu / business hours; the others work too) |
| IVR | `ivr_menus.config` (below) |
| Ring group no-answer | `ring_groups.no_answer_destination` |
| Business hours | `business_hours.open_destination` / `.closed_destination` |

A deleted target makes the call hang up (logged); it doesn't crash the call. Chains are followed up
to 10 hops (loop guard).

**IVR** (`ivr_menus.timeout_sec`, `.max_retries`, `.greeting_media_id`, `.config`):
```json
{ "options": { "1": <Destination>, "2": <Destination>, "#": <Destination> },
  "timeout": <Destination>,      // after max_retries plays without valid input (omitted = hang up)
  "invalid": <Destination>,      // on an invalid digit (omitted = "invalid option" + replay)
  "repeat_digit": "*" }          // replays the menu, doesn't count as a retry (default "*")
```
The phase-1 format (`{"action":..,"target":..}` and `on_timeout`) is still accepted.

**Ring groups**: `strategy` `all` (`ring_timeout_sec` = total ring time) or `sequential` (each
member rings `ring_timeout_sec`). Members (`ring_group_members.extension_id`, `position`) ring
their devices **and** their external numbers.

**Business hours**: `schedule` = `{"intervals":[{"day":1,"start":"09:00","end":"17:00"}, ...]}`.
`day` 0 = Sunday, times are in the account's time zone, `end <= start` runs past midnight, and
`"24:00"` is allowed (`WeeklyScheduleSchema`; evaluate with `isOpen()` for previews).

**Blocklist**: `blocked_numbers(tenant_id, number E.164)`. Listed callers are rejected (403) and
the CDR outcome is `blocked`.

## 4. Numbers

- `did` is E.164 with `+`. `kind` is `local` or `toll_free` (from the DIDWW DID group).
  `incoming_cost_per_min` is what DIDWW charges us for incoming toll-free on that number
  (`null` = `call_pricing.toll_free_in_cost_per_min`).
- Releasing: set `status='released'` and keep `paid_until` = end of the paid period. Calls keep
  routing until then (the `kamailio_did_tenant` view and the ARI app both honour `paid_until`).
- Each DID must be assigned to our DIDWW inbound trunk, which points at our edges. That's done in
  the purchase flow.

## 5. Voicemail (spec §3, §6)

- `voicemails.heard = false` is "new", `true` is "saved" (`*98` key 2). Deleting = `DELETE` the
  row (`*98` key 3 does the same). Both places show the other's changes immediately.
- `voicemails.caller_number`: who left it. `call_id` = `cdrs.call_id` of that call (no FK: the
  voicemail may be filed before the CDR).
- Audio objects: `media.object_key`, kind `voicemail` / `recording`, format `wav` = **16-bit PCM
  mono 8 kHz** (Asterisk's `wav`), which is what the spec requires the API to serve. Greetings
  uploaded by customers must be stored in the same format (`media.kind = 'greeting'`, then
  `ivr_menus.greeting_media_id` / `mailboxes.greeting_media_id`).
- Recordings (add-on `record_calls`): `media.call_id` = `cdrs.call_id`, so join on it for call
  history.

## 6. CDRs (spec §5) and search (spec §4)

One row per **leg**, written by the ARI app within about a second of the call ending, never
updated:
- The **main row** of a call has `parent_id IS NULL`. Its `direction` is `incoming` (PSTN → our
  DID), `outgoing` (phone → PSTN; this row *is* the vendor leg) or `internal` (extension ↔
  extension, `*98`).
- **Every extra leg we placed to an external number** (simultaneous ring, forwarding, IVR →
  external, transfer to a number) is its own row: `direction='outgoing'`, `parent_id` = main
  row, same `call_id`, with its own vendor, cost and charge.
- Columns: `from_number`, `to_number`, `did` (incoming DID, or caller ID used outgoing),
  `from_extension`, `to_extension` (who answered or was rung), `started_at`, `answered_at`,
  `ended_at`, `billable_sec` (30/6), `outcome` (`answered|busy|no_answer|failed|blocked`),
  `vendor` (`us|intl`), `rate_prefix`, `cost` (what we pay: vendor rate × answered seconds),
  `charge` (what we bill), `included_sec` (plan US seconds consumed), `voicemail` (caller reached
  voicemail).
- Outcome = did a person answer. A call that went to voicemail is `no_answer` + `voicemail=true`.
  An incoming call's `answered_at` is when *we* answered (IVR, voicemail or bridge), because
  that's when DIDWW starts billing us.

Search query shape (the indexes are built for it), newest first with keyset paging:
```sql
select * from cdrs
 where tenant_id = $1
   and started_at between $from and $to                   -- optional
   and direction = $dir                                   -- optional
   and outcome = $outcome                                 -- optional
   and (from_extension = $ext or to_extension = $ext)     -- optional
   and (coalesce(from_number,'') || ' ' || coalesce(to_number,'') || ' ' || coalesce(did,''))
       like '%' || $digits || '%'                         -- optional; trigram index
   and (started_at, id) < ($cursor_started_at, $cursor_id)  -- next page
 order by started_at desc, id desc limit 50;
```
Use the expression exactly as written (it must match the index).

## 7. Prices, rating, usage

- `call_pricing` (one row): `us_per_min`, `toll_free_in_per_min`, `intl_multiplier`,
  `intl_min_per_min`, `toll_free_in_cost_per_min`. DB CHECKs enforce the spec ceilings. Show
  per-minute prices with `intlRetailPerMin(vendorRate, pricing)` from `@pbx/shared`, so the API
  displays exactly what the ARI app charges.
- `rate_decks(vendor, prefix, destination, per_min)`: the vendor CSVs. Import with
  `DATABASE_URL=... npm run rates:import -w @pbx/ari-app -- us us-vendor-rates.csv` (and `intl`).
  Longest prefix wins (`PrefixTable`).
- `usage_periods(tenant_id, period_start, included_sec_used)`: included US seconds used per
  billing period. `period_start` is the local date from
  `billingPeriod(tz, tenants.created_at, at)` in `@pbx/shared`. Invoices: sum `cdrs.charge` for
  legs whose `started_at` falls in the ended period; "included minutes used" =
  `usage_periods.included_sec_used / 60`.
- Rules (all in `rateLeg()`): internal and non-toll-free incoming are free; US legs use included
  seconds first; international and incoming toll-free are always per minute; unanswered legs
  bill 0.

## 8. Softphone (spec §4) — SIP behaviour behind the required `data-testid`s

The softphone is SIP.js over WebSocket. The test harness drives a real browser, so a long-lived
WebSocket is fine (spec: "WebRTC, any signaling").

| testid | SIP behaviour the server side expects |
|---|---|
| `softphone-extension` | Choose which extension's credentials to `REGISTER` with (`sip:<sip_username>@<sip_domain>`, `wss://<host>/ws`). Several browsers/phones may register the same extension; all ring |
| `softphone-number` + `softphone-call` | `INVITE sip:<what was typed>@<sip_domain>`: an extension number, `*98`, or any number format (10 digits, 1+10, +E.164, 011...). The server normalizes. Kamailio challenges with 407 (SIP.js answers it) |
| `softphone-incoming`, `softphone-answer` | Incoming INVITE (visible only while ringing). With a call already up, answering puts that one on hold (call waiting) |
| `softphone-hangup` | `BYE` / `CANCEL` |
| `softphone-hold` (toggle) | re-INVITE `a=sendonly` / back to `a=sendrecv`. The other party hears music on hold |
| `softphone-transfer-blind` | `REFER` with `Refer-To: sip:<number>@<sip_domain>` on the current call |
| `softphone-transfer-attended` | Hold the current call, then `INVITE` the target as a new call |
| `softphone-transfer-complete` | `REFER` on the **held** call with `Refer-To` = the consult call **with Replaces** (SIP.js `session.refer(otherSession)` builds it) |
| `softphone-dtmf-0..9/star/hash` | RFC 4733 telephone-events (SIP.js `sessionDescriptionHandler.sendDtmf`), **not** SIP INFO |

Codec: let the browser offer its defaults (Opus + PCMU). rtpengine picks PCMU, so the browser leg
never transcodes.

## 9. Account status and add-ons on the call path

| Setting | Effect |
|---|---|
| `tenants.status='past_due'` | Every outgoing external leg is blocked (403 to the phone, CDR `blocked`): dialed calls, forwarding, simultaneous ring, transfers to numbers. Incoming and internal calls still work |
| `tenant_settings.intl_calling=false` | Legs outside the US, **including Canada/Caribbean +1**, are blocked |
| `tenant_settings.record_calls=true` | Connected calls are recorded (one WAV per conversation, continues through hold and transfers) |
