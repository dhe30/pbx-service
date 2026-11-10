# PBX CLOUD PROJECT — SPEC & CONTEXT FOR CODE GENERATION

This file is the single source of context for AI coding sessions (e.g., Claude Code).
It can be placed at the repo root as CLAUDE.md. Sections marked [ASSUMPTION] may change;
sections marked [VERIFY] must be checked against the docs for the versions actually deployed.

---------------------------------------------------------------------------------------------
## 0. Who I am / how to help me
---------------------------------------------------------------------------------------------
- Comfortable with: React/TypeScript, Node.js, Spring Boot, Postgres, Docker/docker-compose CRUD apps.
- New to: SIP/RTP/WebRTC, Kamailio, Asterisk/ARI, rtpengine, Ansible, Patroni, multi-VM ops.
- When generating code/config: explain non-obvious telephony config inline with short comments,
  prefer simple and explicit over clever, and flag anything that needs verification.

---------------------------------------------------------------------------------------------
## 1. Project goal and grading
---------------------------------------------------------------------------------------------
Ground truth (2026-11-08): the course grading site, Project + Course Services tabs
(grading.cse356.compas.cs.stonybrook.edu/dashboard). Where this file disagrees with it, the site wins.
- Build a hosted virtual PBX for small businesses. Customers sign up on the website (business
  name, time zone, admin email/password, card), buy numbers, configure call handling, make AND
  take calls from SIP desk phones and a WebRTC softphone, and pay by card.
- Course services: DID provider (DIDWW API v3 clone), US + International PSTN vendors (SIP, digest
  auth, per-minute rate decks), payment gateway (Stripe clone), a bank with per-vendor prepaid
  balances (vendor at $0 => DID provider stops delivering calls / PSTN vendor answers 402).
- Telephony requirements (spec §3): extensions (number unique per account, SIP user/pass returned
  by API, voicemail box, forwarding always/busy/no-answer to an extension or external number; ANY
  number of phones register per extension; a call rings all devices + softphone + listed external
  numbers at once, first answer wins); extensions dial each other by number; IVR menus (greeting,
  digits -> extension | ring group | menu | voicemail | external number; timeout, invalid input,
  repeat); ring groups (all at once / in order, timeout, no-answer destination); business hours
  (weekly, account TZ, open/closed destinations); number routing -> extension | ring group | IVR |
  business hours; voicemail (web + *98 with Cisco Unity standard conversation); caller blocklist;
  HOLD and TRANSFER (blind + attended) from desk phones and softphone; outgoing calls (US 10 digits
  or 1+10; any number as +E.164 or 011; route by destination; caller ID = one of the account's
  numbers); call recording add-on.
- Phones register at <group>.cse356.compas.cs.stonybrook.edu via SRV records we publish:
  `_sip._udp` and `_sips._tcp`. TLS-registered phones use SRTP with SDES (RFC 4568).
