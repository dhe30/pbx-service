# pbx-service: a hosted virtual PBX

A multi-tenant cloud phone system for small businesses, built for the CSE 356 course project.
A business signs up on our website, buys phone numbers, sets up extensions, IVR menus, ring groups
and business hours, and then makes and takes calls from SIP desk phones and a browser softphone.
It pays by card. The system must keep working under load from the course's simulated customers,
and must survive the loss of any single VM.

Production domain: `group-4.cse356.compas.cs.stonybrook.edu` (website, API, WSS softphone and
SIP over UDP/TLS through the `_sip._udp` / `_sips._tcp` SRV records).

**Contents**
1. [Project overview](#1-project-overview)
2. [Running the system](#2-running-the-system)
3. [Scaling and load handling](#3-scaling-and-load-handling)
4. [Design decisions](#4-design-decisions)
5. [Developer guide](#5-developer-guide)
6. [Team process and contributions](#6-team-process-and-contributions)

Deeper documentation lives in [`docs/`](docs/). The full spec and design context is in
[CLAUDE.md](CLAUDE.md). Each section below links to the detailed document for its topic.

---

## 1. Project overview

### What it does

- **Self-service accounts:** signup (business name, time zone, admin login, card), a weekly plan,
  add-ons (extra extensions, international calling, call recording), weekly invoices, and
  blocking of outgoing calls when an account is past due.
- **Numbers:** search and buy local and toll-free numbers from the course DID provider, route
  each number, and release numbers.
- **Call handling:**
  - extensions with any number of registered phones, which all ring at once with the softphone
    and listed external numbers (first answer wins);
  - forwarding (always / busy / no answer);
  - IVR menus, ring groups (all at once or in order), and business hours in the account's time
    zone;
  - voicemail (web inbox and `*98` with the Cisco Unity key map) and a caller blocklist;
  - hold, blind and attended transfer;
  - outgoing calls to US and international numbers through two PSTN vendors;
  - call recording.
- **Records:** one CDR per call leg, rated by longest prefix with 30/6 billing, searchable from
  the API and the website.
- **Codecs:** any two phones can talk, even when each supports only one of PCMU, PCMA, G.729,
  G.723.1 or Opus. rtpengine transcodes.

### Components

| Component | Technology | Where it runs | Role |
|---|---|---|---|
| SIP proxy / registrar | Kamailio 6.0 | edge-1, edge-2 (public) | Registers phones and browsers, authenticates them, routes every SIP request, picks a pbx node |
| Media relay | rtpengine 26.0 | edge-1, edge-2 | Relays all audio, transcodes codecs, terminates WebRTC (ICE, DTLS-SRTP) and SRTP-SDES |
| TLS front end | HAProxy 3.0 | edge-1, edge-2 | HTTPS for the website and API, WSS for the softphone, Let's Encrypt certificate |
| Media server | Asterisk 22 LTS | pbx-1, pbx-2 (private) | Bridges, prompts, music on hold, recording, DTMF. No dialplan logic |
| Call control | Node/TypeScript ARI app (`services/ari-app`) | pbx-1, pbx-2 | IVR, ring groups, forwarding, voicemail, transfers, CDRs and rating |
| API | Node/TypeScript, Fastify (`services/api`) | app-1, app-2 | Accounts, numbers, configuration, billing, CDR search, media. OpenAPI 3.1 at `/openapi.json` |
| Website + softphone | React, Vite, SIP.js (`services/web`) | app-1, app-2 (nginx) | Dashboard and the browser phone |
| Database | Postgres 16 + Patroni + etcd | db-1..3 | Accounts, configuration, CDRs, invoices; Kamailio's `subscriber` table |
| Object store | Garage v2 (S3 API), 3 copies | db-1..3 | Greetings, voicemail, recordings |
| Local DB/S3 proxy | HAProxy (`pbx-dbproxy`) | every edge, pbx and app node | `127.0.0.1:5432` always reaches the current Patroni primary |
| Monitoring | Prometheus, Alertmanager, Grafana | mon-1 | Metrics from every node, alerts |

### How the pieces interact

```
           desk phones (UDP / TLS)        browsers (HTTPS + WSS)        course services
                     |                            |                     |       |       |
                     |  SIP + RTP/SRTP            |                DID provider | payment gateway
                     v                            v                (carrier SIP)|  (Stripe clone)
  +--------------------------- edge-1 / edge-2 (public IPs) ------------------+ |       ^
  |  Kamailio (registrar, routing) <--DMQ-->  peer edge                       | |       |
  |  rtpengine (all media, transcoding, WebRTC)                               | |       |
  |  HAProxy :443 (HTTPS -> API/web, WSS -> Kamailio)                         |<+       |
  +------|-------------------------|----------------------------|-------------+         |
         | SIP (dispatcher,        | RTP, PCMU only            | HTTP                  |
         |  hash on account)       |                            v                       |
  +------v-------------------------v-----+           +-----------------------+         |
  | pbx-1 / pbx-2: Asterisk + ARI app    |           | app-1 / app-2:        |---------+
  | (call control, voicemail, recording, |           | API + website         |-- DIDWW API v3 (buy numbers)
  |  CDR spool, vendor legs)             |           | (billing scheduler)   |
  +------|-------------------------------+           +-----------|-----------+
         | SQL + S3 via local proxy                              | SQL + S3 via local proxy
  +------v-------------------------------------------------------v-----------+
  | db-1..3: Postgres + Patroni + etcd, Garage object store (3 copies)       |
  +--------------------------------------------------------------------------+
  outgoing calls: ARI app -> Asterisk -> Kamailio (edge) -> US / international PSTN vendor (digest auth)
```

- **Incoming call:** the DID provider sends an INVITE over UDP from `130.245.136.142` to an edge
  (its trunk group lists both edges). Kamailio looks up the DID's account, then rtpengine
  rewrites the SDP so the Asterisk side is PCMU. The dispatcher sends the call to the pbx node
  chosen for that account. Asterisk passes it to the ARI app (`Stasis`). The app sends 180 at
  once, then follows the number's destination (IVR, ring group, extension...).
- **Ringing staff:** the ARI app originates one channel per extension toward Kamailio. Kamailio
  forks it to every registered device of that extension (browser over WSS, desk phones over UDP
  or TLS), each branch with its own rtpengine media leg. External numbers on the extension get
  their own vendor leg from the ARI app. The first answer wins.
- **Outgoing call:** a phone's INVITE is digest-authenticated by Kamailio and handed to the
  account's pbx node. The ARI app classifies the number, applies past-due and international
  checks and caller ID, and dials the US or international vendor through an edge.
- **Website / API:** browsers reach the API and website through HAProxy on the edges. The API
  writes configuration to Postgres. A trigger sends `NOTIFY pbx_config`, so the ARI apps reload
  that account's cached configuration. The API calls the DID provider to buy numbers and the
  payment gateway to save cards and charge invoices.
- **Audio files:** the ARI app records voicemail and calls to local disk and uploads them to the
  object store. The API streams them to browsers (`GET /media/:id/audio`). The store is never
  public.

---

## 2. Running the system

### 2.1 Dependencies

| For | Needs |
|---|---|
| Local API / web / tests | Node 24 (`.nvmrc`), npm, Docker + docker compose (Postgres, Garage), [dbmate](https://github.com/amacneil/dbmate), ffmpeg (greeting conversion) |
| Telephony config checks | Linux or WSL, Ansible, Kamailio 6.0 binaries (can be extracted from .debs without root; see `telephony/tests/check-configs.sh`), optionally HAProxy |
| Cloud deploy | WSL/Linux control machine with Ansible (`infra/ansible/requirements.yml`), the vault password, an SSH key accepted by the VMs |
| Load / VM tests | SIPp with pcap support (`sip-tester`), `sngrep` on the edges |

### 2.2 Configuration

- **Local dev:** `cp .env.example .env`. Every variable is commented there: `DATABASE_URL`, S3,
  `JWT_SECRET`, DID provider (`DID_PROVIDER_MODE=fake` gives fictional numbers offline), Stripe
  test keys, billing scheduler, `OPERATOR_TOKEN`.
- **Cloud:**
  - `infra/ansible/inventory/production.ini`: VM addresses (private-only VMs are reached through
    edge-1 with ProxyJump).
  - `infra/ansible/group_vars/all/main.yml`: pinned component versions, domain, DID provider
    URL and trunk group, ports.
  - `infra/ansible/group_vars/all/vault.yml`: every secret (DB passwords, ARI password, JWT key,
    S3 keys, vendor digest credentials, Stripe and DIDWW keys, operator token). It is
    Ansible-Vault encrypted. Generate it with `infra/ansible/scripts/new-vault.sh`. Never copy
    the example: the repo is public.
  - The variable contracts between roles are documented in
    [docs/split-contracts.md](docs/split-contracts.md).

### 2.3 Local development (API + website)

```bash
cp .env.example .env
npm install
npm run dev:up              # Postgres + Garage in docker
npm run db:migrate          # app schema (dbmate)
npm run db:kamailio         # Kamailio's subscriber/location tables
npm run dev:s3              # create the Garage bucket + key
npm run build -w @pbx/shared
npm run dev -w @pbx/api     # API on :3000 (tsx watch)
npm run dev -w @pbx/web     # website on Vite; /api is proxied to :3000
npm run dev:down            # stop the containers
```

To run the telephony stack on one VM (Kamailio + rtpengine + Asterisk + ARI app) for call-flow
work, use the all-in-one playbook `infra/ansible/phase1-allinone.yml`. The guides are
[docs/local-vm.md](docs/local-vm.md) (VirtualBox) and [docs/phase1.md](docs/phase1.md).

### 2.4 Cloud deployment

Full runbook: [docs/cloud-deploy.md](docs/cloud-deploy.md) (§1–2 VM and DNS setup, §3 course
services, §4 ordered checks, §5 split deployment).

```bash
cd infra/ansible
ansible-playbook site.yml --ask-vault-pass --limit db   # data tier first; check `patronictl list`
ansible-playbook site.yml --ask-vault-pass              # everything, idempotent
ansible-playbook site.yml --ask-vault-pass --limit app  # later: API + website only
ansible-playbook site.yml --ask-vault-pass --limit pbx  # later: ARI app / Asterisk only
```

`site.yml` updates app, pbx and edge nodes one at a time (`serial: 1`). Each node must pass its
health check (`/ready`, ARI `/health`) before the next one is touched. After adding or replacing
a VM, run the whole playbook, because `pg_hba`, the dispatcher list and the HAProxy backends are
generated from the inventory.

**Start / stop on a node:** everything runs under systemd: `kamailio`, `rtpengine-daemon`,
`haproxy` (edges); `asterisk`, `pbx-ari-app` (pbx); `pbx-api`, `nginx` (app); `patroni`, `etcd`,
`garage` (db); `pbx-dbproxy` on every client node. To drain a pbx node before maintenance, mark it
inactive in the dispatcher on both edges (`kamcmd dispatcher.set_state i 1 sip:<pbx>:5060`) and
wait for its active calls to reach zero.

### 2.5 Testing

```bash
npm test                 # all workspaces: API, shared rules, call-flow spec suite (fake Asterisk + PGlite)
npm run typecheck
npm run test:configs     # render every telephony template + `kamailio -c` + `haproxy -c` (Linux/WSL)
```

- On deployed VMs: SIPp scenarios in [loadtest/sipp/README.md](loadtest/sipp/README.md) cover
  carrier calls per codec, phones placing calls, hold, call waiting and load.
- [docs/telephony-tests.md](docs/telephony-tests.md) maps every course-spec section to its tests.

### 2.6 Assumptions about cloud resources and services

- **VMs:** 10 Clanode (Linode clone) VMs, Debian 13. On 2026-11-11 every VM was 1 vCPU / 2 GB
  (verify-backlog V-P11).
- **Network:**
  - Only the two edges have public IPs, delivered by 1:1 NAT onto the private address, so the
    edges bind the private IP and advertise the public one (V-P10).
  - The platform has **no floating IP** (V-P2), and the group domain has one A record and one
    target per SRV record (V-P1).
  - Private VMs have outbound internet (V-P3).
- **Course services:**
  - DID provider = DIDWW API v3 clone, with an inbound trunk group listing both edges.
  - US and international PSTN vendors use SIP digest auth.
  - Payment gateway = Stripe clone, without webhooks.
  - Vendor and DID provider balances are prepaid. At $0 they stop working.
- Every open assumption has a row in [docs/verify-backlog.md](docs/verify-backlog.md) with how to
  check it. The course grading site is the ground truth.

---

## 3. Scaling and load handling

### 3.1 The problem

Grading is done by simulated businesses that sign up, use the API, and place and receive calls
at an increasing rate. The dashboard counts:
- completed calls per minute;
- failures: failed, **silent** or misrouted legs, and failed registrations;
- p95 SIP response time (REGISTER, INVITE→first response, BYE, re-INVITE);
- p95 post-dial delay;
- API latency and outages.

So the system has to stay **fast** on the call-setup path, **correct** (audio both ways, right
routing, right charges) and **available** (any single VM can die), all at the same time.

Each call uses four kinds of resources, and each kind grows differently with load:

| Resource | Grows with | Where |
|---|---|---|
| SIP signaling (REGISTER, INVITE, re-INVITE, BYE) | registered devices × re-register rate + calls/s × devices per extension | Kamailio (edges) |
| Media (packet relay + transcoding) | concurrent calls × legs per call × transcoding cost of the codec pair | rtpengine (edges) |
| Call control (ARI events, bridges, prompts, recording) | concurrent calls and calls/s | Asterisk + one Node event loop per pbx node |
| Database (config reads, CDR writes, billing, search, API) | calls/s + API requests/s + background billing | one Patroni primary |

### 3.2 Bottlenecks, evidence and changes

The first architecture (phase 1, one VM) was built for inbound calls to browsers. When we
compared it with the course spec on 2026-11-08 ([docs/spec-transition.md](docs/spec-transition.md)
§4–5), we traced every request type through it. For each one we counted the database round
trips, blocking workers and per-call work it causes. Most of the evidence below is that analysis.
Each fix is pinned by an automated test (`services/ari-app/test/`) or a check on the rendered
config, so a later change can't quietly undo it. Load measurements on the deployed VMs are listed
in §3.4 as still to do.

| # | Bottleneck | Evidence | Change | Why it helps |
|---|---|---|---|---|
| B1 | **Registrations and auth on the DB primary.** Phase 1 stored registrations in Postgres (usrloc `db_mode=3`): every REGISTER wrote to the primary, and every call to a staff member read it. Kamailio had 8 UDP / 4 TCP workers, which block during each DB query | Request-path analysis: registrations scale with device count, not calls, and every simulated phone re-registers every few minutes. A primary failover (10–30 s) would have stalled all REGISTERs and all ringing, which the grader counts as failed registrations and failed legs | Registrations in Kamailio memory (`db_mode=0`), replicated between edges with `dmq_usrloc` (a restarted edge pulls a full copy). Auth and DID reads use a **read-only** URL (`db_ro_port` 5433, replicas first). 16/16 workers | REGISTER and lookups never touch the primary. A primary failover no longer affects SIP. Reads spread over replicas. Asserted by `configs.test.ts` (B1) |
| B2 | **pike flood protection vs. the course simulators** | Simulated customers come from a few source IPs at high rates, exactly what pike blocks | `trusted_tester_cidrs` bypass pike. Density limit 30 → 200 for everyone else | Load from the graders isn't dropped as a flood. The public internet still is |
| B3 | **Userspace media on the signaling VMs** | rtpengine and Kamailio share 1-vCPU edges. In userspace, every RTP packet (50 per second per direction per leg) costs a context switch | Kernel forwarding (`table = 0`, `rtpengine-kernel-dkms`, falls back to userspace). `num-threads` = vCPUs. Optional `media` inventory group puts rtpengine on its own VMs | Non-transcoded legs are forwarded in the kernel, which leaves CPU for transcoding and SIP. The `media` group lets media scale separately from signaling |
| B4 / N1 | **Transcoding CPU.** Each phone supports one codec. With five codecs spread evenly, about 80% of legs transcode. G.723.1 and Opus encoding cost the most | Codec analysis. We confirmed the edges can encode and decode all five codecs (`rtpengine --codecs`, V-T1). The carrier only offers PCMU + telephone-event (V-D12) and the US vendor answered PCMU (V-V5), so carrier and vendor legs don't transcode | Accepted design: Asterisk stays PCMU-only and rtpengine transcodes (§4). Capacity is measured with the SIPp codec matrix and scaled with the `media` group | Keeps all transcoding in one horizontally scalable component instead of spreading it over Asterisk and rtpengine |
| B5 | **Round-robin dispatch broke attended transfer** | An attended transfer (`Replaces`) needs both calls on the same Asterisk. With round robin, two calls of the same account landed on different nodes half of the time | Dispatcher algorithm 7 hashes on the **account id** (from the subscriber row for phones, from the DID for carrier calls). Failover follows the hash order | All of an account's calls share one node, so transfers and the account cache work. `hold-transfer.test.ts`, `configs.test.ts` (B5) |
| B6 | **DB on the call-setup path.** Phase 1 ran several queries before answering and wrote 3 rows per call to the primary | Post-dial delay is graded at p95. Any primary hiccup or failover went straight into PDD and failed calls | (a) The ARI app answers with **180 Ringing before any lookup**. (b) Account configuration is read from an **in-memory snapshot** per node (`cache.ts`), invalidated by `NOTIFY pbx_config` with a 30 s TTL. (c) **Nothing is written until hangup:** CDRs go to a durable local spool and are inserted in rated, idempotent batches (`cdr.ts`) | Setup needs no DB round trip after the first call of an account. A DB failover delays CDR inserts but loses no calls or records. `routing.test.ts` (PDD), `cdr-billing.test.ts` |
| B7 | **O(n²) ARI event fan-out and serial originates** | Every ARI event was offered to every active call session, so cost grew with the square of concurrent calls. Ringing N targets one after another added N round trips | Event bus indexed by channel id (`ari/events.ts`). Parallel originate for simultaneous ring | Event dispatch is O(1) per event. `units.test.ts` "dispatch cost does not grow" |
| B8 | Recording uses a mixing bridge | — | Accepted: softmix of two PCMU streams is cheap next to transcoding. Measure with recording on | — |
| B9 | **No rtpengine session failover** | No floating IP on the platform (V-P2), so another rtpengine can't take over a dead edge's media address | Accepted. Asterisk `rtp_timeout` 60 → 30 s so calls with dead media end sooner and free the phones | New calls go to the surviving edge; only calls in progress on the dead edge are lost |
| API-1 | **Password hashing** in login/signup | `loadtest/api/argon2-bench.mjs` (2026-11-11, 16-vCPU dev box): with the library default argon2id (64 MiB, t=3, p=4), one process did ~28 hashes/s with p95 1.1 s at 32 concurrent logins. It was memory-bound; a larger libuv pool didn't help | OWASP minimum argon2id parameters (19 MiB, t=2, p=1). Old hashes still verify, because the parameters are stored per hash | ~160 hashes/s, p95 0.2 s on the same machine: about 5.7× the throughput. Still to re-measure on a 1-vCPU app VM |
| API-2 | **Lost SYNs between the edges and the app nodes** | The course measured an API p99 of 3.6 s, but the API itself answered with a p99 of 0.19 s. Edge-1's HAProxy logs (6 h) showed where the time went: 47 of 6,021 API requests spent ~1,000 ms connecting to an app node (`Tc`) and only a few ms in the API. That is the kernel's 1 s retransmit after a lost SYN. Edge-1 counted 125k SYN retransmits, edge-2 4k | HAProxy `api` and `web` backends: `timeout connect 250ms`, so a connect that hasn't finished after 250 ms is retried at once (`retries 2`, the last one on the other node). `http-reuse always`, so HAProxy keeps connections to the app nodes open and shares them (PR #39) | A lost SYN now costs ~0.25 s instead of 1–3 s, and most requests need no new connection at all. The app nodes are one private hop away (connect p99 < 5 ms), so a slow API never trips the timeout. SYNs lost between clients and the edge are still open (§3.4) |
| DB-1 | **Patroni error loop on the database replicas** | With almost no load, db-2 and db-3 used ~31% CPU, the leader 9%. Patroni 4 opens a replication connection to its own Postgres on each replica. `pg_hba` had no rule for that from 127.0.0.1, so it failed about 17 times a second, each time with a full traceback: 153,756 log lines in 5 minutes per replica | `host replication replicator 127.0.0.1/32` in `pg_hba` (`postgres_patroni` role). It is applied by a Patroni reload: no restart, no failover | The replicas dropped to 6–11% CPU with no errors. On 1-vCPU VMs that CPU goes back to the reads they serve (Kamailio auth, DID lookups) and to WAL replay. Patroni again knows each replica's position, which it needs to pick the best one in a failover |

### 3.3 How the parts affect each other

- **Media vs. signaling on the edges.** rtpengine and Kamailio share each edge's single vCPU. A
  transcoding spike raises Kamailio's SIP response time, which is graded at p95.
  - Kernel forwarding takes plain relaying off the CPU.
  - Pinning the carrier trunk to PCMU (it is settable, V-D5; the carrier already offers only
    PCMU, V-D12) avoids transcoding on every incoming call.
  - Moving rtpengine to `media` VMs separates the two completely.
- **Call path vs. database.** CDR inserts, the API (signup, configuration, CDR search), and the
  billing scheduler all write to **one Patroni primary** (N8). We kept the call path from
  depending on it:
  - reads come from the cache;
  - writes are batched at hangup;
  - Kamailio reads from replicas.

  Heavy API traffic or a failover therefore slows CDR inserts, not calls.
- **CDR writes vs. search.** The spec needs ended calls to show up in search "within about a
  second", while inserts must stay cheap.
  - `cdrs` is insert-only, one row per leg, with indexes for partial number search.
  - The batch flush interval trades how fresh search results are against how many transactions
    the primary runs.
  - Next step if this grows: partition `cdrs` by month and serve search from replicas.
- **Billing vs. calls.**
  - Rating happens in the ARI app at hangup, from an in-memory rate deck (longest prefix,
    `NOTIFY pbx_rates` reloads it).
  - Billing then only sums rows. Usage is aggregated per account in `usage_periods`, one row
    lock per account per batch (N5).
  - The weekly scheduler runs in every API process. Each unit of work is claimed with
    `FOR UPDATE SKIP LOCKED`, so the API nodes split the work without a leader.
  - Payment unblocks a past-due account through `tenants.status` → `NOTIFY` → the ARI cache,
    well within the required minute.
- **Tenant affinity vs. balance.** Hashing on the account makes transfers correct but can put one
  very large account on one pbx node (N4). The simulated customers are many small businesses,
  so we accepted this. `pbx_active_calls` per node shows if it happens.
- **Node event loop.** Each pbx node runs one Node process for call control (N7). Past its CPU
  limit, we add pbx nodes. The dispatcher list is built from the inventory, so a new node takes
  traffic after one playbook run.

### 3.4 Limitations and next measurements

- **First production evidence (2026-11-13):** one market customer used the system for 3 hours
  and left. Its call records and the course dashboard showed two misrouting bugs and a CDR bug
  (fixed), external numbers always beating desk phones, possible silent legs, and our API p99
  (3.6 s, worst of the active providers). That latency is not in the API (server-side p99
  0.19 s) but in lost TCP SYNs: each costs the kernel's 1 s retransmit, between the edge and the
  app nodes (PR #39) and between clients and the edge (open). Evidence, status of each finding and the queries used:
  [docs/incidents/2026-11-13-first-customer.md](docs/incidents/2026-11-13-first-customer.md).
- **Synthetic call (since 2026-11-14).** Every minute, mon-1 places a real call through each
  edge's public address: test extension B registers, test extension A calls it with digest auth,
  B answers, both answer Asterisk's re-INVITE, A hangs up.
  - Each run records success and the time to answer per edge
    (`pbx_synthetic_call_setup_seconds`). After 3 failed runs in a row, `SyntheticCallFailing`
    alerts the team.
  - First samples: 0.18–0.24 s through edge-1, 0.03 s through edge-2. Edge-1 carries all public
    traffic on 1 vCPU. An hour of samples will show whether it is the SIP bottleneck.
- **Cost trade-off.** Every VM uses the smallest plan (1 vCPU, 2 GB). An edge with 2 vCPUs costs
  twice as much, so we resize a VM only when the measurements show it is the bottleneck.
- **No load numbers from the deployed system yet.**
  - Still to run: SIPp ramps (`-r` calls/s, `-l` concurrent) with the codec matrix on the
    deployed VMs, recording capacity per pbx node and per rtpengine (CPU, `pbx_active_calls`,
    SIP p95 from Kamailio, PDD).
  - Expected first limit: transcoding CPU on the 1-vCPU edges.
  - Planned response: resize the edges or add `media` nodes (VM quota V-P8 is unknown).
- **Single-VM failure coverage:**
  - Losing an edge drops the calls whose media it anchored (B9).
  - DNS has one A/SRV target (V-P1), so phones and browsers registered via the domain need a
    manual DNS change on the Group tab. Carrier calls fail over through the DIDWW trunk group
    (V-D11, partly verified).
- Registrations exist only in memory: if **both** edges restart at once, phones must re-register
  (N2). Edges are therefore always updated with `serial: 1`.
- All writes go to one primary (N8). This is fine at expected rates; partitioning and read
  replicas for the API are the next steps.
- The chaos drills in CLAUDE.md §16 (kill each VM type under load) are still to run.

---

## 4. Design decisions

| Area | Decision | Reason |
|---|---|---|
| **Overall stack** | Kamailio (edge) + rtpengine + Asterisk with a Node ARI app; no Kubernetes; Ansible + StackScripts | Each tool does one job it is built for: Kamailio for SIP at scale, rtpengine for media and WebRTC, Asterisk for media functions. Call logic in TypeScript is testable without telephony hardware. With 10 VMs, Ansible is simpler than an orchestrator |
| **Registrar** | Kamailio is the registrar, not Asterisk. Registrations in memory, replicated with DMQ; Path header for the edge that holds a connection | Any pbx node can reach any device by sending the INVITE to Kamailio. Keeps registrations off the DB (B1) |
| **Media and codecs** | rtpengine anchors every call. The leg toward Asterisk is always PCMU; toward carriers, vendors and phones it offers PCMU, PCMA, G.729, G.723.1, Opus; toward browsers PCMU only | Asterisk needs decoded audio for prompts, MOH, recording and voicemail, and its free codec modules don't cover G.723.1/Opus. One place to transcode, and the browser leg never transcodes (decision S1) |
| **WebRTC** | rtpengine terminates ICE/DTLS-SRTP; Asterisk has no `webrtc=yes` | Asterisk nodes stay private, with no TURN or public IPs |
| **TLS phones** | Kamailio TLS on 5061 with the Let's Encrypt certificate shared with HAProxy; SRTP-SDES via rtpengine | Required by `_sips._tcp` in the spec |
| **Load balancing** | SIP: Kamailio dispatcher, hash on account id, failover on 500/503/timeout. HTTP: HAProxy on each edge, health check on `/ready`, retries + redispatch. Carrier: DIDWW trunk group with both edges | Account affinity for transfers (B5); rolling deploys without failed requests (R18) |
| **Concurrency model** | One Node process per pbx node, with in-memory call sessions and an indexed event bus. Asterisk returns 503 if the app is down (`Hangup(34)`), so Kamailio retries the other node | Simple, single-threaded state per call. A crash loses only that node's calls in progress |
| **Caching** | Per-node account snapshot invalidated by Postgres `NOTIFY` + 30 s TTL; Kamailio `htable` cache for DID → account (failures cached too) | No DB round trip on the call-setup path (B6) |
| **Queuing** | CDRs: durable local spool → batched, idempotent inserts. Recordings/voicemail: local spool + crash-safe sidecar files → object store upload | A DB or object-store outage delays writes but loses nothing |
| **Data storage** | Postgres 16 + Patroni + etcd (3 nodes) behind a **local HAProxy** on each client; Garage (S3 API) with 3 copies on the same nodes | Node and Kamailio Postgres drivers don't handle multi-host failover well. A local proxy has no single point of failure. Clients see `127.0.0.1` |
| **Kamailio data** | Kamailio's own schema for `subscriber`, plus `tenant_id`/`extension_id` columns; Kamailio only reads | The API owns writes. Kamailio can use replicas |
| **CDR, rating, billing** | One insert-only row per leg, rated at hangup by longest prefix with 30/6 increments. Outcome = whether a person answered. Toll-free incoming billed from our answer. Every external leg (forward, simultaneous ring, transfer) is its own charged CDR. Prices have DB `CHECK` ceilings | Matches the spec's per-leg CDR fields. The ceilings make an overcharge impossible even after a bad config change (decisions S7–S11, S15) |
| **Billing periods** | Weekly periods from the signup weekday in the account's time zone. One `account_items` table for every recurring item, with the price locked at purchase. Usage is rounded once per invoice. Invoices under 50¢ are marked paid | One renewal loop. No rounding drift. The gateway's minimum charge (R3, R11–R13) |
| **Payment processing** | Card saved through a SetupIntent (Stripe.js in the browser); charges are off-session PaymentIntents with an Idempotency-Key per attempt (`invoice:<id>:<attempt>`); retries at 5 min, 15 min, 1 h, 3 h, then every 6 h; past due after 24 h unpaid | The clone has no webhooks (V-S2), so we read the PaymentIntent result directly. Keys make retries safe without double charges (R14, R15) |
| **Purchases** | Number and add-on purchases are idempotent (`Idempotency-Key` → `purchase_requests`) and resumable (order → trunk → charge → row) | A retried request after a lost response can't buy or charge twice |
| **Fault tolerance** | Every role on ≥ 2 VMs (db on 3); rolling deploys with health checks; clients reconnect across a 10–30 s Patroni failover; systemd restarts every service | Spec: survive the loss of any one VM |
| **API design** | REST + OpenAPI 3.1 at `/openapi.json`. Everything the website does is possible through the API. Tenant isolation rules for every route ([docs/backend-step3.md](docs/backend-step3.md)). Keyset paging for CDR search | The course's tools drive our API from the OpenAPI document. Keyset paging stays fast on large CDR tables |
| **Auth** | httpOnly cookie with a signed JWT (15 min access, 7 day refresh), stateless across API replicas; argon2id passwords; operator routes use a separate bearer token | No session store to replicate. The operator stays outside tenant isolation |
| **Network security** | Cloud firewall opens only public SIP/TLS/HTTPS/media ports on the edges; nftables allowlists per role on every host; internal services bind private IPs; Kamailio accepts carrier INVITEs only from `carrier_cidrs` and strips `X-PBX-*` headers from outside; pike + UA blacklist; secrets only in Ansible Vault | The cloud firewall can't filter by source, so filtering happens on the hosts |

More decisions with their reasons: spec-transition S1–S16, backend-for-team R1–R23,
[docs/hold-call-waiting.md](docs/hold-call-waiting.md) D1–D8, and
[docs/billing-flows.md](docs/billing-flows.md).

---

## 5. Developer guide

### 5.1 Repository structure

| Path | What |
|---|---|
| `services/shared` | TS package used by the API and the ARI app: DB access (postgres.js), zod schemas (`Destination`, IVR config), number classification, billing rules |
| `services/api` | Fastify API. `src/routes/` per resource, `src/billing/` (catalog, items, scheduler, rates), `src/numbers/didww.ts` (DID provider), `src/openapi` |
| `services/ari-app` | Call control. `inbound.ts` / `device.ts` entry points; `router.ts`, `ring.ts`, `pstn.ts`, `conversation.ts`, `voicemail.ts`, `vm-access.ts`; `cache.ts`, `cdr.ts`, `ari/` (own typed ARI client) |
| `services/web` | React + Vite dashboard and the SIP.js softphone |
| `db/migrations` | App schema, plain SQL, dbmate |
| `db/kamailio` | Kamailio's schema + our extra `subscriber` columns |
| `telephony/` | Jinja templates for Kamailio (`kamailio.cfg.j2`: its header comment explains every route), Asterisk, rtpengine; `tests/check-configs.sh` |
| `infra/ansible` | `site.yml`, inventories, `group_vars`, one role per component |
| `infra/stackscripts` | First-boot script for new VMs |
| `loadtest/sipp`, `loadtest/api` | SIPp scenarios and pcaps; API micro-benchmarks |
| `dev/` | docker-compose (Postgres, Garage), PGlite test server, setup scripts |
| `docs/` | Design and runbooks (index below) |

**Documentation index**

| Document | Read when |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Full spec, architecture and conventions |
| [docs/telephony-contract.md](docs/telephony-contract.md) | You change tables, Destination JSON or softphone SIP behaviour |
| [docs/split-contracts.md](docs/split-contracts.md) | You touch inventory variables, ports, health checks or DB/S3 contracts |
| [docs/spec-transition.md](docs/spec-transition.md) | You need the telephony decisions and bottleneck history |
| [docs/backend-for-team.md](docs/backend-for-team.md), `docs/backend-step*.md` | You work on the API |
| [docs/billing-flows.md](docs/billing-flows.md) | You work on purchases, invoices or past-due |
| [docs/cloud-deploy.md](docs/cloud-deploy.md), [docs/local-vm.md](docs/local-vm.md) | You deploy |
| [docs/telephony-tests.md](docs/telephony-tests.md) | You add or look for tests |
| [docs/verify-backlog.md](docs/verify-backlog.md) | You check or add an unverified assumption |
| [docs/incidents/](docs/incidents/) | You want what live customers revealed (evidence, fixes, open findings) |

### 5.2 Adding or changing a feature

- **API endpoint:**
  1. Add a route in `services/api/src/routes/` following the tenant isolation rules in
     [docs/backend-step3.md](docs/backend-step3.md).
  2. Give it a zod schema, so it shows up in `/openapi.json`.
  3. Add a test next to the existing ones in `services/api/test/`.
- **Schema change:**
  1. Add a new dbmate migration in `db/migrations`. Never edit an applied one.
  2. Update [docs/telephony-contract.md](docs/telephony-contract.md) in the same PR if the call
     path reads that data.
  3. If the call path must see changes immediately, add the table to the `pbx_config` NOTIFY
     triggers.
- **Call-flow behaviour:**
  1. Change the ARI app module.
  2. Add a spec test in `services/ari-app/test/spec/`. It runs against the fake Asterisk and
     PGlite with the real migrations.
- **SIP / media config:**
  1. Edit the template under `telephony/`.
  2. Run `npm run test:configs` (`kamailio -c` on both rendered edges), then `npm test` for the
     content assertions in `services/ari-app/test/configs.test.ts`.
- **Infrastructure:** change the role in `infra/ansible/roles/`. If you add a shared variable,
  port or vault key, add it to [docs/split-contracts.md](docs/split-contracts.md) in the same PR.
- **Unverified assumptions:** every `[VERIFY]` you write needs a row in
  [docs/verify-backlog.md](docs/verify-backlog.md). Mark the row done, with its evidence, when it
  is checked.

### 5.3 Debugging common problems

| Symptom | Look at |
|---|---|
| Carrier call gets 403 | Source IP not in `carrier_cidrs`. SIPp testers must use the listed IP:port |
| Phone gets 401/407 repeatedly | `subscriber` row (API creates it with the extension); replica lag on brand-new credentials (N3); `kamcmd ul.dump` on both edges |
| Call rings but no audio / one-way audio | `rtpengine-ctl list sessions all` on the edge; `sngrep` for SDP; `public_bind_ip`/advertised IP on NATed edges (V-P10); codec offers per leg |
| Every call to a pbx node gets 503 | ARI app down: `systemctl status pbx-ari-app`, `curl 127.0.0.1:9101/health` |
| Calls don't follow a config change | `NOTIFY pbx_config` triggers; the cache refreshes within 30 s anyway |
| API 503 / HAProxy marks app nodes down | `curl :3000/ready` (DB + S3); `127.0.0.1:8405/stats` on the node (local proxy backends); `patronictl list` |
| CDRs missing | ARI app's CDR spool directory and logs; DB reachability; they flush once the primary is back |
| Types look wrong after changing `services/shared` | Rebuild it: `npm run build -w @pbx/shared` (stale `dist`) |
| Ansible variable ignored | `[group:vars]` in an inventory loses to `group_vars/all/main.yml`; use `-e` or host vars |

Useful tools: `sngrep` (SIP ladder on an edge), `kamcmd dispatcher.list`, `kamcmd ul.dump`,
`asterisk -rx "core show channels"`, `rtpengine-ctl`, Grafana on mon-1 (alerts for nodes, disk,
memory, CPU, failed services, Patroni/etcd quorum, HAProxy backends).

### 5.4 Known issues and future improvements

- Not yet verified on real nodes (verify-backlog V-T2..V-T12):
  - transfers through ARI (`ChannelTransfer` field names);
  - forking with per-branch media;
  - SRTP-SDES;
  - DMQ replication between edges;
  - the codec matrix.
- Load tests and chaos drills on the deployed system are still to run (§3.4).
- The `backups` role is a stub: nightly base backup + WAL archiving and a tested restore are
  still open.
- Monitoring still to add:
  - certificate-expiry, synthetic-call and support-ticket alerts;
  - Kamailio, rtpengine and Asterisk metrics (V-T9).
- No rtpengine session failover (B9); one DNS target for phones (V-P1/V-P6).
- API:
  - no login rate limiting;
  - JWTs can't be revoked before expiry;
  - SIP passwords are stored in plaintext in `subscriber` (course-scope decision);
  - cross-tenant references are enforced by the API only;
  - no password change route.
- Toll-free numbers currently lose money at our price (V-D15).

---

## 6. Team process and contributions

### 6.1 Goals

Our goal was to create a fault tolerant PBX service that can scale. We were looking for very high
uptime throughout the duration of this project.

How we set them: we derived concrete targets from the course spec and the grading dashboard
(CLAUDE.md §1). The dashboard measures the first two; the third keeps simulated customers from
leaving over overcharges:
- **Fault tolerance:** every component survives the loss of any single VM. Every role runs on
  at least 2 VMs (the database on 3), and deploys are rolling (§4 "Fault tolerance").
- **Scale:** low p95 SIP response time and post-dial delay, and no failed or silent legs as load
  grows. This drove the bottleneck work in §3.
- **Correct billing:** customers are never overcharged. Price ceilings are enforced in the
  database.

When the course spec was published, we checked our early assumptions against it
(2026-11-08, [docs/spec-transition.md](docs/spec-transition.md)) and reset the plan to match.
The course grading site is our ground truth.

### 6.2 Group responsibilities

| Member | Responsibility | Areas of the repo |
|---|---|---|
| Daniel He (GitHub `dhe30`) | Telephony | `telephony/`, `services/ari-app`, roles `kamailio`, `rtpengine`, `asterisk`, `ari_app`, `edge_haproxy` |
| Justin Cheng | Frontend | `services/web` |
| Aaron Peng | Backend | `services/api`, `services/shared`, `db/migrations`, role `api` |
| Muhammad Fahad Babar | Database, System Observability | roles `etcd`, `postgres_patroni`, `db_local_proxy`, `objectstore`, `monitoring`, `backups` |

### 6.3 Major contributions

- **Daniel**
  - Designed the telephony architecture: Kamailio as the registrar, rtpengine for media and
    transcoding, Asterisk with ARI call control.
  - Built the phase-1 all-in-one telephony VM, including hold and call waiting.
  - Rebuilt the telephony for the course spec: extensions, outgoing PSTN calls, transfers,
    per-leg CDRs and rating.
  - Took the system to the cloud: edges behind 1:1 NAT, Let's Encrypt, website deployment.
  - Wrote the verification backlog and checked our assumptions against the real course services
    (DID provider, vendors, payment gateway).
- **Justin**
  - Built the React dashboard and the payment flow in the website.
  - Tested the system end to end on the production deployment as a customer would use it:
    signup, adding users, calls in and out through the website softphone, calls between
    extensions, and call routing.
- **Aaron**
  - Built the whole backend API in eight steps: accounts, tenant isolation, extensions, call
    configuration, media, voicemail, call history and number purchase.
  - Built billing: card at signup, add-ons, weekly invoices, past due and recovery, prices by
    destination prefix.
  - Wrote the OpenAPI 3.1 document and the Ansible role that deploys the API.
  - Measured password hashing under load and tuned argon2id (§3.2, API-1).
- **Muhammad**
  - Built the highly available data tier: etcd, Patroni + Postgres 16, the local DB/S3 proxy and
    a 3-node Garage object store.
  - Built monitoring on mon-1: Prometheus, Alertmanager, Grafana, node_exporter on every VM, and
    alert rules for nodes, disks, Patroni, etcd and HAProxy.

### 6.4 Tasks completed

The completed tasks below come from the git history, with the PR numbers.

- **Daniel**
  - Monorepo scaffold (#1)
  - Telephony: all-in-one VM, IVR, recording, voicemail, hold + call waiting (#2)
  - Course-spec telephony: extensions, outgoing calls, transfers, CDRs; port of the API
    foundation to the new model (#4)
  - Local VM runbook and testing (#4)
  - Production inventory, vault generator, DID settings (#12)
  - DIDWW search fixes against the course clone (#13), support tickets API (#14), verification
    backlog and results (#15, #16, #19)
  - Let's Encrypt certificate on the edges (#17), website deployment (#20), migration fix (#22),
    rsync over ProxyJump (#23)
  - Fixes for the course adapter's feedback (#24)
  - Team SSH keys for root on every VM (#25)
  - Website softphone: passes the spec §4 browser checks, fixes from testing against the
    deployed system (#26)
  - Attended transfer between two calls a phone answered (call waiting) (#28)
  - Call routing page: external numbers as destinations, ring-group overall timeout (#29)
  - Reviewed and merged most PRs
  - Cloud deployment
  - Testing:
    - placed calls from MicroSIP (a desktop SIP softphone) to the local test VM to check the
      telephony stack before the cloud deployment;
    - worked through the issues the course's API adapter reported, then fixed them (#24).
- **Justin**
  - Frontend migration and payment implementation (#18)
  - Call routing page (#27)
  - Testing on the production deployment:
    - account creation, adding users, and making calls to external numbers and to other
      extensions;
    - calls to the website softphone and calls from the website out to external numbers;
    - call routing;
    - SIP communication between the softphone and our servers.
- **Aaron**
  - Server skeleton, auth, tenant isolation, staff + SIP credentials, mailboxes, ring
    groups, IVR menus, number routing (#3)
  - Time zone + `GET /me`, card at signup with the first plan charge, business hours, caller
    blocklist, `/openapi.json` (#5)
  - API test fixes for parallel runs; Kamailio subscriber columns in local dev (#6)
  - Greetings and media, call history, voicemail, settings, number search,
    purchase and release (#7, #8)
  - Billing: add-ons and extra extensions, weekly invoices, past due, rates by prefix (#11)
  - API deployment (role `api`), argon2id benchmark (#11)
  - Backend docs for the team ([docs/backend-for-team.md](docs/backend-for-team.md))
- **Muhammad**
  - etcd, Patroni + Postgres 16, local DB/S3 proxy, 3-node Garage (#9)
  - Data-tier contracts and runbook updates (#10)
  - Monitoring on mon-1 + node_exporter everywhere (#21)

### 6.5 Leadership and coordination

Daniel led and coordinated the project:
- outlined the responsibilities and tasks;
- wrote the shared spec ([CLAUDE.md](CLAUDE.md)) and the contracts between tracks;
- maintained the repository and merged most pull requests.

### 6.6 Team communication and task division

We agreed to communicate through a Discord group chat. Daniel outlined the responsibilities and
tasks for our group, and all other group members chose their tasks and responsibilities from
what Daniel suggested.

To let everyone work in parallel, the work was split into four tracks with written interfaces:
- T1 data tier (Muhammad);
- T2 telephony (Daniel);
- T3 API (Aaron) and web (Justin);
- T4 monitoring + backups (Muhammad).

[docs/split-contracts.md](docs/split-contracts.md) fixes the names, ports and variables shared
between tracks, so each track could be built and merged without waiting for the others.
Changing a contract needs review from every track owner. Handoffs between tracks are written
down too:
- [docs/backend-for-team.md](docs/backend-for-team.md) has a section for each teammate;
- [docs/telephony-contract.md](docs/telephony-contract.md) is the contract between the API and
  the call path.

### 6.7 Progress tracking and deadlines

- **Pull requests:** every change went through a GitHub pull request into `main` (29 PRs by
  2026-11-12).
- **Build phases:** progress was tracked against the build phases in CLAUDE.md §17.
- **Verification backlog:** [docs/verify-backlog.md](docs/verify-backlog.md) lists each open
  assumption with its status and the evidence once checked.
- **Deadlines:**
  - 11/08: Have the majority of T1, T2, T3, and T4 complete
  - 11/09 or 11/10: Database changes
  - 11/10: Remaining API changes and fixes
  - 11/11: Frontend integration, course services setup, system deployment
  - 11/12: Website and API testing and fixes, project documentation
  - 11/12 (night): Project deadline

- **Deadline handling:** to meet deadlines we communicated with each other actively in our group
  and made sure that each group member completed their tasks. We also broke up more complicated
  tasks among multiple members (such as the production testing), and prioritized certain tasks
  over others. For example, we heavily prioritized T1, T2, T3, and T4 before the Ansible node
  configuration, documentation, and API contract.

Internal milestones (the completed date is when the work was merged into `main`):

| # | Milestone | Target date | Completed |
|---|---|---|---|
| 0 | Repo scaffold and layout | none | 10/26 |
| 1 | All-in-one telephony VM, IVR → browser, recording, voicemail, hold + call waiting | 10/29 | 10/29 |
| 2 | API foundation (auth, tenants, staff, call configuration) | 11/08 | 11/08 |
| 3 | Rebuild PBX service to comply with course spec | 11/09 | 11/09 |
| 4 | Data tier HA (Patroni, etcd, Garage, local proxies) | 11/09 | 11/10 |
| 5 | API done (media, voicemail, call history, numbers, billing) | 11/10 | 11/11 |
| 6 | Frontend done (call routing, etc.) | 11/11 | 11/12 |
| 7 | First full cloud deployment on 10 VMs | 11/12 | 11/12 |
