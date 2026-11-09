# From phase-1 assumptions to the course spec (telephony)

**Who this is for:** anyone who built against the phase-1 telephony design (data model, Kamailio,
Asterisk, ARI app). It lists what the course spec (grading site, Project + Course Services tabs,
read 2026-11-08) changed, what was rebuilt on 2026-11-09, which decisions were taken, and what is
still unverified.

**If you work on the API or web:** read [telephony-contract.md](telephony-contract.md). It is the
contract between your code and the call path: tables, JSON formats, who writes what, and the SIP
behaviour the softphone must have.

---

## 1. What the spec changed

| Phase-1 assumption | Course spec | Consequence |
|---|---|---|
| A4: every call offers every codec | "A phone may support only one of PCMU, PCMA, G.729, G.723.1, or Opus; calls between any two must work" | rtpengine now transcodes on **every** leg type, not only the carrier leg |
| A5: inbound only | Outgoing PSTN calls through two vendors (digest auth); extension-to-extension dialing; forwarding and simultaneous ring to external numbers | New Kamailio routes (`FROM_DEVICE`, `TO_VENDOR`) and ARI flows (`device.ts`, `pstn.ts`); each external leg is a charged CDR row |
| "Staff users" with one browser each | **Extensions**: number per account, SIP credentials, mailbox, forwarding (always/busy/no answer), external numbers. "Any number of phones register"; a call rings all of them | New `extensions` table; Kamailio forks to every contact, and each branch has its own media leg |
| Only browsers (WS) and test UDP phones | Desk phones find us via SRV `_sip._udp` and `_sips._tcp`; TLS phones use SRTP-SDES | Kamailio TLS listener (5061) and an `staff_tls` leg |
| IVR → ring group / voicemail / user | Routing to extension, ring group, IVR menu, voicemail, business-hours schedule or external number. IVR has timeout, invalid-input and repeat. Business hours use the account's time zone. Caller blocklist | Generic `Destination` JSON in `services/shared` and a router in the ARI app |
| Hold + call waiting | Hold **and transfer (blind + attended)** from desk phones and the softphone; `*98` voicemail with the Cisco Unity key map | ARI-controlled REFER handling (`conversation.ts`) and `vm-access.ts` |
| `calls` row per call | Per-leg CDRs with direction, numbers, DID, extensions, times, 30/6 billable duration, outcome (answered/busy/no answer/failed/blocked), vendor, cost, charge; included minutes; past-due blocking | `cdrs` (insert-only), `rate_decks`, `call_pricing`, `usage_periods` |
| Grade = fault tolerance | Grade = simulated customers under load: failed/**silent**/misrouted legs, failed registrations, p95 SIP response time, p95 post-dial delay, outages | The bottleneck work in §4 below |

The carrier sends SIP from `130.245.136.142`. The SIP domain is `group-4.cse356.compas.cs.stonybrook.edu`
(`sip_domain`; it was `pbx.local`). Vendors: `us-vendor.` / `intl-vendor.cse356.compas.cs.stonybrook.edu`.

## 2. What changed, per component

### API (`services/api`, ported after merging main's backend foundation #3)
- **New:** `/extensions` CRUD, which creates the extension, its SIP account (`kamailio.subscriber`
  with `tenant_id` / `extension_id`) and by default its mailbox, in one transaction.
- **Changed:**
  - `/staff` creates logins only;
  - `/me/sip-credentials?extensionId=` works for any user of the account;
  - ring group `memberIds` are extensions, `noAnswerDestination` replaces `fallbackMailboxId`;
  - IVR `config` and `PUT /numbers/:id/route` use Destinations. The phase-1 inputs are still
    accepted.
- **In-use checks:** "still in use" (409) covers every place a destination can be stored
  (`destinationUsages` in `references.ts`).
- **Tests:** API tests updated plus a new `extensions.test.ts`. They can run without docker via
  `node dev/pglite-server.mjs` (see its header).

### Database (migration `20261109000000_course_spec_telephony.sql`)
- **New:** `extensions`, `business_hours`, `blocked_numbers`, `cdrs`, `rate_decks`, `call_pricing`
  (one row), `usage_periods`, and the view `kamailio_did_tenant`.