- Codecs: a phone may support ONLY ONE of PCMU, PCMA, G.729, G.723.1 (6.3k) or Opus, and calls
  between any two must work => transcoding on phone/staff legs too, not just the carrier leg.
  Design: rtpengine normalizes every leg toward Asterisk to PCMU (§4.3 #3).
  [VERIFY] on the VM: `rtpengine --codecs` shows encode+decode for G723, G729, opus.
- CDRs per leg (direction, numbers, DID/extensions, start/answer/end, billable duration, outcome
  answered|busy|no answer|failed|blocked, vendor, cost, charge); rating by longest prefix; billing
  in 30/6 increments; past-due accounts get outgoing calls blocked (unblock within 1 min of payment).
- GRADING = SIMULATED CUSTOMERS UNDER LOAD. Once traffic is on, simulated businesses sign up, use
  the API, and make/receive calls; they leave over failed calls, missing audio, API failures, or
  overcharges. The dashboard measures: calls completed/min; failures/min (failed, SILENT or
  MISROUTED legs; failed registrations); p95 SIP response time (REGISTER, INVITE -> first
  response, BYE, re-INVITE); p95 post-dial delay; API latency; outages. README must contain a
  scaling analysis (bottlenecks, evidence, changes, trade-offs). So: throughput + latency +
  correctness under load, AND every component must still survive the loss of any single VM.

---------------------------------------------------------------------------------------------
## 2. Platform facts (course Linode clone)
---------------------------------------------------------------------------------------------
- Linode = KVM VM. Features: create VMs, attach Volumes (block storage, one VM at a time),
  Firewalls, StackScripts (first-boot bash scripts, support <UDF> fields), Images (disk snapshots).
- VMs have a private IP; a public IPv4 can be attached.
- Cloud firewall: inbound rules accept ALL IPv4 sources on the ports you open (no per-source
  filtering at the cloud level assumed). => Source restrictions must be enforced on the host
  (nftables) and in applications (Kamailio permissions module, bind internal services to private IPs).
- Stress testing is not intentionally malicious, but any public IP will still be scanned by the
  internet; keep basic hardening.
- Unknown (see Open Questions): VM quota, floating/shared IPs, NodeBalancers, API access,
  outbound internet access, domain name availability.

---------------------------------------------------------------------------------------------
## 3. Carrier, vendors and phones — resolved assumptions (2026-11-08)
---------------------------------------------------------------------------------------------
Original assumptions A1–A7 checked against the course spec. Secrets (DIDWW api-key, vendor digest
passwords, Stripe keys) go in group_vars/all/vault.yml only — never in any other committed file.

A1. Carrier: SIP INVITEs over UDP from 130.245.136.142 (-> carrier_cidrs), plain RTP. CONFIRMED.
    CHANGED for phones: `_sips._tcp` phones register over TLS and use SRTP-SDES => Kamailio TLS
    listener (5061, real cert for the group domain) + a leg=staff_tls tag (rtpengine RTP/SAVP SDES).
A2. Carrier identifies us by IP; calls arrive at the DID's DIDWW "inbound trunk". CONFIRMED.
    PSTN vendors (outbound) need SIP digest auth: us-vendor / intl-vendor
    .cse356.compas.cs.stonybrook.edu:5060 UDP. No registration to them.
A3. DID in the Request-URI user: LIKELY; the DIDWW trunk config sets the R-URI user. [VERIFY]
A4. REVERSED. Not every offer has every codec: each phone may support only one codec. Transcode on
    every leg type (carrier, staff_udp, staff_tls, vendor); browser legs stay PCMU. [VERIFY] whether
    the DIDWW trunk config can pin the carrier leg's codec to PCMU (saves transcoding there).
    DTMF assumed RFC 4733 (rtpengine codec-transcode=telephone-event). [VERIFY]
A5. BROKEN. Outbound PSTN (US vendor: US numbers; Intl vendor: everything else INCLUDING non-US +1
    countries), internal extension-to-extension calls, and forwarding/ring to external numbers are
    all required. Each external leg is billed. Vendor 402 = out of funds.
A6. Numbers are bought via DIDWW API v3 (orders, DIDs, inbound trunks / trunk groups); setup fee +
    7-day renewal + per-second fee on answered toll-free. Released numbers work to period end.
A7. LIKELY OK: phones find us via SRV (both edges as targets); DIDWW trunk groups with several
    trunks (priority/weight) should give carrier failover across edges. [VERIFY]
Real phones: members' US phones calling (201) 633-6004/-6005 reach our `_sip._udp` SRV target;
4 shared lines, 5-minute limit.

---------------------------------------------------------------------------------------------
## 4. Architecture overview
---------------------------------------------------------------------------------------------
Stack (decided): Kamailio (SIP edge/registrar), rtpengine (media relay + transcoding + WebRTC),
Asterisk + Node ARI app (call control), Node/TypeScript API, React dashboard + SIP.js softphone,
Postgres + Patroni + etcd, S3-compatible object storage, Prometheus/Grafana/Alertmanager,
Ansible + StackScripts for deployment. No Kubernetes.

### 4.1 VM layout (10 VMs; roles can be split further if quota allows)
| VM            | Public IP | Runs                                                                 |
|---------------|-----------|----------------------------------------------------------------------|
| edge-1, edge-2| yes       | Kamailio, rtpengine, HAProxy (HTTPS + WSS TLS termination), local DB HAProxy |
| pbx-1, pbx-2  | no        | Asterisk, ARI app (Node), local DB HAProxy                           |
| app-1, app-2  | no        | API (Node), static web build (served by API or nginx), local DB HAProxy |
| db-1..db-3    | no        | Postgres + Patroni, etcd, object store node (replication factor 3)   |
| mon-1         | no*       | Prometheus, Grafana, Alertmanager, SIPp synthetic checks, backups, self-hosted CI runner |
(*mon-1 may get a public IP or be reached via SSH tunnel for Grafana.)
- Scale-out path: more pbx-N nodes (call capacity), split rtpengine onto media-N nodes if
  transcoding CPU becomes the bottleneck.

### 4.2 Traffic paths
- Carrier call signaling: Provider -SIP/UDP-> Kamailio (edge) -> dispatcher picks pbx-N -> Asterisk
  -> Stasis -> ARI app.
- Staff ring: ARI app originates -> Asterisk -> Kamailio -> location lookup -> staff browser (WSS)
  or plain SIP phone (UDP, used for testing/SIPp).
- Audio (every call): Customer <-> rtpengine <-> Asterisk (bridge) <-> rtpengine <-> Staff browser.
  Kamailio never touches audio. Asterisk nodes are private; only rtpengine has public media ports.
- Browser: HTTPS -> HAProxy (edge) -> API (app-N). WSS -> HAProxy (edge) -> Kamailio WS (private).
- Data: ARI app + API + Kamailio -> local HAProxy (127.0.0.1:5432) -> current Patroni primary.
  Asterisk itself does NOT use the database.
- Files: ARI app writes recordings/voicemail to local spool, uploads to object store; API streams
  them to browsers (GET /media/:id/audio; the store is private, so no presigned URLs). Greetings uploaded via API, cached locally on pbx nodes for playback.

### 4.3 Key design decisions (and why)
1. Kamailio is the REGISTRAR (not Asterisk). Browsers register with Kamailio; any Asterisk node can
   reach any staff member by sending the INVITE to Kamailio. Credentials live in Kamailio's
   `subscriber` table (written by the API).
2. Registrations live in Kamailio memory (usrloc db_mode=0), replicated between edges with
   dmq_usrloc (2026-11-09, B1; phase 1 used db_mode=3 in Postgres). A phone's connection lives on
   ONE edge, so REGISTER adds a Path header pointing to that edge; the other edge relays to it.
3. rtpengine anchors all media and transcodes: the leg toward Asterisk is always G.711 (PCMU),
   so Asterisk never transcodes. Toward carriers, vendors and SIP phones rtpengine offers PCMU,
   PCMA, G.729, G.723.1 and Opus, because a phone may support only one of them (course spec).
4. Browser leg uses PCMU (WebRTC supports it) to avoid PCMU<->Opus transcoding. Opus toward
   browsers is an optional quality upgrade later (costs CPU).
5. Call control lives in the Node ARI app (one per Asterisk, same VM, connects to localhost).
   Dialplan only hands calls to Stasis. If the ARI app is down, Asterisk returns 503 so Kamailio
   retries another pbx node.
6. Voicemail and recording are implemented in the ARI app (NOT app_voicemail), files go to the
   object store, metadata to Postgres. Nothing important is stored only on a pbx node's disk.
7. Database access: every node that needs Postgres runs a local HAProxy (127.0.0.1:5432) that
   health-checks Patroni's REST API (port 8008, /primary) and forwards to the current primary.
   Reason: node-postgres, Kamailio db_postgres, etc. don't reliably support multi-host failover
   connection strings; a local HAProxy has no extra single point of failure.
8. Same rtpengine set configuration on both Kamailios (hash on Call-ID) so either Kamailio can
   handle in-dialog requests (re-INVITE/BYE) for any call.

---------------------------------------------------------------------------------------------
## 5. Repo layout (monorepo)
---------------------------------------------------------------------------------------------
pbx/
  CLAUDE.md                     # this file
  services/
    shared/                     # TS package: db access (postgres.js), zod schemas (IVR config), types
    api/                        # Fastify + TS
    ari-app/                    # TS call-control app (ari-client)
    web/                        # React + Vite + TS + SIP.js (dashboard + softphone)
  db/
    migrations/                 # app schema, plain SQL, managed with dbmate
    kamailio/                   # Kamailio-provided schema SQL (subscriber, location, version, ...)
  telephony/
    kamailio/kamailio.cfg.j2    # Jinja templates rendered by Ansible
    asterisk/*.conf.j2
    rtpengine/rtpengine.conf.j2
  infra/
    stackscripts/bootstrap.sh
    ansible/
      inventory/{production,staging}.ini
      group_vars/{all.yml,vault.yml}
      roles/{common,db_local_proxy,kamailio,rtpengine,edge_haproxy,asterisk,ari_app,api,
             postgres_patroni,etcd,objectstore,monitoring,backups}
      site.yml
  loadtest/sipp/                # SIPp scenarios + RTP pcaps per codec
  dev/docker-compose.yml        # local dev: postgres, object store, api, web

Tooling defaults (change if the team prefers): Node 24 LTS, TypeScript strict, Fastify, postgres.js
(`postgres` npm), zod, pino logging, prom-client metrics, @aws-sdk/client-s3, argon2 for password
hashing, vitest. ARI: own small typed client in services/ari-app/src/ari/ (fetch + ws), not ari-client.
Pin component versions in Ansible vars (infra/ansible/group_vars/all/main.yml): Asterisk 22 LTS
(built from source), Kamailio 6.0, rtpengine 26.0 LTS (rtpengine.dfx.at, with bcg729), Postgres 16,
Garage v2 (object store), Patroni, etcd 3.5, HAProxy from Debian 13 (3.0). Target OS: Debian 13.

---------------------------------------------------------------------------------------------
## 6. Data model (app schema `public`; Kamailio tables in schema/db as Kamailio expects)
---------------------------------------------------------------------------------------------
Kamailio-owned tables (DO NOT hand-design; use Kamailio's SQL scripts for the deployed version):
  subscriber(username, domain, password, ha1, ha1b, ...), location(...), version(...)
  -> API inserts/deletes `subscriber` rows for staff. [Decision for course scope: store plaintext
     `password` with auth_db calculate_ha1=yes so the API can return it to the logged-in browser.
     Future improvement: encrypted copy + ha1 only.]

  -> Extra columns tenant_id, extension_id (db/kamailio/pbx-subscriber-columns.sql).

App tables: db/migrations (init + 20261109000000_course_spec_telephony.sql). Contract for the
API/web teams (who writes what, JSON formats, search query, softphone SIP behaviour):
docs/telephony-contract.md. Summary:
- tenants(+ timezone, status active|past_due), tenant_settings(record_calls, intl_calling,
  included_us_minutes), users (sip_username DEPRECATED), purchase_requests
- extensions(number unique per account, sip_username global unique, mailbox_id, ring_timeout_sec,
  forward_always/busy/no_answer jsonb, external_numbers text[], caller_id_number, user_id)
- phone_numbers(+ destination jsonb, kind local|toll_free, incoming_cost_per_min, paid_until)
- ivr_menus.config = {options:{digit: Destination}, timeout, invalid, repeat_digit}
  (zod: services/shared/src/ivr-config.ts; phase-1 {action,target} still accepted)
- ring_groups(+ no_answer_destination), ring_group_members(ring_group_id, EXTENSION_id, position)
- business_hours(schedule jsonb, open_destination, closed_destination), blocked_numbers
- mailboxes, media(+ call_id), voicemails(heard = saved, + caller_number, call_id -> cdrs.call_id)
- cdrs: one row per leg, insert-only (replaces `calls`); rate_decks, call_pricing, usage_periods
Destination JSON: {"type": extension|ring_group|ivr_menu|voicemail|business_hours, "id"} |
{"type":"external","number":"+E.164"} | {"type":"hangup"}.
Constraints: DID unique; purchase is idempotent (Idempotency-Key header -> purchase_requests).

---------------------------------------------------------------------------------------------
## 7. Kamailio (edge) — routing logic spec
---------------------------------------------------------------------------------------------
Implemented in telephony/kamailio/kamailio.cfg.j2 (validated with `kamailio -c` 6.0.8 by
telephony/tests/check-configs.sh). Its header comment is the authoritative description.
Listeners: UDP 5060 public (carrier, phones) + private (Asterisk, peer edge, DMQ), TLS 5061 public
(phones via _sips._tcp; SRTP-SDES media), WS private :8080 (from HAProxy).
- Registrations: usrloc db_mode=0 + dmq_usrloc (sync on start); unlimited contacts per extension;
  Path header with ;received so the edge holding the connection delivers.
- DB: read-only URL (kamailio_db_ro_url) for auth_db and the DID -> account lookup (sqlops +
  htable cache, view public.kamailio_did_tenant). Kamailio never writes to Postgres.
- Dispatcher set 1 = pbx nodes; algorithm 7 hashes on the account id (auth_db load_credentials
  -> $avp(tenant) for phones; DID lookup for carrier calls), round-robin if unknown; failover with
  ds_next_dst on 500/503/timeout.
- Routes: FROM_CARRIER (carrier_cidrs), FROM_DEVICE (digest auth 407; adds X-PBX-Src: device +
  X-PBX-User), TO_DEVICES (Asterisk -> lookup -> parallel fork; per-branch transport via branch
  flags; rtpengine via-branch=extra per branch), TO_VENDOR (Asterisk -> PSTN vendor host; Asterisk
  answers the vendor's 401/407), FROM_PEER (deliver for a peer edge), WITHINDLG/INDLG_SDP
  (re-INVITE flags from the leg=carrier|vendor|staff_udp|staff_tls|staff_ws Record-Route param +
  whether Asterisk sent it).
- rtpengine flags: toward Asterisk always PCMU + telephone-event (codec-mask=all
  codec-transcode=PCMU); toward carrier/vendor/UDP/TLS phones also PCMA, G729, G723, opus offered;
  toward browsers PCMU (no transcoding), ICE + DTLS-SRTP.
- Security: X-PBX-* headers stripped from outside; pike + UA blacklist for untrusted sources only
  (trusted_tester_cidrs = course simulators exempt, B2).

---------------------------------------------------------------------------------------------
## 8. rtpengine
---------------------------------------------------------------------------------------------
- interface = internal/<edge private IP>;external/<edge public IP>
- listen-ng = <edge private IP>:2223 (bind private only; host firewall allows only edge peers)
- port-min/port-max = 30000/40000 (open UDP range on public IP in cloud firewall)
- Built with transcoding (ffmpeg) + bcg729 for G.729; verify `rtpengine --codecs` lists PCMU,
  PCMA, G723, G729, opus with encode+decode support. [VERIFY]
- Transcoded calls run in userspace => CPU is the capacity limit; measure with the SIPp codec
  matrix (single-codec phones: most legs transcode, see docs/spec-transition.md N1).
- Kernel forwarding ON since 2026-11-09 (`table = 0` + rtpengine-kernel-dkms, falls back to
  userspace if the module can't load), num-threads = vCPUs. Dedicated media nodes: add an
  inventory group `media` (rtpengine_ips and site.yml follow it). Decision (2026-10-27): keep WebRTC
  termination in rtpengine, NOT Asterisk (webrtc=yes would need public IPs/TURN for pbx nodes for
  a small CPU saving; SRTP/DTLS cost is minor next to relaying/transcoding).
- Metrics: enable its Prometheus/HTTP stats interface. [VERIFY]
- Redis-based session replication between instances: optional later (in-progress calls on a dead
  rtpengine lose audio otherwise).

---------------------------------------------------------------------------------------------
## 9. Asterisk (pbx nodes)
---------------------------------------------------------------------------------------------
- pjsip.conf:
  - transport-udp bound to private IP :5060 (no public IP, no external_* settings needed).
  - Two trunk endpoints `edge-a`, `edge-b` (one per Kamailio): context=from-edge, disallow=all,
    allow=ulaw, direct_media=no, dtmf_mode=rfc4733, aors with contact sip:<edge private IP>:5060,
    identify match both edge private IPs, qualify enabled.
  - NO per-phone endpoints and NO webrtc=yes (rtpengine handles WebRTC; Kamailio holds phones).
  - PSTN vendors: endpoint vendor-<us|intl>-<edge trunk> per edge, outbound_proxy = that edge's
    Kamailio, outbound_auth = vendor digest credentials (vault_vendor_*). The ARI app dials
    PJSIP/vendor-us-edge-a/sip:+1NXXNXXXXXX@<vendor host>.
  - allow_transfer=yes; the ARI app sets PJSIP_TRANSFER_HANDLING()=ari-only on bridged channels
    (REFER -> ChannelTransfer event; Asterisk 22.1+). [VERIFY]
- extensions.conf:
    [from-edge]
    exten => _[+*#0-9]!,1,Stasis(pbx-app,${PJSIP_HEADER(read,X-PBX-Src)},${PJSIP_HEADER(read,X-PBX-User)})
     same => n,Hangup(34)        ; Stasis failed (app down) -> cause 34 -> SIP 503 -> Kamailio
                                 ; retries another pbx node   [VERIFY cause->503 mapping]
- ari.conf: user pbxapp, password from vault. http.conf: bind 127.0.0.1:8088 only.
- rtp.conf: rtpstart=10000, rtpend=20000 (private network only).
- Recordings spool: /var/spool/asterisk/recording (on a dedicated disk/volume if possible).
- Sounds cache for tenant greetings: /var/lib/asterisk/sounds/cache/<media_id>.wav (8 kHz mono).
- Load res_prometheus for metrics [VERIFY]; logrotate for logs.

---------------------------------------------------------------------------------------------
## 10. ARI app (services/ari-app) — behavior spec
---------------------------------------------------------------------------------------------
- Connects to ws ARI at localhost:8088, app name "pbx-app". Reconnect with exponential backoff.
  DB via local HAProxy. Object store via S3 SDK.
- Exposes localhost HTTP /health (ARI connected AND DB reachable) and /metrics.
- Per-call state in memory (CallSession). A crash loses in-progress calls on this node
  (accepted); new calls must work after restart.
- Hot path reads ONLY an in-memory account snapshot (cache.ts; NOTIFY pbx_config invalidation,
  30 s TTL) and writes nothing until hangup (cdr.ts: local spool -> batched, rated, idempotent
  insert into cdrs + usage_periods). Event bus indexed by channel (B7).
- Entry (StasisStart args [source, sipUser]):
  - carrier (inbound.ts): 180 first (post-dial delay), DID -> account, blocklist -> 403/blocked,
    then routeTo(number.destination).
  - device (device.ts): *98 -> voicemail access; extension number -> internal call; else PSTN
    (normalize, past-due/intl checks -> 403/blocked, caller ID, vendor leg).
- router.ts: Destination chain (extension with forwarding rules | ring group all/sequential |
  IVR | voicemail | business hours | external | hangup), MAX_ROUTE_HOPS loop guard.
- ring.ts: an extension = ONE originate PJSIP/<sip_username>@edge-a (Kamailio forks to all its
  devices) + one vendor leg per external number; first answer wins; fast failure -> next trunk.
- conversation.ts: bridge, hold -> MOH to the other party (either side), recording (add-on),
  blind/attended transfer via ChannelTransfer (ari-only).
- vm-access.ts: *98 Cisco Unity conversation; voicemail.ts: leave a message.
- Uploader: unchanged (recordings/voicemail -> object store, crash-safe sidecars).
- Legs the app originated enter Stasis with appArgs "outbound:<caller channel>".

---------------------------------------------------------------------------------------------
## 11. API (services/api) — endpoints
---------------------------------------------------------------------------------------------
Auth: httpOnly cookie with signed JWT (stateless across replicas), short expiry + refresh.
- POST /auth/signup (tenant + owner), POST /auth/login, POST /auth/logout, GET /me
- GET /numbers/available (proxy to course DID endpoint), POST /numbers/purchase
  (Idempotency-Key header; transaction; reconcile if provider succeeded but DB failed),
  GET /numbers, PUT /numbers/:id/route {ivr_menu_id}
NOTE (2026-11-09): the course spec requires an OpenAPI 3.1 document at /openapi.json and that
everything the web does be possible through the API. Telephony-relevant data and formats the API
must expose/write: docs/telephony-contract.md (extensions + subscriber rows, destinations,
business hours, blocklist, CDR search, voicemail state, pricing/rates, account status).
- Extensions CRUD (creates extension + kamailio.subscriber row with tenant_id/extension_id in one
  transaction; returns SIP username/password/domain)
- GET /me/sip-credentials -> {wsUri, sipUri, username, password} for the chosen extension
- IVR menus CRUD, ring groups CRUD, mailboxes CRUD, business hours CRUD, blocklist CRUD
  (zod-validated destinations)
- Media (step 6, docs/backend-step6.md): POST /media (upload greeting; ffmpeg -> 8 kHz mono wav;
  object store), GET /media, GET/DELETE /media/:id, GET /media/:id/audio (streamed, Range)
- Voicemails: GET /voicemails, GET /voicemails/:id/url, PATCH /voicemails/:id {heard}, DELETE
- Calls: GET /calls (history + recording links)
- Settings: GET/PUT /settings {record_calls}
- GET /health (liveness), GET /ready (DB + object store reachable), GET /metrics

---------------------------------------------------------------------------------------------
## 12. Web (services/web)
---------------------------------------------------------------------------------------------
- Dashboard pages: signup/login, numbers (buy/list/route), IVR editor, ring groups, staff,
  greetings upload, voicemail inbox (play/mark heard), call history (+ recordings), settings.
- Softphone component (staff): fetch /me/sip-credentials, SIP.js UserAgent/Registerer over
  wss://<app domain>/ws (HAProxy -> Kamailio). Requirements:
  - "Go online" button (user gesture for mic/audio), incoming-call UI (answer/decline), hangup,
    <audio autoplay> for remote media. PCMU/Opus.
  - Auto-reconnect with backoff when the WebSocket drops (edge node failure) and re-register.
  - Register expires ~120–300 s.
  - Course spec §4: on the page shown after login, with the required data-testids
    (softphone-extension/number/call/answer/hangup/hold/transfer-blind/transfer-attended/
    transfer-complete/dtmf-*/incoming). SIP behaviour behind each: docs/telephony-contract.md §8.

