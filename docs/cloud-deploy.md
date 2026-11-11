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
  | TCP 443 | HTTPS + WSS (softphone) |
  | UDP 30000-40000 | rtpengine media |
  | TCP 22 | SSH (your IP only, if the platform allows) |

  The host firewall (nftables, `common` role) opens the same ports on the VM itself.

## 2. Configure

**Inventory:** copy `infra/ansible/inventory/allinone.ini` and fill in `PUBLIC_IP` /
`PRIVATE_IP`.
- If the public IP is NATed onto the VM (not on its interface, check `ip -4 addr`), also set
  `public_bind_ip=<the VM's local address>`.
- To test with SIPp from your own machine, add it to the carrier list **with a port**, so the
  same machine can also act as a phone on other ports:
  ```ini
  pbx-aio ansible_host=... public_ip=... private_ip=... asterisk_sip_port=5080 carrier_cidrs="['130.245.136.142/32', '<your public IP>:5062']"
  ```

**Vault:** `group_vars/all/vault.yml` from `vault.yml.example`. In addition to the passwords:
- `vault_vendor_us_user` / `_password` and `vault_vendor_intl_user` / `_password`: the **digest
  credentials** from the Course Services tab. They go only in the encrypted vault, never in any
  other file.
- `vault_test_alice_password` / `vault_test_bob_password`: use real passwords. Port 5060 is
  public and will be scanned.

**DNS (Group tab):**
- an A record for `group-4.cse356.compas.cs.stonybrook.edu` -> the public IP;
- `_sip._udp` SRV -> that name, port 5060;
- `_sips._tcp` SRV -> that name, port 5061.

Check from your machine: `dig +short SRV _sip._udp.group-4.cse356.compas.cs.stonybrook.edu`.

**Certificates:** the playbook makes self-signed ones. They're fine for a first test with the
browser (accept the warning once), but real TLS phones and the graders' browsers need a real
certificate for `group-4...`. Get one (e.g. Let's Encrypt; [VERIFY] whether outbound access is
allowed). Then:
- Kamailio: `/etc/kamailio/tls/cert.pem` + `key.pem` (owner root, group kamailio, mode 0640),
  then `systemctl restart kamailio`.
- HAProxy: cert + key concatenated into `/etc/haproxy/certs/site.pem`, then
  `systemctl reload haproxy`.

The playbook only creates the self-signed files if they don't exist, so it won't overwrite yours.
Automating issuance and renewal is still a TODO (phase 7).

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

### 3.2 A real number (DIDWW API v3)
Base URL and `Api-Key` are on the Course Services tab. Until the API team's purchase flow
exists, do it by hand with `curl` (JSON:API, `Content-Type: application/vnd.api+json`):
1. Find a number: `GET /available_dids` (filter by country / DID group).
2. Order it: `POST /orders`.
3. Create an **inbound trunk** (`POST /voice_in_trunks`, SIP configuration) with host = the
   edge's public IP (or the group domain), port 5060, UDP.
   - [VERIFY] how the Request-URI user is set (we expect the DID, with or without `+`);
   - [VERIFY] whether you can pin the codec to PCMU (saves transcoding on every incoming call).
4. Assign the DID to the trunk: `PATCH /dids/<id>` with the `voice_in_trunk` relationship.
5. Re-run the playbook with `-e test_did=<the number>`, or update `phone_numbers.did` in SQL.

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

Record what you find (especially for 8, 11 and 12) in [spec-transition.md](spec-transition.md)
§6, and turn each [VERIFY] into a fact.

## 5. Then: split deployment

Once §4 passes on one VM:
1. Create the edge, pbx, app and db-1..3 VMs (`inventory/staging.ini` layout). On Clanode the VMs
   only get a private IP: add a public IPv4 to the edges (and to one VM you SSH through), and
   create them with an SSH key (password logins are refused).
2. Run `site.yml`.
3. Additionally check:
   - registration replication: REGISTER via edge-1, then `kamcmd ul.dump` on edge-2 shows it;
   - a call routed through edge-2 to a phone connected to edge-1 has audio;
   - all of one account's calls land on the same pbx node (`pbx_node` in `cdrs`);
   - killing one edge or one pbx VM mid-test: new calls still work, browsers reconnect.
4. Kamailio already reads through the local proxy's read-only port (`db_ro_port` = 5433, replicas
   first), so SIP auth survives a primary failover; nothing to set.