- **Changed:**
  - `tenants`: added `timezone` and `status` (active/past_due).
  - `tenant_settings`: added `intl_calling` and `included_us_minutes`.
  - `phone_numbers`: added `destination`, `kind` (local/toll_free), `incoming_cost_per_min` and
    `paid_until`.
  - `ring_groups`: added `no_answer_destination`.
  - `ring_group_members` is now keyed by **extension**, not user.
  - `voicemails`: added `caller_number`; `call_id` now refers to `cdrs.call_id` (no FK).
  - `media`: added `call_id` (a recording points at its call).
  - `kamailio.subscriber`: added `tenant_id` and `extension_id`
    (`db/kamailio/pbx-subscriber-columns.sql`).
- **Removed:** the `calls` table and the `call_disposition` type.
- **Deprecated:** `users.sip_username` (SIP accounts belong to extensions) and
  `ring_groups.fallback_mailbox_id` (use `no_answer_destination`; the migration copied the values
  over).
- **Triggers:** `NOTIFY pbx_config '<tenant id>'` on every routing/account change, and
  `NOTIFY pbx_rates` when rates change.
- **Shared library fix (affects the API):** `createDb()` used `postgres.camel`, which also
  camelCases keys **inside jsonb values**. Phase-1 IVR `on_timeout` silently became `onTimeout`
  and was dropped. Now only column names are transformed.

### Kamailio ([kamailio.cfg.j2](../telephony/kamailio/kamailio.cfg.j2))
- **Registrations:**
  - Stored in memory (`usrloc db_mode=0`) and replicated between edges with `dmq_usrloc`; a
    restarting edge pulls a full copy from its peer.
  - Unlimited contacts per extension (the phase-1 one-contact rule is gone).
- **Database access:** read-only. Auth (`auth_db`) and the DID→account lookup (`sqlops` + `htable`
  cache) use `kamailio_db_ro_url`.
- **Device calls:** `FROM_DEVICE` handles INVITEs from phones. It runs digest auth (407), adds
  `X-PBX-Src: device` and `X-PBX-User: <sip user>`, and anchors media with per-transport flags.
- **Vendor legs:** `TO_VENDOR` handles Asterisk → vendor legs (Asterisk answers the vendor's
  401/407 itself).
- **Ringing devices:** `TO_DEVICES` forks to every contact of the extension.
  - The `DEV_BRANCH` and `DEV_REPLY` routes decide WS/TLS/UDP **per branch** (branch flags).
  - Each branch gets its own rtpengine media leg (`via-branch=extra` keyed by
    `$T_branch_idx`); without that, forked offers overwrite each other and the answering phone
    gets no audio.
- **Codecs:** one set of rtpengine flags per leg type (carrier, vendor, staff_udp, staff_tls,
  staff_ws):
  - toward Asterisk: always PCMU + telephone-event;
  - toward everyone else: PCMU plus PCMA, G.729, G.723.1 and Opus offered;
  - toward browsers: PCMU only, so the browser leg never transcodes.
- **TLS:** `listen=tls:<public>:5061`, `tls.cfg`, and a self-signed certificate until a real one
  is dropped in.
- **pbx node choice:** dispatcher algorithm 7 hashes on the account id: from the subscriber row
  (`load_credentials`) for phones, from the DID lookup for carrier calls. It falls back to
  round-robin when the account is unknown.
- **pike:** course tester ranges (`trusted_tester_cidrs`) are exempt. Forged `X-PBX-*` headers
  from outside are stripped.

### rtpengine ([rtpengine.conf.j2](../telephony/rtpengine/rtpengine.conf.j2))
- Kernel forwarding (`table = 0`, `rtpengine-kernel-dkms`), with automatic fallback to userspace.
- `num-threads` = vCPUs.
- Can run on a dedicated `media` inventory group. Kamailio's `rtpengine_sock` follows it.

