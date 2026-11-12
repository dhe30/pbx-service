# Verification backlog

Everything we have **assumed but not yet checked** against the real thing (course services,
Clanode, real Asterisk/rtpengine/Kamailio, course traffic), in one list. Ground truth is the
course grading site (Project, Course Services and Group tabs); where this file and the site
disagree, the site wins.

**How to use it**
- Pick open items whose **Needs** you can meet today; check them; record the result.
- Done: set Status to `done YYYY-MM-DD`, write what you found in **Result** (the fact, and the
  evidence: a command, log line, probe output), fix the code/docs if the assumption was wrong,
  and remove the `[VERIFY]` marker at **Where**.
- New assumption: whenever you write `[VERIFY]` in code or docs, add a row here in the same
  change (next free ID in that section). Don't renumber: IDs are referenced from commits/PRs.
- Wrong assumption found: fix it in its own PR and link the PR in Result (example: V-D1).

**Needs**
- `now`: no deployed nodes needed (course pages, API keys, a read-only probe, WSL).
- `deploy`: needs our nodes up in the cloud (`docs/cloud-deploy.md` §5).
- `purchase`: spends course money (a DID order, a vendor call). Fund the provider first.
- `call`: needs real SIP calls through the deployed system (softphone, SIPp, a real phone).
- `traffic`: needs course traffic turned on (Course Services → Customers → Turn on).
- `staff`: only the course staff can answer.

Read-only probe scripts used so far (GET only, print no secrets) can be re-run from WSL; ask in
a session for a fresh copy, or see PR #13 for what they checked.

---

## Course services: DID provider (DIDWW v3 clone)

The project page links DIDWW API v3 version 2026-04-16, but the clone differs in places (V-D1).