---------------------------------------------------------------------------------------------
## 13. Data & storage HA
---------------------------------------------------------------------------------------------
- Postgres 16 + Patroni + etcd on db-1..3 (etcd quorum of 3). Data on Volumes.
- Local HAProxy on each DB client node: 127.0.0.1:5432 -> server whose GET :8008/primary == 200.
- All clients (API, ARI app, Kamailio) must retry/reconnect across a 10–30 s failover.
- Object store: S3-compatible, self-hosted on db-1..3 with replication factor 3
  (candidates: Garage or SeaweedFS — evaluate; code only uses the S3 API). [VERIFY]
- Backups: nightly base backup + WAL archiving (pgBackRest or wal-g) to storage NOT on the db
  nodes (e.g., mon-1 volume). Restore must be tested.

---------------------------------------------------------------------------------------------
## 14. Networking, ports, security
---------------------------------------------------------------------------------------------
Public (edge only): UDP 5060 (carrier, vendors, phones), TCP 5061 (SIP over TLS for phones),
TCP 443 (HTTPS + WSS via HAProxy), UDP 30000–40000 (rtpengine media), TCP 22 (prefer restricting
via host firewall).
Private: Kamailio UDP 5060 (+ DMQ) + WS 8080, rtpengine ng 2223, Asterisk UDP 5060 + RTP 10000–20000,
ARI 8088 (localhost only), API 3000, Postgres 5432, Patroni 8008, etcd 2379/2380, object store,
node_exporter 9100 and other exporters.
- Host firewall (nftables, via Ansible `common` role): private-port allowlists by role/IP.
- Kamailio permissions module: only provider IPs may send INVITEs as carrier.
- fail2ban for SSH; Kamailio pike + UA blacklist (light; testers are not malicious).
- TLS: certificate for the app domain on HAProxy (edge); automated renewal + expiry alert.
- Secrets in Ansible Vault (DB passwords, ARI password, JWT key, S3 keys).

