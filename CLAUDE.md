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
- Build a hosted, multi-tenant PBX service. Businesses (example: "Tony's Pizza") sign up, buy a
  phone number (DID), configure call handling (IVR menu, ring staff), and staff answer calls in
  the browser via WebRTC.
- Required features: number purchase, IVR, ringing staff (browser softphones), CALL RECORDING,
  VOICEMAIL, WebRTC, and HOLD + CALL WAITING (a staff member can put a caller on hold, answer
  another call, then return to the first). Implemented in phase 1 — see §19.
- Codec support (requirement): calls offering G.711 (PCMU/PCMA), G.723.1, G.729 or Opus must work.
  Design: rtpengine transcodes the carrier leg to PCMU for Asterisk (§4.3 #3); browsers get PCMU
  (WebRTC supports G.711 + Opus, not G.723.1/G.729), so the browser leg never transcodes.
  [VERIFY] on the VM: `rtpengine --codecs` shows encode+decode for G723, G729, opus.
- The system must run for several weeks on the course's Linode-clone cloud under (non-malicious)
  stress testing.
- GRADE IS ALMOST ENTIRELY RELIABILITY / FAULT TOLERANCE. Keep features minimal and robust.
  Every component must survive the loss of any single VM.

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
## 3. DID / carrier side — [ASSUMPTION]s and change impact
---------------------------------------------------------------------------------------------
We do not yet have the DID endpoint or its spec. Current assumptions:

A1. Calls are delivered as SIP INVITEs over UDP 5060 to our public SIP address; media is plain RTP
    (no SRTP); no SIP TLS.
    Impact if changed: MINOR (add Kamailio TCP/TLS listener + cert; rtpengine SRTP flags).
A2. The provider identifies us by IP (static trunk). We do not register to the provider.
    Impact if registration is required: MODERATE (Kamailio uac module registration + failover of
    the registration between edge nodes). No app code change.
A3. The dialed DID (E.164) is in the Request-URI user part.
    Impact if it's in To/Diversion header: MINOR (one Kamailio/ARI line).
A4. Every SDP offer includes G.711 (PCMU/PCMA), G.723.1, G.729, and Opus, plus RFC 4733
    telephone-event for DTMF.
    Impact if some calls lack G.711: NONE in design — rtpengine flags below already transcode;
    only CPU capacity planning changes. G.723.1/G.729 calls to browsers always need one transcode
    (browsers can't decode them). Possible later optimization if phase-6 load tests show Opus
    transcoding is costly: pass Opus through end-to-end (Kamailio carrier-leg flags keep opus,
    pjsip allow=opus,ulaw + an Asterisk Opus codec module; ARI originate already passes
    `originator` so the staff leg prefers the caller's codec). Saves CPU only for Opus calls
    with recording off (recording/prompts make Asterisk decode anyway). Config-only change. Impact if DTMF is in-band audio only: MODERATE
    (enable rtpengine in-band DTMF detection; CPU cost; unreliable over G.723.1/G.729).
A5. Inbound calls only. Tenants do not place outbound PSTN calls.
    Impact if outbound required: MODERATE (Kamailio route for staff-originated INVITEs, outbound
    trunk to provider, caller-ID rules, rate limits). Data model already has room.
A6. Purchase = synchronous HTTP call to the course DID endpoint returning a number. After purchase,
    the provider sends calls for that DID to our single configured SIP address (no per-number
    provisioning needed).
    Impact if per-number provisioning/webhooks are needed: MINOR–MODERATE (API background job).
A7. The provider can target a DNS name or multiple IPs (so we can fail over between 2 edge nodes).
    Impact if only ONE IP is allowed: MODERATE infra change (need a floating IP + keepalived
    between edge nodes, if the platform supports it). No app change.
!! MAJOR OVERHAUL case: if calls are NOT delivered via SIP (e.g., HTTP webhooks + media over
   WebSocket, Twilio-style), the entire ingress (Kamailio/rtpengine) changes. Confirm ASAP.

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
- Files: ARI app writes recordings/voicemail to local spool, uploads to object store; API serves
  them via presigned URLs. Greetings uploaded via API, cached locally on pbx nodes for playback.

### 4.3 Key design decisions (and why)
1. Kamailio is the REGISTRAR (not Asterisk). Browsers register with Kamailio; any Asterisk node can
   reach any staff member by sending the INVITE to Kamailio. Credentials live in Kamailio's
   `subscriber` table (written by the API).
2. Registrations are shared between both edge nodes via usrloc db_mode=3 (DB-only) in Postgres.
   A browser's WebSocket lives on ONE edge node, so REGISTER handling adds a Path header
   (add_path_received) pointing to the edge node holding the connection; the other edge node
   forwards to it. [VERIFY] Alternative: DMQ usrloc replication.
3. rtpengine anchors all media and transcodes: the leg toward Asterisk is always G.711 (PCMU),
   so Asterisk never transcodes. With A4 (all codecs offered), PCMU passes through with zero
   transcoding; transcoding engages automatically only when a side lacks PCMU.
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

App tables (draft):
- tenants(id uuid pk, name, created_at)
- users(id uuid pk, tenant_id fk, email unique, password_hash, role enum('owner','staff'),
        sip_username unique null, created_at)
- phone_numbers(id uuid pk, did text unique (E.164), tenant_id fk null, ivr_menu_id fk null,
        status enum('assigned','released'), provider_ref text, purchased_at)
- purchase_requests(idempotency_key text pk, tenant_id, phone_number_id null, status, created_at)
- ivr_menus(id uuid pk, tenant_id, name, greeting_media_id fk null, timeout_sec int default 5,
        max_retries int default 3, config jsonb)
  config (validated by zod in services/shared):
    { "options": { "1": {"action":"ring_group","target":"<ring_group_id>"},
                   "2": {"action":"voicemail","target":"<mailbox_id>"},
                   "0": {"action":"user","target":"<user_id>"} },
      "on_timeout": {"action":"voicemail","target":"<mailbox_id>"} }
- ring_groups(id, tenant_id, name, strategy enum('all','sequential'), ring_timeout_sec int,
        fallback_mailbox_id fk)
- ring_group_members(ring_group_id, user_id, position)
- mailboxes(id, tenant_id, name, greeting_media_id null, owner_user_id null)
- media(id uuid pk, tenant_id, kind enum('greeting','recording','voicemail'), object_key,
        format text, duration_ms int, created_at)
- calls(id uuid pk, tenant_id, phone_number_id, caller_number, started_at, answered_at null,
        ended_at null, disposition enum('answered','voicemail','abandoned','failed'),
        answered_by_user_id null, pbx_node text, recording_media_id null)
- voicemails(id uuid pk, tenant_id, mailbox_id, call_id, media_id, heard bool default false, created_at)
- tenant_settings(tenant_id pk, record_calls bool default false)
Constraints: DID unique; purchase is idempotent (Idempotency-Key header -> purchase_requests).

---------------------------------------------------------------------------------------------
## 7. Kamailio (edge) — routing logic spec
---------------------------------------------------------------------------------------------
Listeners: UDP 5060 on public IP (provider), UDP 5060 on private IP (Asterisk + peer edge),
WS on private IP :8080 (from HAProxy, which terminates TLS for wss://).
Modules: tm, sl, rr, pv, maxfwd, textops, siputils, sanity, xlog, nathelper, websocket, path,
registrar, usrloc (db_mode=3), auth, auth_db, db_postgres, dispatcher, permissions, rtpengine,
pike (light), htable, jsonrpcs (for kamcmd), xhttp_prom or exporter for metrics. [VERIFY]

Dispatcher: set 1 = pbx nodes (file rendered by Ansible from inventory group `pbx`),
ds_ping_interval=5, ds_probing_threshold=2, ds_probing_mode=1 (always probe). Algorithm 4
(round-robin) or 10 (weight/load-based) [choose 4 initially].

rtpengine: rtpengine_sock lists both rtpengine instances (edge-1, edge-2) identically on both
Kamailios.

request_route (in order):
1. sanity, maxfwd, drop scanners (User-Agent blacklist, pike) for untrusted sources.
2. WebSocket/NAT handling for WS clients (nathelper: add_contact_alias/handle_ruri_alias). [VERIFY]
3. In-dialog (has To-tag): loose_route(); for BYE/CANCEL -> rtpengine_delete(); for re-INVITE/
   UPDATE with SDP -> rtpengine offer/answer with flags chosen by the `leg` Record-Route param
   (set on the initial INVITE via add_rr_param(";leg=carrier|staff_ws|staff_udp")).
4. REGISTER: only from WS or UDP clients (staff). www_authorize against subscriber; on success,
   add_path_received() and save("location"). Short expires (e.g., 120–300 s).
5. INVITE from provider (allow_source_address(group=1), provider IPs from config) = LEG 1:
   - ds_select_dst("1","4"); on none -> 503.
   - rtpengine_offer with flags toward Asterisk (plain RTP, G.711 only, transcoding enabled):
     "replace-origin replace-session-connection direction=external direction=internal RTP/AVP
      codec-mask-all codec-transcode-PCMU codec-transcode-telephone-event"   [VERIFY flags]
   - t_on_reply -> rtpengine_answer("replace-origin replace-session-connection")
   - t_on_failure: on 503/408/timeout -> ds_mark_dst("ip") then ds_next_dst() and retry
     (re-run rtpengine offer handling as needed).
6. INVITE from a pbx node (ds_is_from_list("1")) = LEG 2 (ringing staff):
   - lookup("location"); not found -> 480 (ARI app treats as unavailable -> voicemail).
   - If the contact is via the OTHER edge node (Path), just relay; that node does the WS delivery.
     Only the FIRST edge node handling the INVITE engages rtpengine (skip rtpengine when the
     request comes from the peer edge IP).
   - Destination is WS -> rtpengine_offer("direction=internal direction=external RTP/SAVPF
     ICE=force DTLS=passive SDES-off rtcp-mux-offer generate-mid") ; reply ->
     rtpengine_answer("RTP/AVP ICE=remove DTLS=off rtcp-mux-demux")   [VERIFY flags]
   - Destination is UDP (desk/soft phone, SIPp) -> plain RTP flags (RTP/AVP).
   - Mark leg via add_rr_param; record_route(); t_relay().
7. INVITE from authenticated staff (outbound/internal dialing): 403 for now (A5).
8. OPTIONS addressed to us: reply 200. Everything else from unknown sources: 403.

---------------------------------------------------------------------------------------------
## 8. rtpengine
---------------------------------------------------------------------------------------------
- interface = internal/<edge private IP>;external/<edge public IP>
- listen-ng = <edge private IP>:2223 (bind private only; host firewall allows only edge peers)
- port-min/port-max = 30000/40000 (open UDP range on public IP in cloud firewall)
- Built with transcoding (ffmpeg) + bcg729 for G.729; verify `rtpengine --codecs` lists PCMU,
  PCMA, G723, G729, opus with encode+decode support. [VERIFY]
- Transcoded calls run in userspace (no kernel forwarding) => CPU is the capacity limit; measure.
- Phase 1 runs ALL media in userspace (rtpengine.conf `table = -1`, no kernel module) for a simple
  install. Media-CPU scaling levers, in order: (1) kernel forwarding (`table = 0` + install
  rtpengine-kernel-dkms; non-transcoded RTP and SRTP are then relayed in-kernel), (2) dedicated
  media-N nodes, (3) only then architecture changes. Decision (2026-10-27): keep WebRTC
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
  - NO per-staff endpoints and NO webrtc=yes (rtpengine handles WebRTC; Kamailio holds staff).
- extensions.conf:
    [from-edge]
    exten => _X.,1,Stasis(pbx-app,inbound)
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
- Per-call state in memory (Map by channel id). A crash loses in-progress calls on this node
  (accepted); new calls must work after restart.
- Inbound flow (StasisStart with args[0]=='inbound'):
  1. DID = channel.dialplan.exten. Load phone_number -> tenant -> ivr menu (+ settings).
     Not found -> hangup. Insert `calls` row (pbx_node = hostname).
  2. answer(); if record_calls, start recording when the customer is bridged with staff
     (bridge.record, format wav) and set calls.recording_media_id after upload.
  3. IVR loop: play greeting (ensure cached locally: download from object store if missing),
     collect DTMF (ChannelDtmfReceived) with timeout_sec, max_retries; invalid -> replay.
  4. Actions:
     - ring_group 'all': originate to every member's `PJSIP/<sip_username>@edge-a` (fallback
       edge-b if originate fails fast), first answer wins, hang up the others, bridge with caller.
     - ring_group 'sequential': ring members in order, each for ring_timeout_sec.
     - user: ring one user.
     - no answer / all unavailable (480/404/timeout) -> voicemail fallback.
     - voicemail: play mailbox greeting (or default), beep, channel.record(maxDuration 120s,
       maxSilence 5s, terminateOn '#'), on RecordingFinished -> upload -> insert voicemails row.
  5. On hangup (StasisEnd/ChannelHangupRequest): tear down bridge + outbound legs, update calls row.
- Uploader: uploads finished recordings, deletes local file only after confirmed upload;
  sweeps the spool dir on startup and every minute for orphaned files (retry until success).
- Distinguish legs the app originated via appArgs (e.g., "outbound:<callId>").

---------------------------------------------------------------------------------------------
## 11. API (services/api) — endpoints
---------------------------------------------------------------------------------------------
Auth: httpOnly cookie with signed JWT (stateless across replicas), short expiry + refresh.
- POST /auth/signup (tenant + owner), POST /auth/login, POST /auth/logout, GET /me
- GET /numbers/available (proxy to course DID endpoint), POST /numbers/purchase
  (Idempotency-Key header; transaction; reconcile if provider succeeded but DB failed),
  GET /numbers, PUT /numbers/:id/route {ivr_menu_id}
- Staff: POST /staff (creates user + subscriber row w/ generated sip_username/password),
  DELETE /staff/:id (delete subscriber row), GET /staff
- GET /me/sip-credentials -> {wsUri, sipUri, username, password} (staff only)
- IVR menus CRUD, ring groups CRUD, mailboxes CRUD (zod-validated config)
- Media: POST /media (upload greeting; convert with ffmpeg to 8 kHz mono wav; store in object
  store), GET /media/:id/url (presigned)
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
Public (edge only): UDP 5060 (provider SIP), TCP 443 (HTTPS + WSS via HAProxy),
UDP 30000–40000 (rtpengine media), TCP 22 (prefer restricting via host firewall).
Private: Kamailio UDP 5060 + WS 8080, rtpengine ng 2223, Asterisk UDP 5060 + RTP 10000–20000,
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
- Load tests (loadtest/sipp): one scenario per codec (PCMU, G.723.1, G.729, Opus pcaps),
  ramp concurrent calls/CPS; record capacity per pbx and per rtpengine.
- Chaos drills (acceptance criteria): kill any single VM during load -> new calls succeed within
  ~10 s; kill Patroni primary -> recovery < 30 s, no data loss for committed rows; kill ARI app
  -> 503 + retry to other pbx; edge failure -> browsers reconnect and re-register; fill a disk ->
  alert fires before failure; full restart of all VMs -> system recovers without manual steps;
  restore DB from backup.

---------------------------------------------------------------------------------------------
## 17. Build phases
---------------------------------------------------------------------------------------------
0. Recon: verify platform features, network, quotas; get DID endpoint details; confirm A1–A7.
1. All-in-one VM: Kamailio + rtpengine + Asterisk + ARI app on ONE VM with the final config
   structure; inbound call (SIPp/softphone as fake carrier) -> IVR -> rings browser and a UDP
   softphone; recording + voicemail to a local object store. (Optional warm-up: Asterisk-only
   WebRTC smoke test.)
   -> IMPLEMENTED: infra/ansible/phase1-allinone.yml. Runbook, decisions taken beyond this spec,
      and the items still to verify on a real VM: docs/phase1.md.
2. (Parallel) API + web locally via dev/docker-compose; staff creation writes subscriber rows.
3. Everything as code: Ansible roles + StackScript; rebuild the all-in-one VM with one command.
4. Split and replicate per §4.1, killing a node after each step: pbx x2 behind dispatcher;
   Patroni x3 + local DB proxies; app x2 behind HAProxy; edge x2 (Path, shared usrloc,
   rtpengine set); object store x3.
5. Observability + synthetic checks.
6. Load + chaos testing; capacity numbers; tune.
7. Hardening: backups/restore drill, cert renewal, log rotation, runbook, deploy rules for the
   grading window.

---------------------------------------------------------------------------------------------
## 18. Open questions (track answers here)
---------------------------------------------------------------------------------------------
- DID endpoint: API shape; how calls are delivered (confirm SIP!); provider IPs; can it target a
  DNS name / multiple IPs; DTMF method; SRTP/TLS? (A1–A7)
- Stress test: concurrent calls, CPS, codec mix, whether audio quality is measured, whether
  failures are injected.
- Platform: VM quota, floating/shared IPs, NodeBalancers, API access, outbound internet,
  domain name + DNS control (needed for TLS/WSS).
- Are external services allowed (GitHub Actions, ghcr.io, Let's Encrypt, public STUN)?
- Retention requirements for recordings/voicemail?

---------------------------------------------------------------------------------------------
## 19. Hold + call waiting (added 2026-10-27, implemented in phase 1 on 2026-10-28)
---------------------------------------------------------------------------------------------
Full requirements (H1-H3, W1-W7, R1-R5), design, decisions D1-D8 and tests: docs/hold-call-waiting.md.
Summary:
- Hold = the staff phone sends an in-dialog re-INVITE with a=sendonly (resume: a=sendrecv).
- Kamailio route[INDLG_SDP] picks rtpengine flags from the leg tag set on the initial INVITE
  (leg=carrier|staff_ws|staff_udp) + whether the request came from Asterisk. Never from the
  request's own transport (with 2 edges a browser's re-INVITE arrives at the anchoring edge via UDP).
- Asterisk raises ChannelHold/ChannelUnhold on the agent channel; the ARI app (hold.ts,
  connectToAgent in ring.ts) starts/stops MOH on the CALLER channel. Needed because Asterisk only
  forwards hold inside 2-party bridges; recorded calls use softmix, which drops hold frames.
- Recording keeps running while held (D1). Max hold 30 min = Asterisk rtp_timeout_hold
  (hold_max_sec) < rtpengine silent-timeout 3600 (D2). MOH = stock opsound u-law, class default.
- Call waiting: no server-side busy check (W1). The softphone (telephony/webrtc-test now, and
  services/web §12 later) uses SIP.js UserAgent/Invitation with several sessions: auto-holds the
  active call when answering another, declines with 486, no limit on calls.
- Tests: loadtest/sipp/uas_staff_hold.xml; manual browser steps in docs/phase1.md §4.