### Asterisk ([pjsip.conf.j2](../telephony/asterisk/pjsip.conf.j2), [extensions.conf.j2](../telephony/asterisk/extensions.conf.j2))
- A `vendor-<us|intl>-<edge trunk>` endpoint per edge, with `outbound_proxy` = that edge and
  `outbound_auth` = vendor credentials (`vault_vendor_*`).
- The dialplan matches `_[+*#0-9]!` (so `*98` and extension numbers reach Stasis) and passes
  `Stasis(pbx-app,<X-PBX-Src>,<X-PBX-User>)`.
- `allow_transfer=yes`; the ARI app sets `PJSIP_TRANSFER_HANDLING()=ari-only` on bridged
  channels.
- `rtp_timeout` lowered from 60 s to 30 s (a dead media path ends sooner).

### ARI app (`services/ari-app`)
Rewritten around:
- **Entry flows:**
  - [inbound.ts](../services/ari-app/src/inbound.ts): carrier calls. Sends 180 first, then
    blocklist, then routing.
  - [device.ts](../services/ari-app/src/device.ts): calls from phones (`*98`, extension number,
    PSTN).
- **Routing:**
  - [router.ts](../services/ari-app/src/router.ts): `Destination` chain with a hop limit, plus
    extension forwarding.
  - [ring.ts](../services/ari-app/src/ring.ts): devices + external numbers at once, first answer
    wins, trunk fallback, child CDR per external leg.
  - [pstn.ts](../services/ari-app/src/pstn.ts): vendor choice, past-due and international
    blocking, caller ID, rating inputs.
- **Connected calls:** [conversation.ts](../services/ari-app/src/conversation.ts) handles the
  bridge, hold→MOH in both directions, recording, and blind/attended transfer.
- **Voicemail:** [vm-access.ts](../services/ari-app/src/vm-access.ts) (`*98` Unity conversation)
  and [voicemail.ts](../services/ari-app/src/voicemail.ts) (leaving a message).
- **Performance plumbing:**
  - [cache.ts](../services/ari-app/src/cache.ts): per-node account snapshots with
    NOTIFY-driven invalidation and a 30 s TTL.
  - [cdr.ts](../services/ari-app/src/cdr.ts): durable spool plus batched, rated, idempotent
    inserts.
  - [legs.ts](../services/ari-app/src/legs.ts): leg answer/end tracking.
  - [ari/events.ts](../services/ari-app/src/ari/events.ts): event bus indexed by channel.
- **Rate import:** `npm run rates:import -w @pbx/ari-app -- us us-vendor-rates.csv` (same for
  `intl`).

### Removed / superseded
- `services/ari-app/src/hold.ts` (now part of `conversation.ts`).
- The `calls` table.
- `save("location","0x04")`.
- Phase-1 decisions 7 (one contact per user) and 16-17 in [phase1.md](phase1.md).

## 3. Decisions taken in this session

Change any of these by editing the code they point at. Each is small and local.