---------------------------------------------------------------------------------------------
## 15. Deployment & operations
---------------------------------------------------------------------------------------------
- StackScript (bootstrap.sh): UDF `role`; install python3/docker as needed, add team SSH key,
  basic nftables, optionally run ansible-pull for its role.
- Ansible: inventory groups edge, pbx, app, db, mon. site.yml: all->common(+db_local_proxy where
  needed), edge->kamailio,rtpengine,edge_haproxy, pbx->asterisk,ari_app, app->api,
  db->etcd,postgres_patroni,objectstore, mon->monitoring,backups. serial: 1 for pbx/app/edge
  with health-check waits. Templates generate dispatcher list (from group pbx), rtpengine sockets,
  HAProxy backends, env files.
- Cross-group deps: changing pbx nodes -> rerun edge (dispatcher reload via kamcmd);
  changing app nodes -> rerun edge (HAProxy reload); changing edge nodes -> rerun pbx (trunk IPs).
- App images: built in CI (self-hosted runner on mon-1), pushed to a registry (ghcr.io or
  self-hosted registry:2 if outbound internet is restricted), deployed by Ansible.
- Graceful drain for pbx nodes before deploy: set dispatcher state inactive on both Kamailios,
  wait until active calls == 0 (or timeout), deploy, re-enable.
