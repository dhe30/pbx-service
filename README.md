# pbx-service: a hosted virtual PBX

A multi-tenant cloud phone system for small businesses (CSE 356 course project). A business signs
up on our website, pays by card, buys numbers, configures call handling, and makes and takes calls
from SIP desk phones and a browser softphone. It runs on 10 VMs, keeps working under the course's
simulated customer load, and survives the loss of any one VM.

Production: `group-4.cse356.compas.cs.stonybrook.edu` serves the website and API (HTTPS), the
softphone (WSS), and SIP over UDP and TLS through the `_sip._udp` / `_sips._tcp` SRV records.

1. [Project overview](#1-project-overview)
2. [Running the system](#2-running-the-system)
3. [Scaling and load handling](#3-scaling-and-load-handling)
4. [Design decisions](#4-design-decisions)
5. [Developer guide](#5-developer-guide)
6. [Team process and contributions](#6-team-process-and-contributions)

Topic documents are in [`docs/`](docs/) (index in §5.2). [CLAUDE.md](CLAUDE.md) is the full spec
and architecture reference.

---

## 1. Project overview

Phones and browsers only ever talk to two public **edge** VMs. The edges route SIP (Kamailio) and
relay and transcode all audio (rtpengine). Calls go to private **pbx** VMs, where Asterisk handles
the media work and a Node app decides what each call does. The API and website run on private
**app** VMs and write configuration to Postgres. The call path reads that configuration from an
in-memory cache, so calls don't wait on the database.

### Features

- **Accounts and billing:** signup with business name, time zone, admin login and card; a weekly
  plan; add-ons (extra extensions, international calling, recording); weekly invoices with
  retries; outgoing calls blocked while past due.
- **Numbers:** search, buy, route and release local and toll-free numbers from the course's DID
  provider.
- **Call handling:**
  - extensions where every registered phone, the softphone and listed external numbers ring at
    once (first answer wins), with forwarding on always / busy / no answer;
  - IVR menus, ring groups (simultaneous or in order), business hours in the account's time zone;
  - voicemail (web inbox and `*98`), caller blocklist, hold, blind and attended transfer;
  - outgoing calls through the US and international PSTN vendors; call recording.
- **Any codec pair works:** each phone may support only one of PCMU, PCMA, G.729, G.723.1 or Opus.
- **Call records:** one CDR per leg, rated by longest prefix in 30/6-second increments, searchable.

### Components

| Component | Technology | Runs on | Job |
|---|---|---|---|
| SIP proxy, registrar | Kamailio 6.0 | edge-1, edge-2 (public) | Registers phones and browsers, authenticates them, routes every SIP request, picks a pbx node |
| Media relay | rtpengine 26.0 | edge-1, edge-2 | Relays all audio; transcodes; terminates WebRTC (ICE, DTLS-SRTP) and SRTP-SDES |
| TLS front end | HAProxy 3.0 | edge-1, edge-2 | HTTPS for the website and API, WSS for the softphone |
| Media server | Asterisk 22 | pbx-1..pbx-3 (private) | Bridges, prompts, music on hold, recording, DTMF. No call logic in its dialplan |
| Call control | Node/TypeScript ARI app (`services/ari-app`) | pbx-1, pbx-2 | IVR, ringing, forwarding, voicemail, transfers, CDRs and rating |
| API | Node/TypeScript, Fastify (`services/api`) | app-1, app-2 | Accounts, numbers, configuration, billing, CDR search, audio files. OpenAPI 3.1 at `/openapi.json` |
| Website, softphone | React, Vite, SIP.js (`services/web`) | app-1, app-2 (nginx) | Dashboard and browser phone |
| Database | Postgres 16, Patroni, etcd | db-1..3 | All persistent data, including Kamailio's `subscriber` table |
| Object store | Garage (S3 API), 3 copies | db-1..3 | Greetings, voicemail, recordings |
| Local DB/S3 proxy | HAProxy (`pbx-dbproxy`) | every node that uses the DB | `127.0.0.1:5432` always reaches the current Patroni primary |
| Monitoring | Prometheus, Alertmanager, Grafana, test-call probes | mon-1 | Metrics, alerts, synthetic calls |

### How the pieces interact

```
     desk phones (UDP / TLS)      browsers (HTTPS + WSS)            course services
               |                         |                  DID provider    payment gateway
               | SIP + RTP/SRTP          |                  (carrier SIP)   (Stripe clone)
               v                         v                        |               ^
  +----------------------- edge-1 / edge-2 (public IPs) -------+  |               |
  |  Kamailio (registrar, routing)  <--DMQ-->  peer edge        |<-+               |
  |  rtpengine (all media, transcoding, WebRTC)                 |                  |
  |  HAProxy :443 (HTTPS -> API / web, WSS -> Kamailio)         |                  |
  +-------|-----------------------|-----------------------|-----+                  |
          | SIP (dispatcher,      | RTP, PCMU only        | HTTP                   |
          |  hash on account)     |                       v                        |
  +-------v-----------------------v------+        +-------------------+            |
  | pbx-1 / pbx-2: Asterisk + ARI app    |        | app-1 / app-2:    |------------+
  | (call logic, voicemail, recording,   |        | API + website     |--> DID provider API
  |  CDR spool, outgoing vendor legs)    |        | billing scheduler |    (buy numbers)
  +-------|------------------------------+        +---------|---------+
          | SQL + S3 via local proxy                        | SQL + S3 via local proxy
  +-------v-------------------------------------------------v-------------+
  | db-1..3: Postgres + Patroni + etcd, Garage object store (3 copies)    |
  +-----------------------------------------------------------------------+
  outgoing: ARI app -> Asterisk -> Kamailio (edge) -> US or international PSTN vendor (digest auth)
```

- **Incoming call:** the DID provider sends an INVITE to an edge. Kamailio looks up the number's
  account, and rtpengine rewrites the SDP so the Asterisk side is PCMU. The dispatcher picks the
  pbx node for that account. The ARI app sends 180 Ringing at once, then follows the number's
  destination (IVR, ring group, extension, ...).
- **Ringing an extension:** the ARI app sends one INVITE per extension to Kamailio, which forks it
  to every registered device, each with its own media leg in rtpengine. External numbers on the
  extension get their own vendor leg. The first answer wins.
- **Outgoing call:** Kamailio checks the phone's digest credentials and passes the call to the
  account's pbx node. The ARI app checks past-due status, international permission and caller ID,
  then dials the right vendor through an edge.
- **Configuration change:** the API writes Postgres. A trigger sends `NOTIFY pbx_config`, and every
  ARI app drops that account's cached configuration.
- **Audio files:** the ARI app records to local disk and uploads to the object store. The API
  streams files to browsers (`GET /media/:id/audio`). The store is never public.

---

## 2. Running the system

### 2.1 Dependencies

| For | Needs |
|---|---|
| Local API, website, tests | Node 24 (`.nvmrc`), npm, Docker + compose (Postgres, Garage), [dbmate](https://github.com/amacneil/dbmate), ffmpeg |
| Telephony config checks | Linux or WSL with Ansible and Kamailio 6.0 binaries (`telephony/tests/check-configs.sh` extracts them from .debs, no root) |
| Cloud deploy | Linux or WSL with Ansible (`infra/ansible/requirements.yml`), the vault password, an SSH key the VMs accept |
| Load and live tests | SIPp with pcap support (`sip-tester`); `sngrep` and `tcpdump` on the edges |

### 2.2 Configuration

- **Local:** `cp .env.example .env`. Every variable is commented there. `DID_PROVIDER_MODE=fake`
  gives fictional numbers with no network access.
- **Cloud** (all under `infra/ansible/`):
  - `inventory/production.ini`: VM addresses. Private VMs are reached through edge-1 (ProxyJump).
  - `group_vars/all/main.yml`: pinned versions, domain, ports, DID provider settings.
  - `group_vars/all/vault.yml`: every secret, Ansible Vault encrypted. Create it with
    `scripts/new-vault.sh`. The repo is public, so never commit an unencrypted copy.
  - Variables and ports shared between roles: [docs/split-contracts.md](docs/split-contracts.md).

### 2.3 Local development (API and website)

```bash
cp .env.example .env
npm install
npm run dev:up              # Postgres + Garage in docker
npm run db:migrate          # app schema (dbmate)
npm run db:kamailio         # Kamailio's subscriber/location tables
npm run dev:s3              # create the Garage bucket + key
npm run build -w @pbx/shared
npm run dev -w @pbx/api     # API on :3000
npm run dev -w @pbx/web     # website (Vite), /api proxied to :3000
npm run dev:down            # stop the containers
```

For call-flow work, `infra/ansible/phase1-allinone.yml` puts the whole telephony stack on one VM
([docs/local-vm.md](docs/local-vm.md), [docs/phase1.md](docs/phase1.md)).

### 2.4 Cloud deployment

First deployment, DNS and course-service setup: [docs/cloud-deploy.md](docs/cloud-deploy.md).
After that, from `infra/ansible/`:

```bash
ansible-playbook site.yml --ask-vault-pass --limit db    # data tier first; then `patronictl list`
ansible-playbook site.yml --ask-vault-pass               # everything (idempotent)
ansible-playbook site.yml --ask-vault-pass --limit app   # API + website only
ansible-playbook site.yml --ask-vault-pass --limit pbx   # Asterisk + ARI app only
```

- **Ansible deploys your local checkout**, not GitHub: check out the commit you mean to ship.
- App, pbx and edge nodes are updated **one at a time** and must pass their health check
  (`/ready`, ARI `/health`) before the next.
- After adding or replacing a VM, run the whole playbook. `pg_hba`, the dispatcher list and the
  HAProxy backends are generated from the inventory.
- **Start / stop:** every service is a systemd unit: `kamailio`, `rtpengine-daemon`, `haproxy`
  (edges); `asterisk`, `pbx-ari-app` (pbx); `pbx-api`, `nginx` (app); `patroni`, `etcd`, `garage`
  (db); `pbx-dbproxy` on every DB client.
- **pbx deploys drain by themselves.** Restarting Asterisk or the call app drops that node's
  calls, so `--limit pbx` installs everything first and then, one node at a time, only if a
  restart is needed (`infra/ansible/tasks/pbx-rollout.yml`):
  1. dispatcher state `d` for the node on both edges (no new calls; `d`, not `i`, which the
     edges' pings switch back on),
  2. waits for 0 calls (prints the count and the longest call at the start, then "retries left"
     every 15 s; calls can last ~35 min, so a code deploy can take that long per node),
  3. restarts, waits for the call app's `/health`, sets state `a` on both edges, next node.

  Changes to `pjsip`, `extensions`, `rtp`, `musiconhold`, `indications`, `logger` or `prometheus`
  configs are **reloaded live** and need no drain; `asterisk.conf`, `modules.conf`, `ari.conf`,
  `http.conf`, a new Asterisk version and call-app code need a restart. Options:
  `-e pbx_drain_wait_min=60` (default 45); on a timeout the node goes back in service and the play
  stops, or `-e pbx_drain_on_timeout=deploy` restarts anyway (drops the remaining calls);
  `-e pbx_drain=false` restarts without draining (emergency). If a restart fails the node is left
  drained, and the message says how to put it back (`kamcmd dispatcher.set_state a 1
  sip:<pbx-ip>:5060` on both edges).
- **Stopped a pbx deploy halfway (Ctrl+C, timeout, failed restart)?** Just re-run it. A restart
  that didn't happen yet is remembered on the node (`/var/lib/pbx-restart-pending`), so the
  re-run drains and restarts it even though nothing "changed" any more. The rollout also refuses
  to drain a node while the other pbx node is out of service (that would leave no pbx node): put
  the other one back first.
- **Adding a pbx node:** add it to `[pbx]`, then `firewall.yml` (every node's `@cluster`),
  `--limit db` (Patroni's `pg_hba`, reloaded live), `--limit <new node>` (installs and starts it;
  the edges don't route to it yet, so the rollout skips the drain), `--limit edge` (dispatcher
  list and Kamailio's internal hops: Kamailio restarts, one edge at a time) and `--limit mon`.
  Adding a node re-hashes which node each account's calls go to (dispatcher algorithm 7): for a
  few minutes an attended transfer between a call from before and one from after may cross nodes.
  **Without restarting anything** (peak hours, or an edge holding TLS phones that won't reconnect):
  `patroni-config.yml` instead of `--limit db` (only Patroni's config + live reload; the full data
  tier play also downloads etcd/Garage and can restart them), and `dispatcher.yml` instead of
  `--limit edge` (only the dispatcher list + `kamcmd dispatcher.reload`). What stays stale until the
  next edge deploy: `private_hops` in kamailio.cfg (100 ms retransmits toward that node). Done this
  way for pbx-4/pbx-5 on 2026-11-23.
  Traps seen that day: (1) an interrupted run can leave `/etc/nftables.conf` written but never
  loaded, and later runs report "ok": compare `nft list set inet filter cluster` with the file;
  (2) new VMs may reach only the Debian mirror: copy `/usr/src/asterisk-<version>` (the role then
  skips the download), the `nodejs` package files (the ari_app role skips NodeSource when the right
  Node major is installed) and `/root/.npm` (+ `prefer-offline=true` in `/root/.npmrc`) from a
  running pbx node; (3) when SSH to the public IPs is lossy, run Ansible from mon-1 (private
  network) instead of from a laptop.
- **Resizing pbx nodes** (more vCPUs = more calls: maxcalls is 80 per vCPU): `pbx-resize.yml`, one
  node at a time, off-peak (it refuses 11-23 UTC unless `-e resize_allow_peak=true`, and refuses
  when the other nodes are already over 70 % of their maxcalls). Run it on mon-1:
  `ansible-playbook pbx-resize.yml --ask-vault-pass --limit pbx-1 -e resize_vcpus=8` (8 = the
  vCPUs of the target plan; read them off Clanode's resize page). It drains the node, waits for
  0 calls, then **pauses**: resize the VM in Clanode, wait for Running, press Enter. It then checks
  the vCPUs and that the private IP did not change, writes maxcalls into `asterisk.conf`, restarts
  Asterisk + the call app, waits for `/health` and puts the node back. A node already at the size is
  skipped (re-runs resume). Stopped before the resize: the node is put back. Stopped after it: the
  node stays drained; re-run the same command (it finishes a node left drained at the new size).
  Remove a stale `asterisk_maxcalls=` from the node's inventory line first, or it wins. The resize
  does not change the dispatcher hash (same nodes), so calls keep their node. First used for
  pbx-1..3 4G -> 16G (8 vCPU, maxcalls 640) on 2026-11-24.
  If the drain times out, the run lists the calls still up (channel, caller, seconds up) before it
  puts the node back: wait longer (`-e pbx_drain_wait_min=90`) or hang the stuck one up
  (`asterisk -rx 'channel request hangup <channel>'`).
- **Changing maxcalls** (no resize): the cap is `asterisk_calls_per_vcpu` x vCPUs
  (`group_vars/all/main.yml`, 80). Asterisk reads it only at startup, so every node needs a drain
  and a restart. Change the value in `group_vars` (commit it, so a later `site.yml` doesn't put the
  old one back), then `ansible-playbook pbx-resize.yml --ask-vault-pass -e maxcalls_apply=true`,
  off-peak: one node at a time, the same guards as a resize, only nodes whose `asterisk.conf`
  would change are drained, and each is put back after `/health` and the new limit check. A drain
  that times out puts the node back with the old cap. Raise it only when media can carry the
  calls: at the 2026-11-24 05:46 peak pbx-1..3 were at 640 with 61-67 % CPU while media-1..3 ran
  92-99 %; the cap is what turns overload into a 503 instead of silent audio. 100 per vCPU once
  every media node has 8 vCPU.
- **Resizing db nodes** (Postgres + Patroni, etcd and Garage on each; 1 vCPU saturated at the
  2026-11-24 05:40 ramp): `db-resize.yml`, one node at a time, off-peak (same 11-23 UTC guard and
  override). Never two db nodes down at once: that loses the etcd and Garage quorums and Patroni
  stops all writes. Run it on mon-1 (or WSL), in inventory order:
  1. Dry run first (validates the vault, etcd, Garage and that the rendered `patroni.yml` differs
     only in memory lines): `ansible-playbook db-resize.yml --ask-vault-pass --limit db-1 -e
     resize_vcpus=1`. A node already at the size only gets that check; nothing restarts.
  2. `ansible-playbook db-resize.yml --ask-vault-pass -e resize_vcpus=<vCPUs of the plan>`.
     Per node: guards (Patroni has every member, one Leader, replicas streaming within 16 MB; etcd
     healthy on all three; Garage sees all three; the Garage Volume is mounted). A Leader is
     switched over to the sync standby first (~5 s of write pause). Then tag `nosync` + reload
     (Patroni moves synchronous replication elsewhere, so no COMMIT waits on a node that is going
     away), stop Patroni, and **pause**: resize in Clanode, keep the Volume attached, wait for
     Running, press Enter. After the reboot: vCPUs, address and Volume checked, etcd / Patroni /
     Garage whole again, `patroni.yml` re-rendered (`shared_buffers` 25 % and
     `effective_cache_size` 70 % of the new RAM, nosync off) and Postgres restarted once **as a
     replica**. The primary is not switched back.
  Stopped before the resize: the tag is removed and Patroni restarted (a normal replica). Stopped
  after it: re-run the same command for that node. A rendered `patroni.yml` that would change more
  than the memory lines (repo or inventory drifted from the last deploy) stops the run; read
  the diff it printed, then `-e resize_allow_config_diff=true`. Such changes (e.g. `pg_hba` lines
  for new inventory hosts: media-4/5 on 2026-11-24) apply on the Patroni reload; Postgres restarts
  only when `shared_buffers` changed. V-P15, V-P16.
- **Adding media nodes** (rtpengine off the edges; the edges' CPU is mostly rtpengine). Kamailio
  then has two rtpengine sets: set 0 = the edges (where calls in progress live), set 1 = the media
  nodes, and a live switch decides which set NEW calls use. In this order:
  1. Create the VMs (public IP, Debian 13; cloud firewall SSH + UDP 30000-40000) and fill in the
     `[media]` group in `inventory/production.ini` (same variables as the edges).
  2. `--limit media`: rtpengine + firewall on the new nodes. Check `rtpengine --codecs` and
     `systemctl status rtpengine-daemon` there.
  3. `ansible-playbook firewall.yml --ask-vault-pass --limit 'pbx:app:db:mon:edge'`: only the
     host firewalls change (the media IPs join `@cluster`), nothing restarts. **Before step 4**, or
     the pbx nodes drop the media nodes' RTP. (Not `site.yml`: it would also deploy the pbx roles.)
     If existing media nodes are included, their reload now puts rtpengine's kernel-forwarding rules
     back (`rtpengine --nftables-start`); before 2026-11-23 it silently deleted them (`flush
     ruleset`) and their media ran in userspace until rtpengine restarted. Check afterwards:
     `nft list ruleset | grep -c 'jump rtpengine'` should be 2 on every media node.
  4. `--limit edge`: Kamailio with both sets, switch OFF, restarted one edge at a time (TLS and
     browser phones reconnect and re-register; calls in progress keep their media).
  5. **First** check that every set-1 node is up on both edges: `kamcmd rtpengine.show all` must
     show `disabled: 0` for each media node (otherwise new calls get 503 "Media Unavailable": on
     2026-11-15 ~180 failed in the minute after edge-1's restart, and media-2 stayed `disabled`
     until its cloud firewall allowed UDP 2223 from the edges). Then switch on, on both edges
     within a second: `kamcmd cfg.set_now_int pbx media_rtp 1` (check: `kamcmd cfg.get pbx
     media_rtp`). Back: the same with `0`. New calls only; calls in progress stay where they are.
  6. Watch ~40 min: the edges' rtpengine sessions drain to 0 (`rtpengine-ctl list numsessions`),
     media-node CPU, `/var/log/pbx/call-audio.jsonl` on the media nodes, SIP p95.
  7. Then set `rtpengine_media_new_calls: 1` in group_vars (what a Kamailio restart starts with;
     done 2026-11-15). It takes effect at the next edge deploy, which is a Kamailio restart; until
     then the live value holds. The edges' rtpengine stays as the fallback (switch back to 0).

- **Adding a node to a live media group** (2026-11-25, media-6): never just append it to set 1.
  Kamailio hashes each call's Call-ID over its set's member list and keeps the chosen node only in
  memory, so an edge restarted with a longer set 1 sends most calls in progress to an rtpengine that
  doesn't have them (their next 30 s refresh, hold or BYE: silence, 488/500). Instead the new node
  starts a NEW set, a new generation of the media group, and new calls move to it with the live
  switch; calls tagged `;rs=1` keep hashing over the unchanged set 1 until they end. Per-host
  inventory var `rtp_sets` (unset = `1`; members stay in inventory order):
  ```ini
  media-1 ... rtp_sets=1,2        # every existing node: in the old set AND the new one
  ...
  media-5 ... rtp_sets=1,2
  media-6 ... rtp_sets=2          # the new node: new set only
  ```
  Sets from `rtpengine_weights_from_set` (group_vars, 2) on are weighted by each host's
  `rtp_weight` (unset = 1; give a node with twice the vCPUs twice the weight), so a node's share of
  new calls follows its size; set 1 stays unweighted as deployed. A weight change is a member
  change: new set. (Set 2, 2026-11-25: all seven nodes 8 vCPU, every weight 1.)
  Steps 2 and 3 above (`--limit media-6`, then `firewall.yml`), then:
  1. Diff only, per edge: `ansible-playbook kamailio-config.yml --ask-vault-pass --limit edge-1`
     (renders `kamailio.cfg.new`, runs `kamailio -c`, prints the diff). It must ADD a `2 == ...`
     rtpengine_sock line and leave the `1 == ...` line byte-identical. If set 1 changes, stop.
  2. Restart one edge at a time: the same with `-e apply=true` (TLS/browser phones reconnect,
     calls in progress keep their media), then check `grep "open files" /proc/$(pgrep -o -u
     kamailio kamailio)/limits` and the TLS phones re-registering before the other edge. Keep
     `rtpengine_media_new_calls: 1` for now: a call put on set 2 by a restarted edge while the
     other edge still has no set 2 would lose its in-dialog handling there.
  3. Both edges restarted: `kamcmd rtpengine.show all` on BOTH must list set 2 with `disabled: 0`
     for every node (especially the new one), then on both edges within a second:
     `kamcmd cfg.set_now_int pbx media_rtp 2` (back: `1`). New calls only.
  4. Set `rtpengine_media_new_calls: 2` in group_vars (the value a later restart starts with).
  5. Set 1 can be retired after its last call ended (calls last up to ~35 min, +30 min hold: wait
     2 h, `rtpengine-ctl list numsessions` is no proof since the nodes are shared): drop `1,` from
     every `rtp_sets` at the next edge deploy. The next added node then starts set 3 (`2,3` / `3`).
  V-T25.
- **Draining one media node** (e.g. before resizing it): `kamcmd rtpengine.enable udp:<ip>:2223 0`
  on BOTH edges. New calls skip it; with `rtpengine_allow_op` (since 2026-11-24, needs the edges
  restarted with it) its calls in progress keep using it until they end. Wait until its sessions
  reach 0 (rtpengine journal "Closing call" lines stop / Prometheus `rtpengine` sessions), then
  work on it; back in: the same with `1`. Before `allow_op` was live, this command broke every call
  on the node at its next re-INVITE (2026-11-24 09:52, V-T24).

### 2.5 Testing

```bash
npm test                 # unit tests + call-flow spec suite (fake Asterisk, PGlite with the real migrations)
npm run typecheck
npm run test:configs     # render every telephony template; `kamailio -c`, `haproxy -c` (Linux/WSL)
```

On the deployed system, mon-1 tests continuously and alerts on failure:
- **synthetic call** every minute through each edge (register, call, answer, hang up);
- **codec quality test** every 15 minutes: audio both ways for every codec, including across a
  session refresh;
- **per-call audio record** on the edges: flags any customer leg that was silent in either
  direction.

Manual SIPp scenarios (per codec, hold, call waiting, load): [loadtest/sipp/README.md](loadtest/sipp/README.md).
Which test covers which part of the course spec: [docs/telephony-tests.md](docs/telephony-tests.md).

### 2.6 Assumptions about the cloud and course services

- 10 Clanode VMs, Debian 13, each 1 vCPU / 2 GB.
- Only the edges have public IPs, by 1:1 NAT onto the private address. The edges therefore bind
  the private IP and advertise the public one.
- No floating IP. The group domain has one A record and one target per SRV record, so phones
  reach one edge. The DID provider's trunk group lists both edges.
- The DID provider and PSTN vendors are prepaid and stop working at a $0 balance. The payment
  gateway has no webhooks.

Every assumption, with how it was checked: [docs/verify-backlog.md](docs/verify-backlog.md).

---

## 3. Scaling and load handling

**Summary.**
- **SIP:** our server answers in under 5 ms. The remaining SIP and API tail latency is mostly
  packets lost on the platform network, which cost a full protocol retransmit timer each.
  - Where the hop is ours, we shortened those timers.
  - Where it isn't (replies lost on the way to one course host), we measured it and reported it.
- **Load:** we moved the database off the call-setup path and removed per-call costs that grew
  with load.
- **Failures:** each silent-call cause found under real traffic was traced to one SIP/SDP
  interaction and fixed.
- **Still open:** transcoding CPU on 1-vCPU edges is the expected first capacity limit and hasn't
  been load-tested on the deployed system.

### 3.1 What grows with load

The course grades: completed calls per minute; failed, silent or misrouted legs and failed
registrations; p95 SIP response time (REGISTER, INVITE → first response, BYE, re-INVITE); p95
post-dial delay; API latency; outages. Each resource grows with something different:

| Resource | Grows with | Where |
|---|---|---|
| SIP signaling | devices × re-registration rate, plus calls/s × devices per extension | Kamailio (edges) |
| Media | concurrent legs × transcoding cost of each codec pair | rtpengine (edges) |
| Call control | concurrent calls, calls/s | Asterisk + one Node process per pbx node |
| Database | calls/s (CDRs) + API requests/s + billing | one Patroni primary |

### 3.2 How we found bottlenecks

- **Before launch:** we traced every request type (REGISTER, incoming call, outgoing call,
  re-INVITE, API write) through the design. For each step we counted database round trips,
  blocking workers and work that grows with load. These findings are listed in §3.4.
- **After launch:** the course's real traffic was our load test. We compared four views of the
  same requests to find where time or audio was lost:
  - the course dashboard's histograms;
  - Prometheus metrics;
  - HAProxy request timings;
  - packet captures on the edges, plus rtpengine's per-leg packet counts.

  The scripts are in `loadtest/diag/`. Each investigation has a write-up in
  [docs/incidents/](docs/incidents/).

### 3.3 Bottlenecks measured in production

**1. SIP response time: lost packets × retransmit timers.**
- *Evidence:*
  - **Our tail is resends, not slow work.** In the course's histogram (2026-11-15), 2,644 of our
    38,628 SIP transactions took 500–750 ms but only 6 took 300–500 ms. That is a UDP request
    resent after SIP's 500 ms timer.
  - **We answer fast, and our replies get lost.** Pairing every REGISTER in 11 h of edge capture
    with our reply: we answer in 4.5 ms at p99, but 4.3% of our replies to the course's phone
    simulator (130.245.136.125) never arrive. To the other course hosts, through the same socket
    in the same hours, the loss is 0.1–0.7%.
  - **It isn't edge-1's load.** Its kernel drop counters stayed at 0.
  - **Private hops lose packets too, about 0.5%.** One lost rtpengine command held a re-INVITE's
    200 OK for 1.008 s, its full timeout.
- *Change:* hops we own retry sooner:
  - Kamailio resends to Asterisk and the peer edge after 100 ms (it waited 500 ms);
  - Asterisk's retransmit timer (T1) is 100 ms;
  - rtpengine commands time out after 100 ms, with 7 tries (1 s before).
- *Effect:*
  - A loss on a private hop costs ~0.1 s instead of 0.5–1 s. INVITE p95 is 10–50 ms.
  - **Open:** REGISTER p95 stays ~600 ms while the course host keeps losing replies, and its
    REGISTERs are ~95% of our transactions. Reported to the course staff.
  - We did not resize edge-1: nothing measured blames it, and with one public IP a resize is an
    outage.
- [docs/incidents/2026-11-15-latency-tail.md](docs/incidents/2026-11-15-latency-tail.md)

**2. API latency tail: lost SYNs and uncached DID provider lookups.**
- *Evidence:*
  - **2026-11-13:** the course measured an API p99 of 3.6 s, but the API's own p99 was 0.19 s.
    HAProxy logs showed 47 of 6,021 requests spending ~1 s connecting to an app node, which is
    the kernel's retry after a lost SYN.
  - **2026-11-15:** 25 of the API's 35 requests over 1 s were `GET /numbers/countries`,
    `/regions` and `/cities` at ~1.05 s each. They called the DID provider on every request.
- *Change:*
  - HAProxy gives up on a connect after 250 ms and retries, the last try on the other app node.
    It also keeps and reuses connections to the app nodes (PR #39).
  - The three lists are cached per API process for 1 h and refreshed in the background (PR #63).
- *Effect:*
  - A lost SYN to an app node costs 0.25 s instead of 1–3 s.
  - The list routes no longer wait on the provider after the first request.
  - **Open:** the course's remaining 3–5 s requests were not slow at our HAProxy (its slowest
    request was 2.9 s), and every provider has them, including one with no customers.

**3. Silent and failed legs** (graded as failures). Each was found by comparing what each side
sent (rtpengine packet counts per direction, edge captures), reproduced, then fixed.
- **Codec switched mid-call.** After the answer, Asterisk sent a caller-ID update (re-INVITE).
  rtpengine turned it into a 5-codec offer to the phone, and at the phone's next 30 s refresh we
  switched codec while it kept PCMU. Fix: `send_connected_line=no`. Trade-off: no mid-call
  caller-ID update. [Write-up](docs/incidents/2026-11-14-codec-flip.md).
- **TLS phones silent (1 of 5 calls).** A phone answering with crypto suite tag 1 matched nothing,
  because rtpengine numbers its own offered suites and puts `AES_CM_128_HMAC_SHA1_80` 7th. Fix:
  offer only the two `AES_CM_128` suites.
- **G.723 phones silent (3 of 3 such answers).** A G.723 answer with an `fmtp` line plus DTMF made
  rtpengine 26.0.1 send Asterisk an answer with no audio codec. Fix: `reuse-codecs` on exactly
  those answers. [Write-up](docs/incidents/2026-11-15-g723-dtmf-answer.md).
- **Phones that never rang.** INVITEs to UDP phones were 1,602–1,609 bytes, above the edges'
  1,450-byte path MTU, so they were fragmented, and NATs that drop fragments lost them. Fix:
  ~220 bytes fewer headers.
- **Misrouted legs** in the first customer's call records: the caller's own number was rung back
  when it was also listed as the extension's external number, and blocked calls were recorded
  twice. Both fixed. [Write-up](docs/incidents/2026-11-13-first-customer.md).
- *Effect:* silent legs are now caught automatically by the per-call audio record and the codec
  quality test (§2.5).

**4. Post-dial delay: account cache reload.**
- *Evidence:* the synthetic call's first call each minute got 180 Ringing after 156 ms, and a
  call seconds later after 12 ms. An account's cached configuration expired after 30 s, and the
  next call waited for 9 queries to the primary. A small business rarely calls twice within
  30 s, so almost every call paid this.
- *Change:* configurations of accounts active in the last 10 minutes are reloaded in the
  background every 15 s.
- *Effect:* ~150 ms less post-dial delay, with the same 30 s freshness bound (so a paid account
  is still unblocked within the required minute).

**5. Database replicas wasting CPU.**
- *Evidence:* with almost no load, the replicas used ~31% CPU (the leader 9%). Patroni's
  replication connection to its own Postgres was refused 17 times a second, each time logging a
  traceback.
- *Change:* one `pg_hba` rule, applied by reload.
- *Effect:* 6–11% CPU. That CPU goes back to the reads the replicas serve (SIP authentication).

**6. Password hashing.**
- *Evidence:* with the library's default argon2id settings, one API process did ~28 hashes/s,
  with p95 1.1 s at 32 concurrent logins (`loadtest/api/argon2-bench.mjs`). The limit was
  memory, so a bigger thread pool didn't help.
- *Change:* OWASP's minimum argon2id settings (19 MiB, 2 passes). Old hashes still verify.
- *Effect:* ~160 hashes/s, p95 0.2 s. Measured on a 16-vCPU dev machine, not yet on an app VM.

### 3.4 Bottlenecks removed before launch (request-path analysis)

Most are pinned by a test (`services/ari-app/test/`, rendered-config checks), so a later edit
can't quietly undo them.

| Bottleneck | Change | Why it helps |
|---|---|---|
| Every REGISTER wrote to the DB primary, and Kamailio's workers block during each query. Registrations grow with devices, not calls | Registrations in Kamailio memory, replicated between edges (DMQ). Authentication reads go to replicas | REGISTER never touches the primary, and a 10–30 s primary failover no longer stops SIP |
| Several DB queries before answering a call, and 3 row writes per call | 180 Ringing before any lookup. Configuration from a per-node cache. CDRs spooled to local disk and inserted in batches after hangup | No DB round trip during call setup. A DB outage delays CDRs but loses none |
| Every ARI event was offered to every active call: cost grew with calls² | Events indexed by channel; parallel originate for simultaneous ring | O(1) work per event |
| Round-robin dispatch put an account's two calls on different Asterisks, which breaks attended transfer | Dispatcher hashes on the account id | An account's calls share one node; failover follows the hash order |
| Flood protection (pike) would block the course's simulators, which send a lot from few IPs | Course ranges bypass pike | Simulated load isn't dropped; internet scanners still are |

### 3.5 How the parts affect each other

- **Media vs. signaling:** rtpengine and Kamailio share each edge's single vCPU, so a transcoding
  spike would slow SIP responses.
  - Kernel forwarding takes plain relaying off the CPU.
  - The carrier and the US vendor use PCMU, so their legs don't transcode.
  - A `media` inventory group can move rtpengine to its own VMs.
- **Calls vs. database:** CDR inserts, the API and billing all write to one primary. The call path
  only reads from its cache and writes after hangup, so heavy API use or a failover slows CDR
  inserts, not calls.
- **CDR writes vs. search:** `cdrs` is insert-only with indexes for partial-number search. The
  batch flush interval trades how fast a call shows up in search against transactions on the
  primary.
- **Billing vs. calls:**
  - Rating happens at hangup from an in-memory rate deck, so billing only sums rows.
  - The weekly billing scheduler runs in every API process. Each unit of work is claimed with
    `FOR UPDATE SKIP LOCKED`, so the nodes split work with no leader and no double charges.
- **Affinity vs. balance:** hashing on the account keeps transfers working but puts a large
  account on one pbx node. `pbx_active_calls` per node shows whether that becomes a problem.

### 3.6 Trade-offs and open limits

- **No load ramp on the deployed system yet.** We expect transcoding CPU on the 1-vCPU edges to be
  the first limit, and plan to resize the edges or add `media` nodes when measurements show it.
  Every VM is on the smallest plan to keep cost down.
- **Losing an edge drops the calls whose audio it carries:** there is no floating IP to move
  rtpengine sessions. Phones registered through the domain also need a manual DNS change (one
  SRV target); carrier calls fail over through the trunk group.
- **Registrations live only in memory.** If both edges restart at once, phones must re-register,
  so edges are always deployed one at a time.
- **All writes go to one Postgres primary.** Partitioning `cdrs` and serving search from replicas
  are the next steps.
- **The kill-a-VM-under-load chaos drills (CLAUDE.md §16) have not been run.**

---

## 4. Design decisions

| Area | Decision | Reason |
|---|---|---|
| Stack | Kamailio + rtpengine + Asterisk with call logic in a Node ARI app; Ansible, no Kubernetes | Each tool does what it is built for. Call logic in TypeScript is testable without telephony hardware. For 10 VMs, Ansible is simpler than an orchestrator |
| Registrar | Kamailio, not Asterisk. Registrations in memory, replicated with DMQ, with a Path header naming the edge that holds the phone's connection | Any pbx node reaches any phone by sending to Kamailio. Registrations stay off the database |
| Media and codecs | rtpengine anchors every call. The Asterisk side is always PCMU; phones, carriers and vendors are offered all five codecs; browsers get PCMU | Asterisk needs decoded audio for prompts, recording and voicemail, and lacks free G.723.1/Opus support. Transcoding happens in one scalable place, and browser legs never transcode |
| WebRTC and TLS phones | rtpengine terminates DTLS-SRTP and SRTP-SDES; Kamailio serves TLS on 5061 with the same Let's Encrypt certificate as HAProxy | Asterisk nodes stay private, with no TURN server or public IPs |
| Load balancing | SIP: Kamailio dispatcher hashing on the account, failover on 500/503/timeout. HTTP: HAProxy on each edge, health check on `/ready`, retry on another node. Carrier: trunk group with both edges | Transfers need an account's calls on one Asterisk. Rolling deploys cause no failed requests |
| Concurrency | One Node process per pbx node, in-memory call state, indexed event bus. If the app is down, Asterisk answers 503 and Kamailio tries the other node | Single-threaded state per call is simple; a crash loses only that node's calls in progress |
| Caching | Per-node account snapshot, invalidated by Postgres `NOTIFY`, 30 s maximum age, refreshed in the background for active accounts. DID → account cache in Kamailio. DID provider lists cached in the API | No database round trip on call setup (§3.3 #4, §3.4) |
| Queuing | CDRs: local spool, then batched idempotent inserts. Recordings and voicemail: local spool, then upload to the object store | A database or object-store outage delays writes but loses nothing |
| Data storage | Postgres + Patroni + etcd on 3 nodes; each client reaches the primary through a local HAProxy on `127.0.0.1`. Garage with 3 copies on the same nodes | Node's and Kamailio's Postgres drivers handle multi-host failover poorly; a local proxy adds no single point of failure |
| CDRs, rating, billing | One insert-only row per leg, rated at hangup by longest prefix with 30/6 increments. Every external leg (forward, simultaneous ring, transfer) is its own charged CDR. Prices have database `CHECK` ceilings | Matches the spec's per-leg CDR fields. The ceilings make an overcharge impossible even after a bad config change |
| Billing periods | Weekly periods from the signup day in the account's time zone. One table for every recurring item, with the price locked at purchase | One renewal loop for every item kind; no rounding drift |
| Payments | Cards saved with a SetupIntent through Stripe.js, so card numbers never reach us. Off-session charges with one Idempotency-Key per attempt. Retries at 5 min, 15 min, 1 h, 3 h, then every 6 h; past due 24 h after the period ends | The gateway has no webhooks, so we read the result directly. Keys make retries safe |
| Purchases | Number and add-on purchases are idempotent (`Idempotency-Key`) and resumable (order → trunk → charge → row) | A client retrying after a lost response can't buy or pay twice |
| Fault tolerance | Every role on 2+ VMs (database on 3); rolling deploys behind health checks; clients reconnect across a failover; systemd restarts every service | The spec requires surviving the loss of any one VM |
| API | REST, OpenAPI 3.1 at `/openapi.json`, everything the website does is in the API, tenant isolation rules on every route ([docs/backend-step3.md](docs/backend-step3.md)), keyset paging for CDR search | The course's tools drive the API from the OpenAPI document. Keyset paging stays fast on large tables |
| Authentication | Signed JWT in an httpOnly cookie (15 min access, 7 day refresh); argon2id passwords; operator routes use a separate bearer token | No session store to replicate across API nodes |
| Network security | Cloud firewall opens only the public SIP, TLS, HTTPS and media ports on the edges. nftables allowlists per role on every host; internal services bind private IPs. Kamailio accepts carrier calls only from the carrier's IP and strips our internal headers from outside requests. Secrets only in Ansible Vault | The cloud firewall can't filter by source address, so the hosts do |

Detailed reasoning: [docs/spec-transition.md](docs/spec-transition.md) (telephony),
[docs/backend-for-team.md](docs/backend-for-team.md) (API),
[docs/billing-flows.md](docs/billing-flows.md) (billing),
[docs/hold-call-waiting.md](docs/hold-call-waiting.md) (hold and call waiting).

---

## 5. Developer guide

### 5.1 Repository structure

| Path | Contents |
|---|---|
| `services/shared` | Code shared by the API and ARI app: DB access, zod schemas (call destinations, IVR config), number classification, billing rules |
| `services/api` | Fastify API. `src/routes/` one file per resource, `src/billing/`, `src/numbers/` (DID provider), `src/openapi/` |
| `services/ari-app` | Call control. Entry points `inbound.ts` (carrier) and `device.ts` (phones); `router.ts`, `ring.ts`, `conversation.ts`, `voicemail.ts`; `cache.ts`, `cdr.ts`; `ari/` is our own ARI client |
| `services/web` | React dashboard and SIP.js softphone (`src/softphone/`) |
| `db/migrations`, `db/kamailio` | App schema (dbmate, plain SQL); Kamailio's schema plus our `subscriber` columns |
| `telephony/` | Kamailio, Asterisk and rtpengine templates. The header of `kamailio/kamailio.cfg.j2` explains every route |
| `infra/ansible` | `site.yml`, inventories, `group_vars`, one role per component |
| `loadtest/` | `sipp/` scenarios and pcaps, `api/` benchmarks, `diag/` production latency diagnostics |
| `dev/` | docker-compose, PGlite test server, setup scripts |

### 5.2 Where to read more

| Document | Read it when you |
|---|---|
| [docs/telephony-contract.md](docs/telephony-contract.md) | change tables or JSON the call path reads, or the softphone's SIP behaviour |
| [docs/split-contracts.md](docs/split-contracts.md) | touch inventory variables, ports, health checks, DB or S3 contracts |
| [docs/spec-transition.md](docs/spec-transition.md) | need the reasoning behind the telephony design |
| [docs/backend-for-team.md](docs/backend-for-team.md) | work on the API |
| [docs/billing-flows.md](docs/billing-flows.md) | work on purchases, invoices or past due |
| [docs/cloud-deploy.md](docs/cloud-deploy.md) | deploy or rebuild VMs |
| [docs/telephony-tests.md](docs/telephony-tests.md) | add or look for tests |
| [docs/verify-backlog.md](docs/verify-backlog.md) | rely on or check an assumption about the platform or course services |
| [docs/incidents/](docs/incidents/) | want what production traffic revealed, with evidence |

### 5.3 Adding or changing a feature

- **API endpoint:** add a route in `services/api/src/routes/` following the tenant isolation rules
  ([docs/backend-step3.md](docs/backend-step3.md)). Its zod schema puts it in `/openapi.json`. Add
  a test in `services/api/test/`.
- **Schema:** add a new dbmate migration (never edit an applied one). If the call path reads the
  table, update [docs/telephony-contract.md](docs/telephony-contract.md) and the `pbx_config`
  NOTIFY triggers in the same PR.
- **Call behaviour:** change the ARI app module and add a spec test in
  `services/ari-app/test/spec/` (fake Asterisk + PGlite with the real migrations).
- **SIP or media config:** edit the template in `telephony/`, then run `npm run test:configs` and
  `npm test` (content checks in `services/ari-app/test/configs.test.ts`).
- **Infrastructure:** edit the role. A new shared variable, port or vault key also goes in
  [docs/split-contracts.md](docs/split-contracts.md).
- **Tests:** commands in §2.5; which test covers which spec section in
  [docs/telephony-tests.md](docs/telephony-tests.md).
- **Unverified assumptions:** add a row to [docs/verify-backlog.md](docs/verify-backlog.md) and
  close it with evidence once checked.

### 5.4 Debugging common problems

| Symptom | Check |
|---|---|
| Carrier call gets 403 | Source IP not in `carrier_cidrs` |
| Phone gets 401/407 repeatedly | The extension's `subscriber` row; replica lag right after creating it; `kamcmd ul.dump` on both edges |
| No audio or one-way audio | `rtpengine-ctl list sessions all` on the edge; `sngrep` for the SDP; `/var/log/pbx/call-audio.jsonl` (packets each way per leg) |
| Does an SRTP phone get valid audio when the RTP from Asterisk changes SSRC? | `loadtest/diag/remote.sh edge-2 py loadtest/diag/srtp-ssrc-replay.py --ip 10.0.0.42`: four ~6 s test sessions through that edge's rtpengine, decrypted as the phone would (usage in its header) |
| Every call to one pbx node gets 503 | ARI app down: `systemctl status pbx-ari-app`, `curl 127.0.0.1:9101/health` |
| Calls ignore a configuration change | `pbx_config` NOTIFY triggers (the cache refreshes within 30 s anyway) |
| API answers 503 | `curl :3000/ready` on the app node (DB + S3); local proxy stats; `patronictl list` |
| CDRs missing | ARI app's CDR spool and logs; they flush once the primary is back |
| Course dashboard shows high SIP or API latency | `loadtest/diag/`: `sip-retransmits.py` on an edge capture, `haproxy-slow.py`, `api-routes.sh` (usage in each file header) |
| Failures rise with load: our capacity, or something per call? | `loadtest/diag/`: `load-shape.py` on mon-1 (per 15 min: calls/min, % per outcome, silent legs, peak calls per pbx node, busiest CPU; a flat failure share = per-call cause, a rising one with a pinned VM = capacity), `sip-codes.py` on an edge (final replies by method and code; 487 is normal, look at 408/480/5xx), `invite-delay.py` on an edge (first reply time of our INVITEs to phones: clusters at 0.5/1.5/3.5/7.5 s = lost packets, spread out = slow phones). All read-only; usage in each file header |
| A failure or ticket at a known time: what did that call do? | On the pbx node: `journalctl -u pbx-ari-app -o cat \| grep '"msg":"call ended"'`. Each line has the call's SIP Call-ID (`sip`, the same id as in edge captures and `/var/log/pbx/call-audio.jsonl`) and its ordered route trace (`trace.steps`: route targets, business hours with local time, IVR digits, forwarding, ring results, transfers, voicemail) |
| What SIP did a phone, the carrier or a vendor exchange with us (any transport, TLS and browsers included)? | Each edge keeps 12 h of SIP history in `/var/log/pbx/sipdump` (hourly pcaps, decrypted; capped at 10 GB by the hourly `pbx-sipdump-prune` timer, oldest hours go first). `loadtest/diag/remote.sh edge-1 py loadtest/diag/sip-history.py --dir /var/log/pbx/sipdump --since 10:55 --until 11:00 --match <number or SIP user>` (also `--call-id`, `--method`, `--failed`, `--full`; usage in its header). On a live edge the window is capped at 2 h and the script caps its own memory (300 MB); for longer windows copy the pcaps off the edge first: a full-day scan once froze edge-1 for 11 minutes |
| Stale types after changing `services/shared` | `npm run build -w @pbx/shared` |

Other tools: `sngrep` (SIP call flow on an edge), `kamcmd dispatcher.list`,
`asterisk -rx "core show channels"`, Grafana on mon-1.

### 5.5 Known issues and future work

- Telephony assumptions still unchecked on the VMs (12 items, e.g. rtpengine kernel forwarding,
  ARI transfer event fields, Asterisk and rtpengine metrics endpoints): [docs/verify-backlog.md](docs/verify-backlog.md).
- Load ramp and chaos drills on the deployed system (§3.6).
- REGISTER replies lost toward one course host (§3.3 #1), reported to the course staff.
- No rtpengine session failover and one DNS target for phones (§3.6).
- API: no login rate limiting; JWTs can't be revoked before they expire; SIP passwords are stored
  in plaintext so the softphone can fetch them (course-scope decision); no password change route.

---

## 6. Team process and contributions

### 6.1 Goals and how we set them

We took our goals from what the course grades (CLAUDE.md §1):
- **Fault tolerance:** every component survives the loss of any single VM, so every role runs on
  at least 2 VMs (the database on 3) and deploys are rolling.
- **Scale:** low p95 SIP response time and post-dial delay, and no failed or silent legs as load
  grows (§3).
- **Correct billing:** customers are never overcharged, enforced by price ceilings in the
  database.

When the course spec was published on 2026-11-08, we checked every early design assumption against
it ([docs/spec-transition.md](docs/spec-transition.md)) and reset the plan to match.

### 6.2 Members

**Daniel He** (`dhe30`): telephony; project lead
- *Responsibilities:* telephony (`telephony/`, `services/ari-app`, the edge and pbx roles),
  repository maintenance.
- *Leadership:* led coordination. Proposed the tracks and tasks, wrote the shared spec
  ([CLAUDE.md](CLAUDE.md)) and the contracts between tracks, reviewed and merged most PRs.
- *Major contributions:*
  - designed the telephony architecture and built the phase-1 telephony VM (#2);
  - rebuilt it for the course spec: extensions, outgoing calls, transfers, CDRs (#4);
  - took the system to the cloud: NAT'd edges, Let's Encrypt, website deployment (#12, #16, #17,
    #20, #22, #23, #25);
  - after launch, traced and fixed silent legs and latency from production evidence (#38, #46,
    #48, #56, #58, #62, #63).
- *Tasks completed:*
  - scaffold #1;
  - DID provider search fix #13;
  - support tickets API #14;
  - verification backlog #15, #16, #19;
  - course adapter fixes #24;
  - softphone spec checks #26;
  - attended transfer during call waiting #28;
  - routing page fixes #29, #43;
  - pricing and API contract fixes #35, #37;
  - first-customer analysis #40;
  - quality, long-call and audio-record tests #57, #59, #60, #61;
  - latency write-up #64.

**Aaron Peng** (`aaronp51`): backend
- *Responsibilities:* `services/api`, `services/shared`, `db/migrations`, the `api` role.
- *Major contributions:*
  - the whole API in eight steps: accounts, tenant isolation, extensions, call configuration,
    media, voicemail, call history, number purchase (#3, #5, #7, #8);
  - billing: add-ons, weekly invoices, past due, prices by prefix (#11);
  - the OpenAPI document.
- *Tasks completed:*
  - test fixes #6;
  - API deployment role and argon2id benchmark #11;
  - [docs/backend-for-team.md](docs/backend-for-team.md);
  - first full README #30.

**Justin Cheng** (`JustinC0320`): frontend
- *Responsibilities:* `services/web`.
- *Major contributions:* the React dashboard and the card payment flow (#18), the call routing
  page (#27), support tickets in the website (#31).
- *Tasks completed:* end-to-end testing on production as a customer would use it:
  - signup and adding users;
  - calls to and from the website softphone, between extensions and to external numbers;
  - call routing.

**Muhammad Fahad Babar** (`muhammadfahadbabar-byte`): database and observability
- *Responsibilities:* data tier and monitoring roles (`etcd`, `postgres_patroni`, `db_local_proxy`,
  `objectstore`, `monitoring`, `backups`).
- *Major contributions:*
  - the highly available data tier: etcd, Patroni + Postgres 16, local DB/S3 proxy, 3-node Garage
    (#9);
  - monitoring and alerting on mon-1 (#21, #33, #34);
  - nightly backups with a weekly restore test (#33);
  - the synthetic call (#44, #45) and codec quality test (#53).
- *Tasks completed:*
  - data-tier docs #10;
  - HAProxy connect retry #39;
  - Patroni replica fix #47;
  - background config refresh #50;
  - TLS phone audio fix #51;
  - faster card save #54;
  - prompt race fix #42;
  - scaling write-up #49;
  - price updates #41, #52, #55.

### 6.3 Communication and division of work

- **Communication:** a Discord group chat.
- **Division of work:** Daniel proposed the responsibilities and tasks, and each member chose
  theirs. The work was split into four tracks so they could proceed in parallel:
  - data tier (Muhammad);
  - telephony (Daniel);
  - API and web (Aaron, Justin);
  - monitoring and backups (Muhammad).
- **Contracts between tracks:** written interfaces let each track build and merge without waiting
  for the others. Changing a contract needed review from every track owner.
  - [docs/split-contracts.md](docs/split-contracts.md) fixes shared names, ports and variables.
  - [docs/telephony-contract.md](docs/telephony-contract.md) is the contract between the API and
    the call path.

### 6.4 Progress tracking and milestones

- **Pull requests:** every change went through a PR into `main` (64 by 2026-11-15).
- **Assumptions:** the verification backlog tracked each open assumption with its evidence.
- **Deadlines:** we put the four tracks ahead of Ansible configuration, documentation and the API
  contract, and split large shared tasks such as production testing between members.

| # | Milestone | Target | Completed |
|---|---|---|---|
| 0 | Repo scaffold and layout | — | 10/26 |
| 1 | All-in-one telephony VM: IVR, recording, voicemail, hold, call waiting | 10/29 | 10/29 |
| 2 | API foundation (auth, tenants, staff, call configuration) | 11/08 | 11/08 |
| 3 | PBX rebuilt to the course spec | 11/09 | 11/09 |
| 4 | Data tier HA (Patroni, etcd, Garage, local proxies) | 11/09 | 11/10 |
| 5 | API complete (media, voicemail, call history, numbers, billing) | 11/10 | 11/11 |
| 6 | Frontend complete | 11/11 | 11/12 |
| 7 | First full cloud deployment on 10 VMs | 11/12 | 11/12 |

From 11/13 on, live customer traffic set the work. Each problem it revealed got a written
investigation in [docs/incidents/](docs/incidents/) and a fix PR (#32–#64).
