# 2026-11-14: silent legs after the first session refresh (Maple Insurance, O'Brien Paving left)

Two more simulated customers left on 2026-11-14 with "experience" dissatisfaction (Maple Insurance
13.7 at 9:45 AM, O'Brien Paving 13.6 at 11:53 AM ET). The course's failures chart counted almost
only **Extension → US** (and a few **Extension → extension**) legs as failed, while our CDRs said
every one of those calls was answered. Cause: **after a mid-call re-INVITE we switched the codec we
sent to the caller's desk phone (to G.723, G.729 or PCMA) while the phone kept sending PCMU**, so the
phone heard nothing. This also explains open findings F5 and F6 of
[2026-11-13-first-customer.md](2026-11-13-first-customer.md).
All times US Eastern unless marked UTC.

## Evidence

**1. Which calls failed.** The course chart (`/api/services/market`, 5-minute buckets, each event
shown in two buckets) matched against our CDR end times and the US vendor's billing log:

| Call (ET) | Ext | Talk | Course | Transcoder toward the phone (Prometheus `rtpengine_transcoders`) |
|---|---|---|---|---|
| Maple 9:43:08 (its last call before leaving) | 104 | 157 s | failed | PCMU → G723, edge-2 14:44–14:46 UTC |
| O'Brien 9:57:05 | 101 | 129 s | failed | PCMU → G723, edge-1 14:58–14:59 UTC |
| O'Brien 11:23:31 | 102 | 75 s | failed | PCMU → G729, edge-2 16:24:30 UTC |
| O'Brien 11:25:33 | 104 | 123 s | failed | PCMU → PCMA, edge-1 16:26:30–16:28 UTC |
| O'Brien 11:31:13 | 101 | 112 s | failed | PCMU → G723, both edges 16:32–16:33 UTC |
| O'Brien 9:14 / 9:59 / 10:19, M&W 13:20 | | 9–42 s | completed | none |

Failed calls were all longer than ~60 s; the ones that passed were short.

**2. rtpengine final packet stats** (log level 6) for the 11:23 call, phone leg: the phone sent
3,723 packets of 172 bytes (PCMU) all call long; we sent it 3,734 packets but only 329,488 bytes.
That is exactly 1,500 PCMU packets (30 s) followed by 2,234 G.729 packets (32 bytes). The vendor leg
was PCMU both ways. So the phone heard 30 s of audio, then nothing.

**3. Re-INVITEs every 30 s.** The packet capture (`/var/tmp/sipcap` on the edges) shows the course's
phones and carrier refresh their sessions with a re-INVITE every 30 s (`Session-Expires: 90`). And
right after every answer, **Asterisk re-INVITEd both legs** (connected-line update). rtpengine
handled Asterisk's PCMU-only re-offer with our `pbx_offer` flags, i.e. offered the phone
`PCMU PCMA G729 G723 opus` in the middle of the call.

**4. Reproduced** from mon-1 with SIPp (scenario: test extension A calls B; A offers
`4 0 8 18` (G.723 first) but sends PCMU, answers Asterisk's re-INVITE, refreshes at 30 s):

| Step | SDP |
|---|---|
| A: INVITE | `4 0 8 18 101` → we answer `0 101` (PCMU) |
| Asterisk re-INVITE → A | rtpengine offers `0 8 18 4 96 97 101`; A answers `4 0 8 18 101` |
| A: refresh re-INVITE | we answer **`4 101` (G.723)**; rtpengine then sent A 1,636 G.723 packets |

A phone offering only PCMU did not trigger it. Adding rtpengine `reuse-codecs` (offers) and
`single-codec` (answers) in Kamailio did **not** help (same G.723 answer), because the phone's own
answer to Asterisk's re-INVITE listed G.723 first, so rtpengine follows the phone's choice.

## Fix

`send_connected_line=no` on every Asterisk endpoint toward the edges
(`telephony/asterisk/pjsip.conf.j2`, `[edge-common]`; assertion in
`services/ari-app/test/configs.test.ts`). Asterisk no longer re-INVITEs after the answer, so nothing
offers the phone a new codec list mid-call; the phone's own refreshes then keep PCMU. The caller ID
in the initial INVITE (`send_pai`, From) is unchanged; only the mid-call display update is gone.

- Same repro after the change: the refresh is answered `0 101` and the phone got 2,472 PCMU packets
  (172 bytes each) for the whole call.
- **Live since 2026-11-14 ~21:40 UTC** on pbx-1 and pbx-2 (`module reload res_pjsip.so`, no calls
  dropped). The synthetic call still passes on both edges.
- Side effect: two fewer SIP transactions and rtpengine re-offers per call (less load on Kamailio,
  rtpengine and Asterisk).

Remaining exposure: Asterisk still re-INVITEs if it becomes the session-timer refresher (it offers
`Session-Expires: 1800`, so the first refresh would come after 15 min). Not seen in the captures
(the far side refreshes itself), but a 15-minute call is the case to test next.

## Ruled out

- **60-minute calls** (Marino & Wagner, 2 calls of exactly 3,600 s): audio flowed both ways for the
  whole hour (~179k packets each way), and the course counted the call as completed. The course's
  parties stayed on the line; not our bug.
- **Dead media path**: every failed call had packets both ways on both legs; only the codec toward
  the phone was wrong.
- **Host firewall dropping SYNs** (`ct state invalid drop`): a counter on db-1 saw 0 invalid packets
  in a minute with 6 SYN retransmits.

## Follow-ups

1. ~~Extend the codec quality test (PR #53, 3-second calls today) with a > 30 s call that refreshes the
   session and offers several codecs, and check the payload type each phone receives, not only the
   packet count. That would have caught this.~~ **Done (2026-11-14, not deployed yet).** Every
   quality-test run now adds one 45 s call (`files/quality/q_refresh_uac.xml.tpl`): the caller
   offers `4 0 8 18 101`, `18 0 8 4 101` or `8 0 18 4 101` (rotating per run) but sends PCMU,
   answers Asterisk's re-INVITEs with that list, and refreshes at 30 s with the same SDP and
   `Session-Expires: 90;refresher=uac`. `files/quality/rtp_check.py` judges the RTP each phone gets
   after the refresh by payload type and size (good = pt 0 in whole 10 ms frames; 36-byte G.723 or
   32-byte G.729 is wrong). Metrics `pbx_quality_refresh_{sip_ok,audio_ok,packets,payload_type,
   packet_bytes,silent_runs}`; alert `QualityRefreshCodecChanged` (critical, 2 runs in a row).
   Checked offline only: SIPp flow against a fake edge that answers the refresh with `4 101`, the
   analyzer on captures with and without the flip, and `promtool test rules`; not yet run against
   the real edges.
2. Test a 16-minute call (Asterisk as session-timer refresher). **In progress (2026-11-14).**
   What the config and pjproject (`sip_timer.c`) say:
   - Asterisk has no `timers*` settings, so the defaults apply: session timers on,
     `timers_sess_expires=1800`, `timers_min_se=90`. As refresher it refreshes at half: ~900 s.
   - It is the refresher when the phone asks for it (`refresher=uas`) and, on legs Asterisk places
     (ringing a desk phone, vendor/external legs), when the far side's 200 OK does not take the
     role. A phone that refreshes itself (the course's callers: `Session-Expires: 90`, every 30 s)
     keeps Asterisk out of it.
   - pjsip refreshes with **UPDATE without SDP** if the far side's `Allow` lists UPDATE (Kamailio
     never involves rtpengine then: harmless), otherwise with a **re-INVITE carrying SDP**, which
     Kamailio's `INDLG_SDP` hands to rtpengine with the from-Asterisk flags: a five-codec re-offer
     toward the phone, the same path as the connected-line re-INVITE above.
   Test: `pbx-long-call-test <A's extension number> [edge]` on mon-1 (manual, ~16.5 min; scenarios
   `files/quality/q_long_ua{c,s}.xml.tpl`, report by `long_call_check.py`). It forces the risky
   case on both legs (no UPDATE in Allow; caller asks `refresher=uas`, callee does no timers),
   answers Asterisk's re-INVITE with `4 0 8 18 101`, sends one re-INVITE of its own 30 s later,
   and prints PASS / FLIP / INCONCLUSIVE with every refresh Asterisk sent. `ALLOW_UPDATE=1` runs
   the UPDATE case.
   **Run 1 (2026-11-15 00:51 UTC, edge-1 → pbx-2): broken by the test setup, no answer yet.**
   Asterisk's 200 OK to the caller said `Session-Expires: 1800;refresher=uas` (Asterisk was the
   refresher, as intended). Audio flowed both ways until 910 s, then stopped on both legs; no
   refresh or BYE ever reached either phone, and the caller's own re-INVITE at 930 s got 408
   (call already gone). Cause: mon-1's host firewall. Kamailio's SIP reaches the test phones from
   the edge's *public* IP, which isn't in `@cluster`, so it only got in on conntrack, and a UDP
   flow's entry expires ~2 min after mon-1's last packet. The test phones' SIP was idle for 15 min
   (RTP kept its own flows alive), so mon-1 dropped Asterisk's refresh at 900 s, and Asterisk hung
   up when the refresh failed. Fix: mon-only rule in `roles/common/templates/nftables.conf.j2`
   accepting UDP from the edges' public IPs to the test-phone ports. Side lesson: a customer phone
   behind NAT that sends no SIP for 15 min would lose Asterisk's refresh the same way (Kamailio
   sends no NAT pings, `natping_interval 0`). The course's callers refresh every 30 s; phones
   that are only rung are the unknown. Check real traffic for legs ending 900-915 s after the
   answer. Still to find out from real traffic: whether the
   course's phones (as callees) and the vendors include UPDATE in `Allow` and take the refresher
   role themselves. Once `pbx-call-audio` (3.) is deployed, a flip on a real customer call longer
   than 15 min would show up there as `format_mismatch` (unless it flips to PCMA).
3. **Our own count of silent legs** (2026-11-14, not deployed yet): `pbx-call-audio` on each edge
   (`infra/ansible/roles/rtpengine/files/pbx-call-audio.py`) turns rtpengine's "Final packet stats"
   into one JSON line per call in `/var/log/pbx/call-audio.jsonl` (Call-ID, peer, codec, packets
   and bytes per packet each way) and a verdict per party-facing leg: `ok`, `no_media`,
   `silent_from_party`, `silent_to_party`, `format_mismatch` (we send the party a different packet
   size than it sends us). Metric `pbx_call_audio_legs_total{verdict,test}`, alert
   `CustomerCallAudioBad`. Backfilled over 2026-11-13 23:00 → 11-14 22:00 UTC: it flags all 21
   bad customer legs we know of (every course-counted failure above, plus Maple's earlier long
   calls and the TLS-phone leg that got no audio before PR #51), none after the fix, and 0 false
   positives among 82 good customer legs. Blind spot: PCMU vs PCMA (same packet size).
   Investigation recipe: `grep -v '"verdict":"ok"' /var/log/pbx/call-audio.jsonl` on both edges for
   the course's failure window.