- Rebuild a dead node: recreate VM with StackScript -> update inventory -> run playbook for that
  node + dependent groups.

---------------------------------------------------------------------------------------------
## 16. Observability & testing
---------------------------------------------------------------------------------------------
- Prometheus scrapes: node_exporter (all), Kamailio, rtpengine, Asterisk (res_prometheus),
  ARI app, API, postgres_exporter, Patroni, etcd, HAProxy, object store.
- Alerts (Alertmanager -> team Discord): node down, dispatcher has <2 active pbx, no DB primary,
  replication lag, disk > 70%, cert expiry < 14 d, synthetic call failing, error rates,
  rtpengine CPU high, upload queue backlog.
- Synthetic check (mon-1, every minute): SIPp places a call to a test DID through the provider
  path if possible (else directly to edge), plays RTP, sends DTMF 1, expects answer by a SIPp
  UAS registered as a test staff user over UDP.
- Test suite (docs/telephony-tests.md): `npm test` = shared rules + call-flow spec suite (fake
  Asterisk + PGlite Postgres with the real migrations) + rendered-config assertions;
  `npm run test:configs` = render all telephony templates + `kamailio -c` (Linux/WSL).
- Load tests (loadtest/sipp): one scenario per codec (uac_inbound_codec.xml with PCMU, PCMA,
  G.723.1, G.729, Opus pcaps), phones placing calls (uac_device_call.xml),
  ramp concurrent calls/CPS; record capacity per pbx and per rtpengine.
