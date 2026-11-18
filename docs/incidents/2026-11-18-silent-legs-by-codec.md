# 2026-11-18: why transcoded legs were silent more often at the 11-17 peak

**Question.** At the 2026-11-17 morning peak (13:00-17:00 UTC) our audio records
(`/var/log/pbx/call-audio.jsonl`, pbx-call-audio) flagged up to 8 % of customer legs as silent, and
legs to phones on a transcoded codec more often than PCMU ones (G.729 6.6 %, Opus 5.9 %, PCMA 4.7 %,
G.723 4.6 % against PCMU 3.2 %). Our codec quality probes failed at the same time. Is that the
media nodes (rtpengine transcodes in userspace; media-1/2 ran at ~72 % CPU on 2 vCPU), or which
course phone hosts use which codecs?

**Answer.** Neither, mostly. Most silent ring legs were **phones answering after we had given up on
them**, and the phones that transcode answered later. rtpengine relayed everything it got.
Times are UTC.

## 1. rtpengine didn't drop the audio

Every silent party leg has two sides in its record: the party and Asterisk. At the peak, on both
media nodes (14:00-17:00), all `silent_to_party` legs but one had **Asterisk sending rtpengine 0
packets** while rtpengine forwarded the party's audio to Asterisk. A transcoding failure would look
the other way round (Asterisk sends, the party gets nothing): 1 leg in ~20,000. Off-peak, no codec
had a single silent leg (~4,000 legs).

## 2. Not only "which hosts": within one host transcoded legs were worse

| Host (peak, media-1) | PCMU silent | transcoded silent |
|---|---|---|
| 130.245.136.68 | 1.3 % | 5.1 % |
| 130.245.136.111 | 1.5 % | 5.5 % |
| 130.245.136.163 / .25 / .56 / .183 | 3.0-4.0 % | 2.5-4.2 % (about the same) |

## 3. The media nodes' CPU doesn't track it

media-1 CPU was highest 13:00-15:00 (~72 %) and ~53 % from 15:30; the silent rate rose through the
whole morning (13: 1.4 %, 14: 3.0 %, 15: 5.9 %, 16: 7.9 %). It follows the course's phones getting
slower (REGISTER resends, slow 100 Trying; PRs #101-#104), not our load.

## 4. Joining each silent leg to its caller (14:40-14:50, edge-1)

Ring legs (INVITE from a pbx node) from the edge's SIP history, matched by (rung SIP user, answer
time) to the call app's `ring: answered` / `ring: leg ended` lines (which carry the caller's
Call-ID), then both legs' audio records (`loadtest/diag/silent-legs.py`, below):

| Silent ring legs | 41 |
|---|---|
| **late answer, never bridged**: the phone sent no reply within 5 s, Kamailio answered Asterisk 408 (cause 18), the app moved on; the phone's 200 OK came later and reached a call that was gone | **22** |
| not joined (no ring line for the leg, e.g. vendor legs) | 11 |
| app saw no answer for another reason (e.g. a ring-group race: the slow phone answered after another member had won) | 4 |
| caller sent (almost) nothing | 3 |
| bridged, caller sent audio, Asterisk sent nothing | 1 (a ring-group member that answered 8.7 s in, after the winner at 5.3 s) |

By the leg's codec: PCMU 12 of 460 (2.6 %), transcoded 29 of 330 (8.8 %). The phones that transcode
were slower to answer: 45.6 % took 5 s or more (p90 8.7 s), against 38 % of PCMU phones (p90 7.8 s),
so they hit the 5 s limit more often. That is the course's side; our 5 s limit turned it into
silent calls. PR #104 gives phones 15 s.

## 5. The quality probes

Our probe calls (mon-1, every codec, both directions) failed at the peak on every codec, PCMU too:
26 of 117 runs SIP failures, 18 with silent stretches, 36 with fewer than 60 packets (off-peak: 5,
0, 5 of 400). By codec: PCMU 25 %, G.729 25 %, Opus 23 %, PCMA 33 %, G.723 48 %. G.723 sends 30 ms
frames, so even off-peak it gets ~90 packets a run, closer to the 60-packet line. The probes reach
the edges through the public NAT path, where the synthetic call showed loss at the same time: they
measured that, not transcoding.

## Changes (feature/silent-leg-diagnostics)

The join above took most of a day by hand. For the next peak:

- **Ring legs are tagged.** The call app adds `X-PBX-Leg: <ARI channel id>` to every leg it
  originates (`ring.ts`); Kamailio logs `legs: <channel id> is [ci=<Call-ID>] to <user>` and strips
  the header (`route[LEG_TAG]`, on `TO_DEVICES` and `TO_VENDOR`). `ring: answered` and
  `ring: leg ended` carry the channel id (`leg`), `ring: leg ended` also how long it rang (`ms`),
  and a new `ring: others stopped` lists the legs the app stopped (a race lost, or the ring
  timeout) and the winner. A leg's audio record now joins to its caller exactly.
  Asterisk 22.11 source: ARI originate applies variables with `ast_set_variables()`, which ignores
  each result, so a failing `PJSIP_HEADER(add)` could only log an error, never fail the call.
- **`loadtest/diag/silent-legs.py <since> <until>`** (UTC, from WSL, at most 30 min) collects the
  audio records, ring lines and edge tags and classifies every silent leg: stopped by the app /
  late answer / caller sent nothing / rtpengine dropped it / **ours: bridged, caller ok, Asterisk
  sent nothing** (the one to look at). Without tags (older windows) it falls back to the SIP-history
  match above (at most 15 min).
- **Silence by codec, live.** pbx-call-audio also exports
  `pbx_call_audio_party_legs_total{verdict, codec, srtp}` (customer legs; fixed labels). Grafana:
  `sum by (codec) (increase(pbx_call_audio_party_legs_total{verdict=~"silent.*"}[10m])) /
  sum by (codec) (increase(pbx_call_audio_party_legs_total[10m]))`.

## At the next peak

1. `python3 loadtest/diag/silent-legs.py <10 min of the peak>`: with #104 deployed, "late answer"
   should be small; anything under "ours" or "rtpengine dropped it" is a lead.
2. The codec ratio above per media node, against that node's CPU.
3. `journalctl -u kamailio | grep -c "late 2xx"` on both edges (PR #104).
