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
| V-D3 | done 2026-11-11 | Our trunk group exists with both edges and `{DID}` as the R-URI user | `GET /voice_in_trunk_groups/:id?include=voice_in_trunks` | now | `group_vars/all/main.yml` | Both trunks present: edge-1 130.245.136.135:5060, edge-2 130.245.136.156:5060, user `{DID}`. |
| V-D4 | open | Whether the clone applies the region / city / type / `number_contains` filters at all (results are re-checked client-side either way) | Search one city; check that every returned offer's group has that city id | now | `numbers/didww.ts` | |
| V-D5 | open | Trunk codec settings: can the carrier leg be pinned to PCMU (A4; saves transcoding on every incoming call)? | `GET /voice_in_trunks/:id`: look for `codec_ids` in the SIP configuration; PATCH if supported | now | CLAUDE.md §3 A4 | |
| V-D6 | open | `POST /orders` with `did_order_items {sku_id, available_did_id}`; statuses Pending/Completed/Canceled; "taken" = 422/404/409 | Buy one local number through the deployed API (`POST /numbers/purchase`) | purchase, deploy | `numbers/didww.ts`, `backend-step8.md` | |
| V-D7 | open | Assigning a DID: `PATCH /dids/:id` with relationship `voice_in_trunk_group` | Same purchase; then `GET /dids/:id?include=voice_in_trunk_group` | purchase, deploy | `numbers/didww.ts` | |
| V-D8 | open | Release (R17): `billing_cycles_count: 0` stops renewal and the number keeps working to period end; spec says "then release it at the provider" (explicit call at period end?) | Release the test number; watch it at the 7-day boundary; check the clone's DID after it | purchase, 7 days | `numbers/didww.ts`, `billing/scheduler.ts`, R17 | |
| V-D9 | open | Request-URI user format on carrier INVITEs: with or without `+` (A3) | First carrier call: `sngrep` on the edge | call, purchase | CLAUDE.md §3 A3, ARI app `didCandidates()` | |
| V-D10 | open | DTMF from the carrier is RFC 4733, not in-band (A4) | IVR digit on a real carrier call; `sngrep` / rtpengine log | call, purchase | CLAUDE.md §3 A4, `cloud-deploy.md` §4 #14 | |
| V-D11 | open | Trunk group failover: with one edge down, carrier calls go to the other trunk (A7) | Stop Kamailio on edge-1, call the DID | call, deploy | CLAUDE.md §3 A7 | |
| V-D12 | open | Codecs the carrier offers (A4) | SDP of the first carrier INVITE | call | CLAUDE.md §3 A4 | |
| V-D13 | open | Real phones to the shared numbers (201) 633-6004/-6005 arrive "addressed to that number". We don't own those numbers, so our DID lookup won't find an account: decide how to route them (test account? reject?) | Call from a registered member phone; look at the R-URI and what the ARI app does | call, deploy | Course Services tab "Real phones", ARI app `inbound.ts` | |

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
| V-P3 | open | Private-only VMs have outbound internet (apt, npm, GitHub, PyPI) | `curl -sI https://deb.debian.org` on a VM without a public IP | deploy | `cloud-deploy.md` §5 step 1 | |
| V-P4 | open | Cloud firewall filters private traffic between VMs (if yes, an inbound rule for `10.0.0.0/16` is required) | From edge-1: `nc -zv <db-1> 5432` after the db deploy, with and without the rule | deploy | `cloud-deploy.md` §5 | |
| V-P5 | open | Can a public IP be detached from one VM and attached to another (a manual floating IP for edge failover)? | Clanode UI on a spare VM | now | CLAUDE.md §2 | |
| V-P6 | open | Several A records or SRV targets can be added for us (edge HA) | Ask the course staff | staff | CLAUDE.md §3 A7 | |
| V-P7 | open | Outbound access for Let's Encrypt (real cert for the group domain) | `certbot` dry run on an edge | deploy | `cloud-deploy.md` §2 | |
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