- Chaos drills (acceptance criteria): kill any single VM during load -> new calls succeed within
  ~10 s; kill Patroni primary -> recovery < 30 s, no data loss for committed rows; kill ARI app
  -> 503 + retry to other pbx; edge failure -> browsers reconnect and re-register; fill a disk ->
  alert fires before failure; full restart of all VMs -> system recovers without manual steps;
  restore DB from backup.

---------------------------------------------------------------------------------------------
## 17. Build phases (phase 1 predates the course spec; see §20)
---------------------------------------------------------------------------------------------
0. Recon: verify platform features, network, quotas; get DID endpoint details; confirm A1–A7.
1. All-in-one VM: Kamailio + rtpengine + Asterisk + ARI app on ONE VM with the final config
   structure; inbound call (SIPp/softphone as fake carrier) -> IVR -> rings browser and a UDP
   softphone; recording + voicemail to a local object store. (Optional warm-up: Asterisk-only
   WebRTC smoke test.)
   -> IMPLEMENTED: infra/ansible/phase1-allinone.yml. Runbook, decisions taken beyond this spec,
      and the items still to verify on a real VM: docs/phase1.md.
2. (Parallel) API + web locally via dev/docker-compose; staff creation writes subscriber rows.
   -> API IN PROGRESS (Aaron): steps 1-6 done (skeleton, auth, tenant isolation, staff + SIP
      credentials, mailboxes / ring groups / IVR menus / number routing, greeting upload + media), plus the course-spec
      updates (time zone + GET /me, business hours, blocklist, /openapi.json, signup card + first
      plan charge, extension limit: docs/backend-card-signup.md). Contracts for other
      tracks: docs/backend-for-team.md; per-step details: docs/backend-step{1,2,3,4,5,6}.md.
      Local dev also needs `npm run db:kamailio`, `npm run dev:s3` (Garage) and ffmpeg.
      Every tenant-scoped API route must follow the rules in docs/backend-step3.md.
