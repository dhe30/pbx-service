# First cloud deployment (telephony)

How to take the telephony from the local VM ([local-vm.md](local-vm.md)) to the course cloud and
check it against the real course services. Start with **one VM** (all-in-one). Split into 2 edges
+ 2 pbx only after everything here passes.

**Status (2026-11-09):** the code passes every offline check (169 tests, `kamailio -c`), but
nothing has run against real Asterisk, rtpengine, the carrier or the vendors. §4 lists, in order,
what to check and what to change if a check fails. Background:
[spec-transition.md](spec-transition.md) §6.

**Not covered here:**
- The split deployment (§5 below has the outline). The data-tier roles (`etcd`,
  `postgres_patroni`, `db_local_proxy`, 3-node `objectstore`) are implemented and were tested on
  Clanode (PR #9, [split-contracts.md](split-contracts.md) §5).
- The API/web. Without them the graded simulated customers can't sign up; create test accounts
  with the seed or SQL (§3).

## 1. Create the VM

- **OS and size:** Debian 13, 2+ vCPU (4 if you load-test codecs), 4 GB RAM, 25 GB disk.
- **Network:** a **public IPv4 and a private IP** (rtpengine needs two addresses).
- **Cloud firewall, inbound:**

  | Port | For |
  |---|---|
  | UDP 5060 | carrier, vendors, desk phones |
  | TCP 5061 | SIP over TLS (`_sips._tcp` phones) |
  | TCP 80 | Let's Encrypt HTTP-01 challenges (everything else redirects to HTTPS) |
  | TCP 443 | HTTPS + WSS (softphone) |
  | UDP 30000-40000 | rtpengine media |
  | TCP 22 | SSH (your IP only, if the platform allows) |

  The host firewall (nftables, `common` role) opens the same ports on the VM itself.

## 2. Configure

**Inventory:** copy `infra/ansible/inventory/allinone.ini` and fill in `PUBLIC_IP` /
`PRIVATE_IP`.
- If the public IP is NATed onto the VM (not on its interface, check `ip -4 addr`), also set
  `public_bind_ip=<the VM's local address>`. **On Clanode this is always the case** (1:1 NAT onto
  the VM's only, private, address): `public_bind_ip` = `private_ip` on every edge
  (`inventory/production.ini` already does this; verify-backlog V-P10).
- To test with SIPp from your own machine, add it to the carrier list **with a port**, so the
  same machine can also act as a phone on other ports:
  ```ini
  pbx-aio ansible_host=... public_ip=... private_ip=... asterisk_sip_port=5080 carrier_cidrs="['130.245.136.142/32', '<your public IP>:5062']"
  ```

**Vault:** generate `group_vars/all/vault.yml` with fresh random secrets, never copy the example
(the repo is public): `infra/ansible/scripts/new-vault.sh`, fill in its `CHANGE_ME` values, then
`ansible-vault encrypt`. One vault per deployment, shared by the whole team (encrypted file and
vault password over separate channels). The `CHANGE_ME` values:
- `vault_vendor_us_user` / `_password` and `vault_vendor_intl_user` / `_password`: the **digest
  credentials** from the Course Services tab. They go only in the encrypted vault, never in any
  other file.
- `vault_stripe_secret_key` / `vault_stripe_publishable_key` (payment gateway test keys) and
  `vault_did_api_key` (DID provider): needed by the API (split deployment, §5).

The script also generates random `vault_test_alice_password` / `vault_test_bob_password`: keep
them random, port 5060 is public and will be scanned.

**DNS (Group tab):**
- an A record for `group-4.cse356.compas.cs.stonybrook.edu` -> the public IP;
- `_sip._udp` SRV -> that name, port 5060;
- `_sips._tcp` SRV -> that name, port 5061.

Check from your machine: `dig +short SRV _sip._udp.group-4.cse356.compas.cs.stonybrook.edu`.

**Certificates (Let's Encrypt, automated by the `edge_haproxy` role).** One publicly trusted
certificate for `group-4.cse356.compas.cs.stonybrook.edu` serves HTTPS + WSS (HAProxy, also what
the course's API adapter fetches `/openapi.json` through: it rejects self-signed certificates)
and SIP over TLS (Kamailio 5061, `_sips._tcp` phones).
- **Before the first run:** add an inbound **TCP 80** rule in the Clanode cloud firewall for the
  edges (by hand: the playbook can't change the cloud firewall; nftables on the VM is opened by
  the `common` role). The Group tab's A record must point at the edge in `acme_edge` (default
  the first `[edge]` host, edge-1).
- **How it works:** HAProxy's `:80` frontend sends `/.well-known/acme-challenge/` to certbot's
  standalone server on `127.0.0.1:8888` and redirects everything else to HTTPS. Only `acme_edge`
  requests the certificate (HTTP-01; DNS-01 is impossible, the Group tab's DNS has no API). It
  checks first that every name resolves to its public IP, so a wrong A record doesn't burn Let's
  Encrypt's failed-validation limit (5 per hour). The other edge copies cert + key from it on each
  playbook run (so a DNS failover to it serves the same name). Every edge installs it with
  `/usr/local/sbin/pbx-install-cert`: `/etc/haproxy/certs/site.pem` (fullchain + key) and
  `/etc/kamailio/tls/{cert,key}.pem` (group kamailio, 0640), then reloads HAProxy and runs
  `kamcmd tls.reload` (restart only as a fallback), only when something changed.
- **Until the first issuance** HAProxy and Kamailio use the self-signed fallback, so they always
  start. If issuance fails (DNS points elsewhere, port 80 closed), the play shows the reason as
  an **ignored** failure on that edge and goes on with the current certificate; fix it and rerun
  the edge play: `ansible-playbook site.yml --limit edge --ask-vault-pass`.
- **Settings** (`group_vars/all/main.yml`): `acme_enabled` (false = keep self-signed, e.g. the
  local VirtualBox VM), `acme_edge`, `acme_domains` (web_domain + sip_domain), `acme_email`
  (empty = no expiry mails; use a team address, the repo is public), `acme_staging`.
- **Test first with staging** (untrusted certs, generous rate limits):
  `-e acme_staging=true`, check `curl -vk https://group-4.../openapi.json` shows a `(STAGING)`
  issuer, then rerun without it: the role replaces a staging certificate with a production one.
  Production limits: 5 identical certificates per week, so don't loop on production.
- **Renewal:** Debian's `certbot.timer` on `acme_edge` renews it ~30 days before expiry; the
  deploy hook `/etc/letsencrypt/renewal-hooks/deploy/pbx-install-cert` installs it there. The
  other edge gets the renewed certificate on the **next playbook run** of the edge play. A
  certificate is valid 90 days, which outlasts the course, so in practice no renewal is needed.
  Dry run: `certbot renew --dry-run` on `acme_edge`.
- **DNS moved to the other edge** (V-P1/V-P5 manual failover): nothing to do right away, that
  edge already serves a copy of the same certificate. For renewals to keep working there, set
  `acme_edge: edge-2` in `group_vars/all/main.yml` and rerun the edge play (it then issues its
  own; the old edge's certbot timer just fails its HTTP-01 renewals harmlessly).
- Check (from your machine): `openssl s_client -connect group-4.cse356.compas.cs.stonybrook.edu:443
  -servername group-4.cse356.compas.cs.stonybrook.edu </dev/null | openssl x509 -noout -issuer -enddate`;
  the same with `:5061` shows Kamailio's copy.

## 3. Deploy and seed

```bash
cd infra/ansible
ansible-playbook -i inventory/<your copy>.ini phase1-allinone.yml --ask-vault-pass -e test_did=+1XXXXXXXXXX
```
`test_did` puts **your real purchased number** (§3.2) into the seeded test account. The default
`+15555550100` is fake. The run ends by waiting for the ARI app's `/health`.

### 3.1 Course services (Course Services tab)
1. **Fund the vendors** (Bank -> Pay). At $0 the DID provider refuses orders and stops delivering
   calls, and the PSTN vendors answer every call with `402 Payment Required`.
2. **Rate decks:** download `us-vendor-rates.csv` and `intl-vendor-rates.csv` (you must be
   logged in), copy them to the VM, then:
   ```bash
   cd /opt/pbx/src
   set -a; . /etc/pbx/ari-app.env; set +a
   npm run rates:import -w @pbx/ari-app -- us /tmp/us-vendor-rates.csv
   npm run rates:import -w @pbx/ari-app -- intl /tmp/intl-vendor-rates.csv
   ```
   Without decks, calls still work, but `cost` is 0 and international calls are charged the
   minimum price.

### 3.2 Inbound trunks and a real number (DIDWW API v3)
Base URL and `Api-Key` are on the Course Services tab (JSON:API: `Accept`/`Content-Type:
application/vnd.api+json`; with curl use `-g`, or the `[...]` in filters is eaten by curl's
globbing).

**Trunks (once per deployment, and again whenever an edge's public IP changes):** one
`voice_in_trunks` per edge (name `edge-1`/`edge-2`, priority 1, weight 50), both in one
`voice_in_trunk_groups`; its id is `did_trunk_group_id` in `group_vars/all/main.yml`. SIP
configuration (`configuration.type = sip_configurations`; send the whole set on every PATCH):

| Attribute | Value | Why |
|---|---|---|
| `host` / `port` / `transport_protocol_id` | edge public IP / 5060 / 1 (UDP) | |
| `username` | `{DID}` | puts the number in the Request-URI user (arrives as `16316756654`, no `+`; verify-backlog V-D9) |
| `sip_timer_b` | **2000** (default 8000) | how long the provider waits for ANY reply before trying the other trunk: with an edge down, each incoming call otherwise waits ~8 s (post-dial delay is graded; V-D11). A live edge answers `100 Trying` within milliseconds |
| `codec_ids` | leave `[8, 9, 10, 7, 6]` | G.729, PCMU, PCMA, G.723, DTMF. Pinning to PCMU is possible but deferred (V-D5) |

**A test number:** `npx tsx scripts/verify-course-services.ts didww-buy --yes` in
`services/api` buys a local number through our own provider code and assigns it to the trunk
group (V-D6/V-D7). Ours: **+16316756654**. Deploy with `-e test_did=+16316756654`. To make it ring
before the course traffic is on, call it through the US vendor:
`loadtest/sipp/vendor-probe.sh us 6316756654 +16316756654` (V-V8).

## 4. Checks, in order

Watch on the VM while testing:
```bash
sngrep                                   # SIP ladder
journalctl -u pbx-ari-app -f
journalctl -u kamailio -f
```

| # | Check | How | If it fails |
|---|---|---|---|
| 1 | Services up | `kamcmd dispatcher.list` (FLAGS AP); `asterisk -rx "pjsip show endpoints"` (edge-a + vendor-* listed); `curl -s 127.0.0.1:9101/health` | Role logs; `docs/phase1.md` §6 |
| 2 | Codecs available | `rtpengine --codecs`: **PCMU, PCMA, G723, G729, opus with encode + decode** | Missing G729: the bcg729 build; missing G723/opus: the ffmpeg build of the rtpengine package |
| 3 | Kernel forwarding | `lsmod \| grep -i rtpengine`; `journalctl -u rtpengine-daemon \| grep -i kernel` | It falls back to userspace on its own; check the DKMS build log. Works without it, just more CPU |
| 4 | Browser registers | `https://<public ip>/webrtc-test`, domain `group-4.cse356...`, user alice; `kamcmd ul.dump` | 401 loop: password vs `kamailio.subscriber`; nothing: HAProxy `/ws`, cert accepted |
| 5 | Inbound from your SIPp (port 5062) | `uac_inbound.xml`, press 1: alice and bob ring, answer -> audio both ways; a `cdrs` row appears | 403: `carrier_cidrs` IP/port; no audio: firewall UDP 30000-40000, `public_bind_ip` |
| 6 | **Forking audio** | Register alice in two browsers (or browser + SIPp), call, answer on the **second** one: audio both ways | Per-branch rtpengine legs (`via-branch=extra`, `extra_id_pv` in kamailio.cfg) |
| 7 | Codec matrix | `uac_inbound_codec.xml` once per codec ([loadtest/sipp/README.md](../loadtest/sipp/README.md)): audio both ways each time | rtpengine flags in kamailio.cfg (`TO_PBX_CODECS` / `TO_FAR_CODECS`) |
| 8 | **Transfers** (riskiest) | Bob (desk phone) blind- and attended-transfers a call to 101 ([local-vm.md](local-vm.md) §7). Logs should show `ChannelTransfer` / `blind transfer` / `attended transfer` | "could not enable ARI transfer handling", or nothing logged: the Asterisk 22 option/event names differ. Fix `ari/types.ts` (ChannelTransfer fields) and `conversation.ts`. Check with `asterisk -rx "core show function PJSIP_TRANSFER_HANDLING"` |
| 9 | Hold | Hold from the browser and from bob: the other side hears music | [hold-call-waiting.md](hold-call-waiting.md) §5 |
| 10 | TLS phone | A softphone with TLS transport to `group-4...:5061`: registers; SDP toward it has `a=crypto` (SDES) | Cert valid for the name; `RTP/SAVP DTLS=off` flags (staff_tls) |
| 11 | **Vendor call** | Bob dials a real or simulated US number: in `sngrep`, INVITE -> 407 -> INVITE with credentials -> 180/200; then try an international number with `intl_calling` on | 402: fund the vendor. 403/404 from the vendor: number format, flip `vendor_number_format` (e164 / e164_noplus) and redeploy. Caller ID rejected: check what it must be |
| 12 | **Real carrier call** | Call your DID from a phone listed under "Real phones" on the Course Services tab (or wait for simulated traffic): the IVR answers; `cdrs` row with direction incoming | No INVITE at all: trunk / DID assignment / DID provider balance. INVITE but 404: Request-URI format (the `didCandidates()` normalization in the ARI app) |
| 13 | Testers' source IPs | Turn **Traffic on**, then list REGISTER/INVITE sources in Kamailio's log or `sngrep` | Put the ranges in `trusted_tester_cidrs` (pike must not throttle them) and redeploy |
| 14 | DTMF from the carrier | IVR digits work on a real carrier call | If the carrier sends in-band DTMF only (no RFC 4733), rtpengine needs DTMF detection (CLAUDE.md §3 A4) |

Record what you find (especially for 8, 11 and 12) in [verify-backlog.md](verify-backlog.md):
mark the item done with the result and evidence, and turn its [VERIFY] into a fact.

## 5. Then: split deployment

Once §4 passes on one VM (or, if you skip the all-in-one VM, run §4 against the split
deployment after step 3 here):
1. Create the edge, pbx, app and db-1..3 VMs. On Clanode the VMs only get a private IP: add a
   public IPv4 to the two edges, and create every VM with an SSH key (password logins are
   refused). Check that a private-only VM can reach the internet (`apt update`, `curl
   https://github.com`): pbx, app and db nodes download packages, the Asterisk source, Patroni,
   etcd, Garage and npm packages.
2. Fill in the addresses in `inventory/production.ini` (the default inventory); the other VMs
   are reached through edge-1 (ProxyJump). Set `did_provider_url` and the inbound trunk group id
   (`did_trunk_group_id`, or `did_trunk_id` for a single trunk; §3.2) in
   `group_vars/all/main.yml`, not in the inventory: values under `[app:vars]` lose to main.yml.
   The vault needs the API keys (§2). The `api` role refuses to run until all of these are set.
3. Deploy layer by layer, checking each before the next (from the WSL copy of the repo,
   [local-vm.md](local-vm.md) §2):
   ```bash
   ansible-playbook site.yml --ask-vault-pass --limit db    # then on db-1: patronictl list
   ansible-playbook site.yml --ask-vault-pass               # everything (idempotent)
   ```
   `--limit db` stops after the data tier's own plays (one leader, two replicas, `garage status`
   shows 3 nodes). The full run then adds the local proxies, API, pbx and edges in that order.
   Each app/pbx/edge node is updated one at a time (`serial: 1`) and must pass its health check
   (`/ready`, ARI `/health`) before the next one is touched.
   - Code updates later: `ansible-playbook site.yml --ask-vault-pass --limit app` (API) or
     `--limit pbx` (ARI app). After adding or replacing a VM, run everything: the db nodes'
     `pg_hba` and the edges' HAProxy/dispatcher lists are built from the inventory.
4. Additionally check:
   - registration replication: REGISTER via edge-1, then `kamcmd ul.dump` on edge-2 shows it;
   - a call routed through edge-2 to a phone connected to edge-1 has audio;
   - all of one account's calls land on the same pbx node (`pbx_node` in `cdrs`);
   - killing one edge or one pbx VM mid-test: new calls still work, browsers reconnect.
5. Kamailio already reads through the local proxy's read-only port (`db_ro_port` = 5433, replicas
   first), so SIP auth survives a primary failover; nothing to set.
