# Telephony test suite

Three layers. The first two run anywhere with `npm test`; the third needs VMs.

| Layer | What | Run | Needs |
|---|---|---|---|
| 1. Spec suite | Call flows against a fake Asterisk ([fake-asterisk.ts](../services/ari-app/test/harness/fake-asterisk.ts)) and a **real Postgres engine** (PGlite, in process) with the real migrations, `Repo`, `ConfigCache`, `CdrWriter` and rating code | `npm test` | Node 24 |
| 2. Config checks | Every telephony template rendered by Ansible for a 2-edge/2-pbx inventory, `kamailio -c` on each edge, then content assertions | `npm run test:configs` (Linux/WSL), then `npm test` picks up `telephony/tests/.rendered/` | ansible, Kamailio 6.0 binaries |
| 3. VM scenarios | SIPp against a deployed system: carrier calls per codec, phones placing calls, hold, load | [loadtest/sipp/README.md](../loadtest/sipp/README.md) | a deployed VM, SIPp |

Layer 2 without root: extract Kamailio's .debs (`apt-get download` + `dpkg-deb -x`) and point
`KAMAILIO`, `KAMAILIO_MODULES` and `KAMAILIO_LIBS` at them (see the header of
`telephony/tests/check-configs.sh`).

## Spec coverage (course spec section → tests)

| Spec | Tests |
|---|---|
| §1 PSTN vendors: US vs international incl. non-US +1, digest auth via edge | `spec/outgoing.test.ts` "Route by destination"; `configs.test.ts` vendor endpoints; `shared/test/rules.test.ts` classify |
| §1 Carrier IP | `configs.test.ts` B2 |
| §2 International add-on, recording add-on, price ceilings | `spec/outgoing.test.ts` blocked; `spec/cdr-billing.test.ts` recording; `spec/schema.test.ts` + `rules.test.ts` ceilings |
| §3 Extensions: devices + external numbers at once, first answer wins, forwarding always/busy/no answer, voicemail fallback, dial by number | `spec/extensions.test.ts` |
| §3 Any number of phones; forking with per-branch media; TLS/SRTP-SDES; codec offers per leg | `configs.test.ts` |
| §3 IVR: digits → extension / ring group / menu / voicemail / external; timeout, invalid, repeat | `spec/routing.test.ts` IVR |
| §3 Ring groups all / in order, timeout, no-answer destination | `spec/routing.test.ts` ring groups |
| §3 Business hours in account TZ | `spec/routing.test.ts`; `rules.test.ts` `isOpen` |
| §3 Number routing | `spec/routing.test.ts` number routing |
| §3 Voicemail + `*98` Cisco Unity keys (1/3-1, 1 2 3 ## during, 1 2 3 # after) | `spec/voicemail.test.ts` |
| §3 Caller blocklist | `spec/routing.test.ts` blocklist |
| §3 Hold, blind and attended transfer | `spec/hold-transfer.test.ts` |
| §3 Outgoing number formats, caller ID | `spec/outgoing.test.ts`; `rules.test.ts` |
| §4 Search: indexes, partial number, just-ended calls | `spec/schema.test.ts`; `spec/cdr-billing.test.ts` "within about a second" |
| §5 CDR fields, outcomes, longest prefix, 30/6, included minutes, toll-free, internal free, external legs charged, past due | `spec/cdr-billing.test.ts`; `spec/outgoing.test.ts`; `rules.test.ts` |
| §5 Billing period (signup weekday, account TZ, DST) | `rules.test.ts` |
| §6 WAV 16-bit 8 kHz | `spec/voicemail.test.ts` "records as wav" |
| Bottlenecks B1, B2, B3, B5 | `configs.test.ts`; B6 `spec/cdr-billing.test.ts`, `spec/routing.test.ts` (PDD); B7 `units.test.ts` |

## What the fake Asterisk does NOT prove

It is a model of the ARI behaviour we rely on. The behaviours below are only checked on a VM; the
[VERIFY] list in [spec-transition.md](spec-transition.md) §6 tracks them:
- the real field names of `ChannelTransfer` / `transfer_progress`;
- rtpengine actually transcoding and forking media;
- Kamailio's runtime behaviour (DMQ, Path relay, TLS);
- the vendors' and carrier's real SIP.