3. Everything as code: Ansible roles + StackScript; rebuild the all-in-one VM with one command.
4. Split and replicate per §4.1, killing a node after each step: pbx x2 behind dispatcher;
   Patroni x3 + local DB proxies; app x2 behind HAProxy; edge x2 (Path, shared usrloc,
   rtpengine set); object store x3.
   -> Worked on in parallel tracks (data tier / telephony split / API+web / monitoring+backups).
      Shared interfaces every track codes against (inventory groups + vars, ports, DB and S3
      contracts, health endpoints): docs/split-contracts.md. Example 10-VM inventory:
      infra/ansible/inventory/staging.ini.
5. Observability + synthetic checks.
6. Load + chaos testing; capacity numbers; tune.
7. Hardening: backups/restore drill, cert renewal, log rotation, runbook, deploy rules for the
   grading window.

---------------------------------------------------------------------------------------------
## 18. Open questions (track answers here)
---------------------------------------------------------------------------------------------
ANSWERED (2026-11-08): calls are delivered via SIP from 130.245.136.142; the DID API is DIDWW
v3; SRTP/TLS is needed for `_sips._tcp` phones; audio is checked (silent legs count as failures);
the domain is <group>.cse356.compas.cs.stonybrook.edu with SRV records published on the Group tab.
Still open:
- DIDWW trunk config: R-URI user format, codec selection, trunk-group failover across 2 edges,
  SRV support for the trunk host? DTMF method on carrier calls?