| # | Decision | Why |
|---|---|---|
| S1 | **Asterisk stays PCMU-only; rtpengine transcodes every other codec** | Prompts, MOH, recording and voicemail need decoded audio in Asterisk; free Asterisk codec modules don't cover G.723.1/Opus. Cost: G.729↔G.729 calls transcode twice (see N1) |
| S2 | **Kamailio forks to devices; the ARI app originates external numbers** | Kamailio already knows every contact and cancels losers. External numbers need a vendor, a caller ID check and a CDR row of their own |
| S3 | **"Busy" = every device answered 486/603** (no server-side busy state) | Keeps call waiting; a busy desk phone answers 486 itself. Busy → `forward_busy`; anything else unanswered → `forward_no_answer` → voicemail |
| S4 | **Transfers handled by the ARI app (`ari-only`)**, not by Asterisk's built-in REFER handling | Our calls live in ARI bridges. Letting Asterisk move channels would break the app's call state and CDRs |
| S5 | **Tenant-affinity dispatch** (all of an account's calls on one Asterisk, failover in hash order) | Attended transfer (Replaces) needs both calls on the same Asterisk |
| S6 | **Registrations in memory + DMQ**, not in Postgres | Takes the database off the REGISTER and ringing path (B1) |
| S7 | **CDRs written once, at hangup, through a local spool** | Removes three primary-DB writes from each call's critical path. Insert-only rows are cheaper for "millions of calls" |
| S8 | **CDR outcome = whether a person answered.** Voicemail is `voicemail=true` with outcome `no_answer`; billing still counts our answer time | The spec's outcome list has no "voicemail"; the carrier bills from our answer (IVR/voicemail), so toll-free charges follow it |
| S9 | **Incoming toll-free is billed from OUR answer** (IVR/voicemail included) | That's when DIDWW starts charging us |
| S10 | **Forwarding, simultaneous ring and transfer legs present the DID that was called** as caller ID; phones' outgoing calls present the extension's `caller_id_number` if it is the account's, else the account's first number | "Present one of the account's numbers as caller ID". No owned number → the call fails |
| S11 | **Past due blocks every external leg** (dialed, forwarded, simultaneous ring, transferred); incoming and internal calls keep working | The spec blocks "outgoing calls"; every external leg is an outgoing call we pay for |
| S12 | **`*98` identifies the mailbox by the calling extension; no PIN** | The phone is already digest-authenticated as that extension |
| S13 | **Voicemail "saved" = `heard=true`; delete = row deleted** | Matches the web inbox flag; the object stays in the store (cleanup is a backend job) |
| S14 | **US vs international by NANP area code**: Canada and Caribbean → international; US territories and toll-free → US | Spec: "International vendor: everything else, including non-US +1 countries". [VERIFY] against the imported US rate deck |
| S15 | **Default prices** in `call_pricing`: US $0.05/min, incoming toll-free $0.055, international 5× vendor rate (min $0.06). DB CHECKs enforce the ceilings | Under the spec ceilings with margin. Business can change them; the CHECKs stop an accidental overcharge ("customers leave over overcharges") |
| S16 | **Vendor Request-URI is `+E.164`** (`vendor_number_format`) | Unknown vendor expectation; one variable to flip |

## 4. Load bottlenecks: status

| | Bottleneck (phase 1) | Status | What changed | Evidence |
|---|---|---|---|---|
| B1 | REGISTER, auth and lookups on the Patroni primary; 8/4 blocking workers | **Fixed** | usrloc in memory + DMQ; auth/DID reads via read-only URL; 16/16 workers | `configs.test.ts` B1; `kamailio -c` |
| B2 | pike would throttle the course simulators | **Fixed** (ranges [VERIFY]) | `trusted_tester_cidrs` bypass pike; density 30→200 for others | `configs.test.ts` B2 |
| B3 | Userspace-only media on the signaling VMs | **Mitigated** | Kernel forwarding + threads; optional `media` group | `configs.test.ts` B3 |
| B4 | PCMU-only Asterisk forces transcoding | **Accepted** (S1) | Correct codec offers on every leg; capacity must be measured (N1) | `configs.test.ts` codec tests |
| B5 | Round-robin dispatch breaks attended transfer | **Fixed** | Hash on account (alg 7) | `configs.test.ts` B5; `hold-transfer.test.ts` |
| B6 | DB queries before answer; 3 writes per call | **Fixed** | Config cache + NOTIFY; 180 before any lookup; spooled batched CDRs | `routing.test.ts` PDD; `cdr-billing.test.ts` |
| B7 | ARI event fan-out O(n²); serial originates | **Fixed** | Indexed bus; parallel originate | `units.test.ts` "dispatch cost does not grow" |
| B8 | Recording uses a mixing bridge | **Accepted** | Unchanged: softmix of two PCMU streams is cheap next to transcoding. Measure with recording on | — |
| B9 | No rtpengine session failover | **Accepted** | Needs a floating IP (unknown on the platform). `rtp_timeout` 60→30 s so dead calls end and free the phone sooner | — |

## 5. New bottlenecks and risks surfaced

| | What | Impact | Mitigation / next step |
|---|---|---|---|
| N1 | **Transcoding CPU with single-codec phones.** With 5 codecs spread evenly, ~80% of legs transcode; a G.729↔G.723.1 call costs two encodes + two decodes. G.723.1 and Opus encoding are the expensive ones | First CPU wall, on rtpengine | Measure with the SIPp codec matrix (`loadtest/sipp`, uac_inbound_codec.xml); scale via the `media` group |
| N2 | **Both edges restart at once ⇒ registrations gone** (memory only) | Calls to phones fail until they re-register (≤ max_expires 600 s; phones usually retry sooner) | Accepted; restart edges one at a time (`serial: 1`) |
| N3 | **Replica lag on new SIP credentials** once T1 points `db_ro_port` at replicas | A brand-new extension's first REGISTER may get 401 again (phones retry) | Keep lag low; or point auth at the primary port if this shows up in failures |
| N4 | **Tenant-affinity hot spot**: a huge account lands on one pbx node | That node saturates while others idle | Fine with many small simulated businesses; watch `pbx_active_calls` per node |
| N5 | **`usage_periods` row lock per account** | CDR batches for the same account serialize across nodes | Tiny at expected rates; the batch insert keeps it to one transaction |
| N6 | **Kamailio DID lookup on a cache miss is synchronous** (2 s DB timeout) | +up to 2 s post-dial delay on the first call per DID per 5 min if the DB is down | Failures are cached too; read-only replica endpoint |
| N7 | **Single Node.js event loop per pbx node** | CPU-bound at very high calls per second | Add pbx nodes (dispatcher list) |
| N8 | **All writes still on one Postgres primary** (CDRs + API + billing) | API p95 latency and CDR inserts compete | CDRs are batched/insert-only. Next: partition `cdrs` by month; API reads from replicas |
| N9 | **ARI `ari-only` transfer handling is new in Asterisk 22.1+** | Transfers fail if the field names or option differ | [VERIFY] first thing on a VM. Fallback: Asterisk's native transfer with `TRANSFER_CONTEXT` |
| N10 | **The all-in-one inventory now needs `vault_vendor_*`** and a TLS cert path | Deploy fails without them | Added to `vault.yml.example`; self-signed cert task |

## 6. Verified here vs. needs a VM

**Verified locally (2026-11-09):**
- `npm test`: 169 tests.
  - The call flows run against a fake Asterisk and a real Postgres engine (PGlite) with the real
    migrations, cache, CDR writer and rating code.
  - [telephony-tests.md](telephony-tests.md) maps each spec section to its tests.
- Typecheck: app and tests.
- Every telephony template renders for a 2-edge/2-pbx inventory.
- `kamailio -c` (6.0.8) passes on both rendered edge configs. The check does catch unknown
  functions, unknown module parameters and wrong argument counts (verified by injecting each).

**[VERIFY] on the first VM deploy** (step-by-step checks: [cloud-deploy.md](cloud-deploy.md) §4) (nothing here ran against real Asterisk, rtpengine or SIP
endpoints):
1. Transfers:
   - `ChannelTransfer` event fields and `POST /channels/{id}/transfer_progress` (Asterisk
     22.11);
   - that `PJSIP_TRANSFER_HANDLING()` can be set via ARI channel variables.
2. Media: rtpengine `via-branch=extra` with forking (each branch gets its own leg; the answering
   one has audio).
3. Media: rtpengine flags `RTP/SAVP DTLS=off` produce SDES crypto toward TLS phones.
4. Media: `rtpengine --codecs` shows encode+decode for G723, G729, opus.
5. Registrations: DMQ replication between two edges (REGISTER on edge-1, call routed via edge-2).
6. Vendors: what they expect in the Request-URI (+E.164?) and caller ID; their source IPs for
   in-dialog requests.
7. Network: `trusted_tester_cidrs`, from Kamailio logs once Traffic is on.
8. Carrier: DIDWW trunk config (R-URI user format, codec selection, trunk group with both edges).
9. Asterisk: `PJSIP_HEADER(read,X-PBX-...)` values reach Stasis args; cause 21 ↔ 403 and cause
   34 ↔ 503 mappings.
