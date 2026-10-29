# Phase 1: all-in-one telephony VM

Goal (CLAUDE.md §17): Kamailio + rtpengine + Asterisk + ARI app (+ Postgres + Garage) on one VM,
with the final config structure. An inbound call (SIPp or a softphone acting as the carrier)
reaches the IVR, rings a browser and a UDP phone, and recordings + voicemail land in the object
store.

```
 SIPp "carrier" ──UDP 5060──► Kamailio ──► Asterisk (5080) ──Stasis──► ARI app ──► Postgres
         ▲                       │  ▲            ▲   │                      └──────► Garage (S3)
         │ RTP 30000-40000       │  │ ng 2223    │   │ originate PJSIP/alice@edge-a
         └──────────────► rtpengine ◄────────────┘   ▼
 Browser ──wss 443──► HAProxy ──ws 8080──► Kamailio (location lookup) ──► browser / UDP phone
```

## 1. Prerequisites

Local VirtualBox VM instead of a cloud VM: follow `docs/local-vm.md` (uses
`inventory/local-vm.ini`), then come back to §4 for the checks.

- **VM**: Debian 13 (or 12), 2+ vCPU, 4 GB RAM, 20 GB disk, **a public IPv4 and a private IP**.
- **Cloud firewall**: allow TCP 22, UDP 5060, TCP 443, UDP 30000-40000.
- **Control machine**: Linux, or WSL on Windows (Ansible doesn't run natively on Windows):
  ```bash
  sudo apt install ansible rsync
  cd infra/ansible && ansible-galaxy collection install -r requirements.yml
  ```
  On WSL, clone the repo inside the Linux filesystem (e.g. `~/pbx-service`). Ansible ignores
  `ansible.cfg` in world-writable directories such as `/mnt/c/...`.
- SSH as root to the VM with your key.

## 2. Configure

1. `infra/ansible/inventory/allinone.ini`: replace `PUBLIC_IP` / `PRIVATE_IP`.
2. `infra/ansible/group_vars/all/main.yml`: set `carrier_cidrs` to the public IP of the machine
   that will run SIPp / your softphone (otherwise Kamailio rejects its INVITEs with 403).
   Optionally change `sip_domain` and `test_did`.
3. Secrets:
   ```bash
   cd infra/ansible
   cp group_vars/all/vault.yml.example group_vars/all/vault.yml
   # fill in values (generation commands are in the file), then:
   ansible-vault encrypt group_vars/all/vault.yml
   ```

## 3. Deploy

```bash
ansible-playbook -i inventory/allinone.ini phase1-allinone.yml --ask-vault-pass
```

The first run builds Asterisk from source (~15 min). Re-runs are idempotent and only restart
what changed. The playbook ends by waiting for the ARI app's `/health` to return 200.

## 4. Test

### Browser (WebRTC)
1. Open `https://<PUBLIC_IP>/webrtc-test`, accept the self-signed certificate warning.
2. Domain = `sip_domain`, user `alice`, password = `vault_test_alice_password`. Click **Go online**.
   Status should become *registered as alice*.

### UDP phone (bob)
Any softphone (Linphone, MicroSIP, Zoiper): server `<PUBLIC_IP>`, UDP, user `bob`, domain
`sip_domain`, password `vault_test_bob_password`. Or use SIPp (`loadtest/sipp/README.md`).

### Place a call (fake carrier)
From a machine in `carrier_cidrs`:
```bash
cd loadtest/sipp
sipp -sf uac_inbound.xml -s 15555550100 -p 5062 -m 1 <PUBLIC_IP>:5060
```
or dial `15555550100@<PUBLIC_IP>` from a softphone on that machine.

| Press | Seeded behaviour (db/seeds/test_tenant.sql)                        |
|-------|--------------------------------------------------------------------|
| 1     | Ring alice + bob together, 20 s; no answer -> voicemail "Main"     |
| 2     | Voicemail "Main"                                                   |
| 0     | Ring alice only; no answer -> voicemail "Alice"                    |
| none  | After 3 tries -> voicemail "Main"                                  |

Call recording is ON for the test tenant. The menu greeting is Asterisk's stock "hello world"
until greetings can be uploaded through the API (phase 2).

### Hold and call waiting (browser)
Details: `docs/hold-call-waiting.md`. Use two caller softphones (or SIPp + a softphone), press 0
(rings alice only).
1. Call 1 -> alice answers -> **Hold**. Caller 1 hears music on hold.
2. Call 2 while 1 is held -> alice hears a short call-waiting beep -> **Answer**.
3. Hang up call 2 -> **Resume** call 1. Two-way audio is back and MOH stops.
4. While talking on call 1, call 2 again -> **Answer** directly: call 1 is held automatically.
5. **Decline** a waiting call: it goes to alice's voicemail (486).
6. Long hold: hold call 1 for > 2 min, then resume. The call must still be up, with audio.
SIP phones: `loadtest/sipp/README.md` (hold + call waiting section).

### Check the results (on the VM)
```bash
sngrep                                         # live SIP ladder diagrams
journalctl -u pbx-ari-app -f                   # call flow logs (JSON)
kamcmd ul.dump                                 # who is registered
kamcmd dispatcher.list                         # pbx nodes and their state
asterisk -rx "pjsip show endpoints"            # trunks to Kamailio (should be Avail)
rtpengine-ctl list sessions all                # active media sessions
curl -s 127.0.0.1:9101/health                  # {"ari":true,"db":true}
sudo -u postgres psql pbx -c "select started_at, caller_number, disposition, recording_media_id from calls order by started_at desc limit 5"
sudo -u postgres psql pbx -c "select * from voicemails order by created_at desc limit 5"
garage bucket info pbx-media                   # object count grows with recordings
```

### Failure checks that already apply in phase 1
- `systemctl stop pbx-ari-app` -> new calls get 503 from Asterisk (Stasis fails). With one pbx node
  there is nowhere to fail over yet. `systemctl start pbx-ari-app` -> calls work again.
- Kill the ARI app mid-call (`systemctl kill pbx-ari-app`): it restarts in 2 s, hangs up the
  orphaned call, and the uploader sweep uploads any recording left in the spool.
- Reload the browser page during a call: the softphone reconnects, re-registers, and the next
  call reaches it (its old contact is replaced, not left dangling).

## 5. Decisions made in phase 1 (not in CLAUDE.md)

Confirmed with you up front: **Ansible all-in-one** provisioning, **Garage** object store,
**self-signed TLS** for now, **ARI app under systemd** (not Docker).

Made during implementation (change any of these if you disagree):

1. **Kamailio 6.0** (not 5.8, which is end-of-life). Rendered config validated with
   `kamailio -c` against 6.0.8.
2. **Debian 13 (trixie)** as the target OS (12 also works). HAProxy comes from Debian (3.0 on
   trixie), Postgres 16 from PGDG, rtpengine from rtpengine.dfx.at (26.0 LTS), Node from
   NodeSource.
3. **Node 24 LTS** instead of 20: Node 20 reached end of life in April 2026.
4. **Own typed ARI client** (`services/ari-app/src/ari/`, about 200 lines of fetch + `ws`) instead
   of wrapping `ari-client`, which is unmaintained and untyped. It doesn't reconnect: on WebSocket
   loss the process exits and systemd restarts it (crash-only), then it hangs up orphaned
   channels.
5. **All-in-one ports**: Asterisk listens on `private_ip:5080` because Kamailio owns `:5060`. Set
   per host with `asterisk_sip_port`. In the split deployment it's 5060 again.
6. **Carrier allow-list**: rendered into kamailio.cfg from `carrier_cidrs` (ipops
   `is_in_subnet`), not the `permissions` module's DB table. It's config-as-code and needs no DB
   on the INVITE path. Changing it means redeploying the edge.
7. **One contact per staff user** (`save("location", "0x04")`): the newest registration wins. A
   browser that reconnects after an edge failure replaces its dead contact instead of ringing it
   too. Downside: a user can't be logged in on two devices at once.
8. **Multi-edge delivery uses Path + received**: REGISTER stores
   `Path: <sip:<edge private ip>:5060;lr;received=<client addr>>`. The edge holding the connection
   delivers directly; any other edge relays to it. Written for phase 4, **not exercised** with one
   edge.
9. **Kamailio tables in a `kamailio` schema of the same `pbx` database** (role search_path). The
   API can then create a user and their `subscriber` row in one transaction. Schema SQL is
   committed in `db/kamailio/` (6.0 branch).
10. **DIDs stored as E.164 with `+`**. The ARI app adds the `+` if the carrier sends digits only.
11. **Recording crash safety**: a `.meta.json` sidecar is written before each recording. Local
    files are deleted only after upload + DB insert, and a sweep retries every minute. Uploads are
    idempotent (unique media id). Voicemails under 1 s are dropped.
12. **rtpengine in userspace only** (`table = -1`, no kernel module). Simpler install; revisit in
    the phase-6 capacity tests.
13. **Asterisk prompts in u-law** (CORE-SOUNDS-EN-ULAW) and `rtp_timeout=60` on the trunks, so a
    call with dead media is hung up instead of staying open silently.
14. **Default prompts** are stock Asterisk sounds (`hello-world`, `vm-intro`,
    `option-is-invalid`, `vm-goodbye`) until tenants upload greetings.
15. **Garage S3 key is imported from Vault** (`garage key import`), so a rebuilt store keeps the
    same credentials.
16. **Carrier IPs may also REGISTER** (auth still required), so one test machine can be both the
    fake carrier and a staff phone.
17. **Hold + call waiting** (added 2026-10-28): decisions D1-D8 in `docs/hold-call-waiting.md`
    (recording continues while held, 30 min max hold, stock MOH, no call limit per softphone, decline
    = 486, auto-hold on answer, no busy check, no hold columns in the DB). Staff legs are tagged
    `leg=staff_ws` / `leg=staff_udp` in Record-Route (was `leg=staff`), so in-dialog requests
    get the right rtpengine flags with two edges as well.

## 6. Not verified yet (check on the first real deploy)

Validated locally: TypeScript typecheck + unit tests, every template renders, Ansible
`--syntax-check`, and the rendered `kamailio.cfg` passes `kamailio -c` (6.0.8). **Nothing has run
on a VM yet.** Watch these on the first deploy:

- [ ] rtpengine flags for WebRTC (`RTP/SAVPF ICE=force DTLS=passive ... generate-mid`) with
      current Chrome/Firefox. Symptom if wrong: browser answers but no audio.
- [ ] `rtpengine --codecs` on the VM lists PCMU, PCMA, G723, G729, opus (A4 transcoding).
- [ ] ARI `sound:/var/lib/asterisk/sounds/cache/<id>` absolute-path playback (tenant greetings;
      only matters once the API uploads greetings).
- [ ] `RecordingFinished` arrives when the caller hangs up during voicemail (otherwise the sweep
      uploads it ~2 min later instead of immediately).
- [ ] Hangup cause mapping: Kamailio 480 -> cause 18/20 (no trunk failover) and 503 -> 34
      (failover to edge-b). Only matters with two edges.
- [ ] Garage `node id -q` output format and layout commands on first boot.
- [ ] Hold/resume (browser and SIPp), MOH with recording on and off, held call surviving > 60 s:
      the checklist in `docs/hold-call-waiting.md` §5.
- [ ] The Asterisk build's dependency list on Debian 13 (bundled pjproject/jansson are downloaded
      at build time, so the VM needs outbound internet).