- PSTN vendors: which codecs they offer/accept; source IPs of their in-dialog requests.
- Load: concurrent calls, CPS, codec mix and source IPs of the simulated phones/customers
  (needed for pike/fail2ban allowlists, see §20 B2).
- Asterisk 22 ARI handling of REFER: implemented with PJSIP_TRANSFER_HANDLING()=ari-only +
  ChannelTransfer + transfer_progress; field names [VERIFY] on the VM (docs/spec-transition.md §6).
- Platform: VM quota, floating/shared IPs, NodeBalancers, API access, outbound internet,
  A records / cert issuance for the group domain (needed for TLS/WSS).
- Are external services allowed (GitHub Actions, ghcr.io, Let's Encrypt, public STUN)?
- Retention requirements for recordings/voicemail?

---------------------------------------------------------------------------------------------
## 19. Hold + call waiting (added 2026-10-27, implemented in phase 1 on 2026-10-28)
---------------------------------------------------------------------------------------------
Full requirements (H1-H3, W1-W7, R1-R5), design, decisions D1-D8 and tests: docs/hold-call-waiting.md.
Summary:
- Hold = the staff phone sends an in-dialog re-INVITE with a=sendonly (resume: a=sendrecv).
- Kamailio route[INDLG_SDP] picks rtpengine flags from the leg tag set on the initial INVITE
  (leg=carrier|vendor|staff_udp|staff_tls|staff_ws) + whether the request came from Asterisk. Never from the
  request's own transport (with 2 edges a browser's re-INVITE arrives at the anchoring edge via UDP).
- Asterisk raises ChannelHold/ChannelUnhold on the holding channel; the ARI app
  (conversation.ts) starts/stops MOH on the OTHER party (either side may hold). Needed because Asterisk only
  forwards hold inside 2-party bridges; recorded calls use softmix, which drops hold frames.
- Recording keeps running while held (D1). Max hold 30 min = Asterisk rtp_timeout_hold
  (hold_max_sec) < rtpengine silent-timeout 3600 (D2). MOH = stock opsound u-law, class default.
- Call waiting: no server-side busy check (W1). The softphone (telephony/webrtc-test now, and
  services/web §12 later) uses SIP.js UserAgent/Invitation with several sessions: auto-holds the
  active call when answering another, declines with 486, no limit on calls.
- Tests: loadtest/sipp/uas_staff_hold.xml; manual browser steps in docs/phase1.md §4.

---------------------------------------------------------------------------------------------
## 20. Telephony vs. course spec: gap analysis (2026-11-08) -> implemented (2026-11-09)
---------------------------------------------------------------------------------------------
The phase-1 telephony was rebuilt for the course spec. Full write-up for the team (assumption ->
spec table, per-component changes, decisions S1-S16, bottleneck status, new risks N1-N10, what is
still [VERIFY] on a VM): docs/spec-transition.md. API/web contract: docs/telephony-contract.md.
Tests: docs/telephony-tests.md. First cloud deployment + checklist: docs/cloud-deploy.md. Purchases/payments/billing (frontend vs backend vs Stripe): docs/billing-flows.md.

Bottlenecks from the gap analysis:
- B1 registrations/auth on the DB primary -> FIXED (usrloc in memory + DMQ, read-only DB URL, 16/16 workers)
- B2 pike vs. course simulators            -> FIXED (trusted_tester_cidrs; ranges [VERIFY])
- B3 userspace media on signaling VMs       -> MITIGATED (kernel forwarding, threads, optional `media` group)
- B4 PCMU-only Asterisk => transcoding      -> ACCEPTED (decision S1; measure with the codec matrix)
- B5 round-robin breaks attended transfer   -> FIXED (dispatcher alg 7 on account id)
- B6 DB on the call-setup path              -> FIXED (config cache + NOTIFY, 180 first, spooled batched CDRs)
- B7 O(n^2) ARI event fan-out               -> FIXED (indexed event bus, parallel originate)
- B8 recording via mixing bridge            -> ACCEPTED (cheap for PCMU; measure)
- B9 no rtpengine session failover          -> ACCEPTED (needs a floating IP; rtp_timeout 30 s)

Rules for further work:
- The DB schema in db/migrations + docs/telephony-contract.md is the interface with the API team:
  change both together.
- Every telephony template must keep passing `npm run test:configs` (`kamailio -c` on rendered
  edges) and the content assertions in services/ari-app/test/configs.test.ts.
- Call-flow behaviour changes need a spec test in services/ari-app/test/spec/ (fake Asterisk).