| ID | Status | Assumption to check | How to check | Needs | Where | Result |
|---|---|---|---|---|---|---|
| V-D1 | done 2026-11-11 | `available_dids` includes, filter spellings, DID group / SKU shapes | Read-only probes | now | `numbers/didww.ts` | Only `include=did_group,did_group.stock_keeping_units` is accepted (we asked for more: every search 400'd, fixed in PR #13). Filters `filter[country.id\|region.id\|city.id\|did_group_type.id\|number_contains]` OK; `did_group.`-prefixed ones 400. Groups carry type/country/region/city as relationship ids + `prefix`, `area_name`, `is_metered`. SKU: `setup_price`, `monthly_price` (per 7 days), `channels_included_count`. `page[size]` ignored on `available_dids`. |
| V-D2 | done 2026-11-11 | Toll-free incoming per-minute fee is in the API (R20) | Probes + Course Services tab | now | `numbers/didww.ts` | Not in the API. The tab publishes it: US toll-free $0.025/min, UK $0.05/min, other numbers none. Now `TOLL_FREE_IN_COST_PER_MIN` (PR #13). |
| V-D3 | done 2026-11-11 | Our trunk group exists with both edges and `{DID}` as the R-URI user | `GET /voice_in_trunk_groups/:id?include=voice_in_trunks` | now | `group_vars/all/main.yml` | Both trunks present, priority 1 / weight 50 each, user `{DID}`. Both edges' public IPs changed 2026-11-11 (an IP move detached them): trunks PATCHed to edge-1 130.245.136.131, edge-2 130.245.136.155. Re-PATCH the trunk whenever an edge's public IP changes (`configuration.attributes.host`; send the whole SIP configuration). |
| V-D4 | done 2026-11-11 | Whether the clone applies the region / city / type / `number_contains` filters at all (results are re-checked client-side either way) | Search one city; check that every returned offer's group has that city id | now | `numbers/didww.ts` | All applied: `filter[city.id]` and `[region.id]` (Austin) 100/100 Austin offers, `[did_group_type.id]` Toll-free 100/100 metered, `[number_contains]=1631` 100/100. Included DID groups do carry relationship ids (`data` + `links`). `page[size]` ignored (always 100), `page[number]` works, `meta.total_count` 17858. Unfiltered US page: 28 toll-free + 7–15 per city (Austin, Brooklyn, Chicago, LA, NY, SF, Stony Brook) + Real PSTN. |
| V-D5 | done 2026-11-11 | Trunk codec settings: can the carrier leg be pinned to PCMU (A4; saves transcoding on every incoming call)? | `GET /voice_in_trunks/:id`: look for `codec_ids` in the SIP configuration; PATCH if supported | now | CLAUDE.md §3 A4 | Yes: `configuration.attributes.codec_ids` is settable. Both trunks have `[8, 9, 10, 7, 6]` = G.729, PCMU, PCMA, G.723, telephone-event (ids from DIDWW docs 2026-04-16; the clone has no `/codecs` endpoint), so G.729 is preferred today. **Not pinned yet:** if the provider doesn't transcode, a single-codec caller (spec §3) could fail on a PCMU-only trunk. Decide with load tests: V-D12 + a call per codec with `[9, 6]`. |
| V-D6 | open | `POST /orders` with `did_order_items {sku_id, available_did_id}`; statuses Pending/Completed/Canceled; "taken" = 422/404/409 | Buy one local number through the deployed API (`POST /numbers/purchase`) | purchase, deploy | `numbers/didww.ts`, `backend-step8.md` | |
| V-D7 | open | Assigning a DID: `PATCH /dids/:id` with relationship `voice_in_trunk_group` | Same purchase; then `GET /dids/:id?include=voice_in_trunk_group` | purchase, deploy | `numbers/didww.ts` | |
| V-D8 | open | Release (R17): `billing_cycles_count: 0` stops renewal and the number keeps working to period end; spec says "then release it at the provider" (explicit call at period end?) | Release the test number; watch it at the 7-day boundary; check the clone's DID after it | purchase, 7 days | `numbers/didww.ts`, `billing/scheduler.ts`, R17 | |
| V-D9 | open | Request-URI user format on carrier INVITEs: with or without `+` (A3) | First carrier call: `sngrep` on the edge | call, purchase | CLAUDE.md §3 A3, ARI app `didCandidates()` | Partly: trunk `username` = `{DID}` puts the DID in the R-URI user. (`use_did_in_ruri: true` is also set, but DIDWW documents it as effective only with SIP registration, which is off.) The clone stores numbers without `+` (e.g. `12126619476`), so expect no `+`; `didCandidates()` accepts both. |
| V-D10 | done 2026-11-11 | DTMF from the carrier is RFC 4733, not in-band (A4) | Trunk config | now | CLAUDE.md §3 A4, `cloud-deploy.md` §4 #14 | `rx_dtmf_format_id` = `tx_dtmf_format_id` = 1 = RFC 2833 (DIDWW docs), RFC 4733's predecessor with the same payload. Matches rtpengine `telephone-event`. The first IVR call on a real number still exercises it (`cloud-deploy.md` §4 #14). |
| V-D11 | open | Trunk group failover: with one edge down, carrier calls go to the other trunk (A7) | Stop Kamailio on edge-1, call the DID | call, deploy | CLAUDE.md §3 A7 | |
| V-D12 | open | Codecs the carrier offers (A4) | SDP of the first carrier INVITE | call | CLAUDE.md §3 A4 | |
| V-D13 | open | Real phones to the shared numbers (201) 633-6004/-6005 arrive "addressed to that number". We don't own those numbers, so our DID lookup won't find an account: decide how to route them (test account? reject?) | Call from a registered member phone; look at the R-URI and what the ARI app does | call, deploy | Course Services tab "Real phones", ARI app `inbound.ts` | 2026-11-11: both numbers are on sale in the clone: `12016336004`, `12016336005`, DID group "Real PSTN" (type National, prefix 201, not metered), SKU 0.00 setup / 1.50 per week. Per the Project tab, the group that buys one gets its calls on its own trunk; otherwise they reach our `_sip._udp` SRV target addressed to a number we don't own. Decide: buy one for real-phone testing, or route unknown DIDs somewhere useful. |
| V-D14 | open | The provider hangs up a call after `rtp_timeout` 30 s without RTP (trunk config). Hold must keep audio flowing toward the carrier (MOH), and so must any long silence | Hold a carrier call for > 60 s, then resume | call, purchase | trunk config, `conversation.ts` (MOH on hold) | |

## Course services: payment gateway (Stripe clone)

| ID | Status | Assumption to check | How to check | Needs | Where | Result |
|---|---|---|---|---|---|---|
| V-S1 | done 2026-11-11 | API base URL and Stripe.js URL | Course Services tab; probe | now | `group_vars/all/main.yml`, `config.ts`, `stripe.ts` | `https://stripe.cse356.compas.cs.stonybrook.edu` and `.../v3/` (tab). `GET /v1/customers`, `/setup_intents`, `/payment_methods`, `/payment_intents` and Stripe.js all 200 with our secret key. |
| V-S2 | done 2026-11-11 | Webhooks are available | Project tab §1 feature list | now | `billing-flows.md` §4 | Not listed (Customers, PaymentMethods, SetupIntents, PaymentIntents, idempotent requests). Don't rely on webhooks: read the PaymentIntent result, as designed. |
| V-S3 | open | The exact form fields we send are accepted (`metadata[tenant_id]`, `invoice_settings[default_payment_method]`, `off_session=true&confirm=true`, Idempotency-Key) | One signup through the deployed API with a Stripe test card; then a charge | deploy | `billing/stripe.ts`, `backend-card-signup.md` | |
| V-S4 | open | Test cards behave as documented (declines, `requires_action` treated as failure) | Signup with Stripe's decline / 3DS test cards | deploy | `billing-flows.md` §4–5 | |

## Course services: PSTN vendors and rate decks

| ID | Status | Assumption to check | How to check | Needs | Where | Result |
|---|---|---|---|---|---|---|
| V-V1 | open | US vs international split by NANP area code (`NON_US_NANP`): Canada/Caribbean → intl, US territories + toll-free → US | Download both rate decks (Course Services tab links, logged in); compare the `+1` prefixes against `NON_US_NANP` | now | `shared/src/numbers.ts`, spec-transition S14 | |
| V-V2 | open | Rate deck CSV format imports cleanly (prefix, destination, price; longest prefix wins) | `npm run rates:import` on a pbx node (cloud-deploy §3.1); spot-check a few prefixes | deploy | ARI app `rates:import` | |
| V-V3 | open | Vendor R-URI number format: `+E.164` vs no `+` (`vendor_number_format`) | First vendor call: 404/403 → flip and redeploy | call, purchase | ARI app `config.ts`, `group_vars` | |
| V-V4 | open | Caller ID the vendors accept (must be one of the account's numbers) | Same call: check From/P-Asserted-Identity handling | call, purchase | ARI app `device.ts` | |
| V-V5 | open | Codecs the vendors offer/accept | SDP of the first vendor call | call | CLAUDE.md §18 | |
| V-V6 | open | Source IPs of the vendors' in-dialog requests (BYE, re-INVITE) are handled by Kamailio | Vendor call ended by the far side; `sngrep` | call | `kamailio.cfg.j2` WITHINDLG | |
| V-V7 | open | Digest auth flow: INVITE → 407 → INVITE with credentials → 180/200 | First vendor call | call, purchase | Asterisk `pjsip.conf` vendor endpoints | |

## Platform (Clanode) and DNS

| ID | Status | Assumption to check | How to check | Needs | Where | Result |
|---|---|---|---|---|---|---|
| V-P1 | done 2026-11-11 | DNS: multiple A / SRV targets for edge failover (A7) | Group tab | now | CLAUDE.md §3 A7 | One IP for the A record and one per SRV record. Browsers and SRV phones reach one edge; carrier calls still use both via the trunk group. Manual failover: change the IP on the Group tab. See V-P5. |
| V-P2 | done 2026-11-11 | Floating / shared IPs | Clanode UI | now | CLAUDE.md §2, §18 | No floating IP option. |
| V-P3 | done 2026-11-11 | Private-only VMs have outbound internet (apt, npm, GitHub, PyPI) | `curl -sI https://deb.debian.org` on a VM without a public IP | now (VMs exist) | `cloud-deploy.md` §5 step 1 | Yes, all 9 VMs (`verify-vms.sh` §2): HTTPS 200 to Debian, NodeSource, PGDG, npm, GitHub, PyPI, downloads.asterisk.org, rtpengine.dfx.at, Let's Encrypt. Default route via 10.0.0.1 (the platform NATs outbound). No public IPs needed on pbx/app/db. |
| V-P4 | done 2026-11-11 | Cloud firewall filters private traffic between VMs (if yes, an inbound rule for `10.0.0.0/16` is required) | Temporary listener on db-1, connect from each VM (`verify-vms.sh` §3) | now (VMs exist) | `cloud-deploy.md` §5 | Private TCP passes with the firewall rules as configured on 2026-11-11: edge-1, edge-2, pbx-1, app-1, db-2 → db-1:45678 all OPEN. TCP only tested (UDP: SIP/RTP between edge and pbx is covered by the first call). Re-check if the firewall rules change. |
| V-P9 | done 2026-11-11 | SSH to edge-1's public IP (also the jump host for every private VM) | `ssh root@130.245.136.131 true` | now | `inventory/production.ini` | .135 had timed out because the IP move had detached it from edge-1 (Clanode showed it on both VMs for a while). Edge-1 got a new IP, 130.245.136.131; inventory, DIDWW trunk and DNS updated. Ansible reaches all 9 VMs (ProxyJump via .131). |
| V-P10 | done 2026-11-11 | The public IP is on the VM's interface | `ip -4 addr` (`verify-vms.sh` §2) | now | `public_bind_ip`, `kamailio.cfg.j2`, `rtpengine.conf.j2` | **No: 1:1 NAT onto the only (private) address.** Both edges have a single IPv4 (edge-1 `ens3 10.0.1.13/16`, edge-2 `ens3 10.0.0.42/16`), yet SSH on their public IPs works. The edge templates didn't handle this (with `public_bind_ip = private_ip`, Kamailio got no public UDP/TLS listener and advertised no public address): fixed in templates 2026-11-11 (V-T10); `public_bind_ip` = private IP set for both edges in `production.ini`. |
| V-P11 | open | VM sizes fit the roles (`cloud-deploy.md` suggests 2–4 vCPU / 4 GB for edges and pbx: rtpengine transcoding, Asterisk built from source) | `verify-vms.sh` §2 on every VM; resize in Clanode if the quota allows (V-P8) | now | `cloud-deploy.md` §1 | 2026-11-11: **every VM is 1 vCPU, 1973 MB RAM, 29 GB free**, Debian 13. Works for a first deploy (the Asterisk source build will be slow, ~30+ min per pbx node), but 1 vCPU per edge caps transcoding capacity (rtpengine `num-threads` = 1). Resize edges and pbx first if the quota allows; measure with the codec load test (V-T8) before deciding. |
| V-P5 | done 2026-11-11 | Can a public IP be detached from one VM and attached to another (a manual floating IP for edge failover)? | Clanode UI on a spare VM | now | CLAUDE.md §2 | Yes, but with side effects: moving edge-1's IP to edge-2 detached it from edge-1 (the UI lagged and showed it on both), and both edges ended up needing new public IPs (edge-1 130.245.136.131, edge-2 130.245.136.155), which meant updating the inventory, both DIDWW trunks, DNS and `known_hosts`. Lesson: never move an edge's IP casually; after any IP change follow that checklist. Using a moved IP for failover would also need the receiving edge's Kamailio/rtpengine/HAProxy to listen on it (unless the IP is NATed: see V-P3 output). Not adopted: manual either way, and DNS failover is simpler. Runbook + README scaling analysis. |
| V-P6 | open | Several A records or SRV targets can be added for us (edge HA) | Ask the course staff | staff | CLAUDE.md §3 A7 | |
| V-P7 | open | Outbound access for Let's Encrypt (real cert for the group domain) | `certbot` dry run on an edge | deploy | `cloud-deploy.md` §2 | Partly, 2026-11-11: the ACME API is reachable from both edges (HTTPS 200). Still open: how to answer the challenge. HTTP-01 needs inbound TCP 80 on the edge the A record points to (not opened in the cloud firewall or nftables yet); TLS-ALPN-01 needs 443 before HAProxy takes it; DNS-01 isn't possible (no API for the Group tab's DNS). |
| V-P8 | open | VM quota (how many VMs the group can run: scale-out headroom) | Clanode UI / staff | now | CLAUDE.md §18 | |

## Telephony on real nodes

Step-by-step order: `docs/cloud-deploy.md` §4. Background: `docs/spec-transition.md` §6.

| ID | Status | Assumption to check | How to check | Needs | Where | Result |
|---|---|---|---|---|---|---|
| V-T1 | open | `rtpengine --codecs` shows encode+decode for PCMU, PCMA, G723, G729, opus | On an edge | deploy | CLAUDE.md §1, §8 | |
| V-T2 | open | rtpengine kernel forwarding loads (else userspace, more CPU) | `lsmod \| grep -i rtpengine` | deploy | CLAUDE.md §8 | |
| V-T3 | open | Transfers: `ChannelTransfer` event fields, `transfer_progress`, `PJSIP_TRANSFER_HANDLING()` settable via ARI (Asterisk 22.11) | Blind + attended transfer from a desk phone and the softphone | deploy, call | `ari/types.ts`, `conversation.ts`, spec-transition N9 | |
| V-T4 | open | Forking: `via-branch=extra` gives each branch its own leg; the answering one has audio | Two devices on one extension; answer on the second | deploy, call | `kamailio.cfg.j2` | |
| V-T5 | open | `RTP/SAVP DTLS=off` produces SDES crypto toward TLS phones | TLS softphone registered via `_sips._tcp`; SDP has `a=crypto` | deploy, call | `kamailio.cfg.j2` | |
| V-T6 | open | DMQ registration replication between edges; Path relay delivers calls | REGISTER via edge-1, call routed via edge-2 | deploy, call | `kamailio.cfg.j2` | |
| V-T7 | open | `PJSIP_HEADER(read,X-PBX-...)` reaches Stasis args; cause 21 ↔ 403, cause 34 ↔ 503 | Device call, blocked call, ARI app stopped | deploy, call | `extensions.conf.j2` | |
| V-T8 | open | Codec matrix: calls between any two single-codec phones have audio | SIPp codec scenarios (`loadtest/sipp`) | deploy, call | CLAUDE.md §1 | |
| V-T9 | open | Metrics endpoints: rtpengine Prometheus, Asterisk `res_prometheus` | `curl` them | deploy | CLAUDE.md §8, §9 | |
| V-T10 | open | Edges behind 1:1 NAT (V-P10): Kamailio needs a public-facing socket that advertises the public IP (UDP 5060 + TLS 5061) separate from the internal socket (Asterisk, peer edge, DMQ: a second port on the same address); rtpengine `external/<private>!<public>` sharing the address with `internal/<private>` | Template change + `kamailio -c`; then on the VMs: a phone registers over UDP and TLS, carrier/phone replies carry the public IP, audio both ways | deploy, call | `kamailio.cfg.j2`, `rtpengine.conf.j2`, `pjsip.conf.j2`, inventory `public_bind_ip` | Templates done 2026-11-11: internal socket `udp:<private>:5070` (`kamailio_internal_port`, listed first = default: DMQ, peer edge), public `udp:<bind>:5060` + `tls:<bind>:5061` with `advertise <public>`, `route[SEND_PUBLIC]` forces the public socket for TO_VENDOR / a phone on this edge / FROM_PEER, dispatcher `socket=` attr, Asterisk trunk contact + vendor outbound_proxy on 5070, Path on 5070. Both layouts pass `kamailio -c` and `configs.test.ts`. **Still to check on the VMs:** `sngrep` shows the public IP in Via/Record-Route toward the carrier and phones and the private IP toward Asterisk; in-dialog BYE/re-INVITE leave from the right socket (double RR); rtpengine accepts internal and external on one address (`journalctl -u rtpengine-daemon`), audio both ways. |

## API and deployment

| ID | Status | Assumption to check | How to check | Needs | Where | Result |
|---|---|---|---|---|---|---|
| V-A1 | open | The `api` Ansible role runs (it was only lint/template checked) | First `site.yml` run on app-1/app-2 | deploy | `roles/api` | |
| V-A2 | open | The course tools can read our OpenAPI document and adapt to it | After deploy: Course Services → API → Request adapter update (10/day) | deploy | `src/openapi` | |
| V-A3 | open | Graders reach the API at the root path (`/openapi.json` at the domain root) vs `/api/...` (web routing, split-contracts O4) | The adapter result (V-A2); spec says `/openapi.json` | deploy | `edge_haproxy`, split-contracts O4 | |
| V-A4 | open | `trusted_tester_cidrs`: the simulators' real source ranges | Kamailio logs / `sngrep` once traffic is on | traffic | `group_vars/all/main.yml` | |

---

Spec gaps found while verifying (not assumptions, missing features) go to their own task, not
here. Found so far: support tickets (spec §3), in progress on its own branch.
