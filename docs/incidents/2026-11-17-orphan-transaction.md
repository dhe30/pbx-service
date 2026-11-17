# 2026-11-17: silent calls from released INVITE transactions; "no available proxies" bursts

Our `CustomerCallAudioBad` alert (`silent_to_party`) fired for three customer legs on 2026-11-17
(01:43, 02:53, 07:06 UTC, media nodes). Two of them have one cause in Kamailio 6.0.8; the third is
different (below). Times are UTC.

## The 07:06 call (Call-ID `3787583d…`, ARI `678dd3cb`)

Carrier -> extension 102 (UDP phone of the course simulator), ringing 7.3 s, answered, the caller
hung up 5 s later. rtpengine on media-2: the carrier sent 249 packets, we sent it 0; Asterisk sent
rtpengine nothing for the carrier leg.

The ring leg toward the phone (`fa8d4df0…`, `sip-history.py --call-id fa8d4df0` on edge-1):

| Time | |
|---|---|
| 07:06:13.873 | INVITE from pbx-2 reaches edge-1, worker 790 runs DEV_BRANCH -> `rtpengine_offer` (media-1) |
| 07:06:13.973 | Asterisk resends the INVITE (`timer_t1=100`); worker 791: **WARNING `t_unref(): dropping orphaned transaction without branches T=… kr=8`** |
| 07:06:13.975 | media-1 receives the offer (first attempt got no reply within 100 ms), replies in 1.3 ms |
| 07:06:13.979 | INVITE sent to the phone (SDP rewritten: media-1, 0 8 18 4 96 97 101) |
| 07:06:13.982 | 180 Ringing: DEV_REPLY runs (logged) |
| 07:06:21.188 | **200 OK `130.245.136.125:33870 RTP/AVP 18` relayed to Asterisk unchanged**: no DEV_REPLY log, no `answer` on any rtpengine |

Asterisk (ulaw only) got the phone's own G.729 SDP with its public address, so no audio flowed
either way. media-1's later `delete` reported the phone's tag unknown.

## Why

`request_route` handled retransmissions with the stock pattern:

```
if (t_precheck_trans()) { t_check_trans(); exit; }
```

`t_precheck_trans()` is true while another worker is still running the same request through the
script. `t_check_trans()` then found that worker's transaction, which had **no branch yet** (still
waiting on rtpengine). Kamailio 6.0 added an orphan check to `t_unref()` (commit b5df10e): a
transaction with no branches and no reply is released at the end of the message, and in 6.0.8 the
check does not skip retransmissions (`kr=8` = `REQ_EXIST`). Upstream fixed this in **5479f28**
("tm: avoid releasing transactions on retransmission", 6.0 branch, 2026-11-12); apt only has
6.0.8+bpo13.

The released transaction lingers for the wait timer (~5 s): the 180 still matched, a 200 OK after
7 s did not and was forwarded statelessly. So a call goes silent when (1) an rtpengine command for
a ring branch takes > 100 ms, (2) the sender resends in that window (Asterisk T1 and our own
`t_set_retr(100, …)` toward the peer edge are both 100 ms) and (3) the phone answers after ~5 s.
edge-1 logged 18 such INVITE releases from 2026-11-16 12:00 to 2026-11-17 07:00. The 01:42:48 one is
the 01:43 silent call (`08c43fe4…`).

## rtpengine control stalls and "no available proxies"

The > 100 ms replies come from the media nodes: rtpengine's control thread stalls, then handles the
original command and every resend in the same microsecond ("Detected command … as a duplicate",
235 on media-1 and ~300 on media-2 by 07:00). At 03:06:52 media-1 stalled ~0.8 s: Kamailio's
7 x 100 ms ran out, it marked media-1 dead for `rtpengine_disable_tout` (20 s), and calls hashed to it
failed with `no available proxies` (11 + 38 errors at 03:06-03:07, the course's 03:08-03:10 failure
spike on internal / phone_in / US calls). Same bursts on 2026-11-16: 14:23, 17:38, 19:56, 21:59, 23:20.
The stall's cause is not known yet (both media nodes' journals sit at the 1 GB limit while rtpengine
logs every call at log-level 6; not proven).

## Changes (telephony/kamailio/kamailio.cfg.j2)

1. A retransmission seen while another worker handles the request is dropped without
   `t_check_trans()`. The sender resends again (Asterisk after 200 ms) and by then the transaction
   has its branches; the `t_check_trans()` after the precheck absorbs it.
2. `rtpengine_retr` 7 -> 20 (still 100 ms per attempt): a ~0.8 s stall no longer disables a healthy
   node. A dead node now holds the first message per worker 2 s before it is disabled.

Tests: `services/ari-app/test/configs.test.ts`.

## Not this cause: 02:53 (`be30c092…`, ARI `0839f58e`)

Carrier -> ext 102 answered, blind transfer to ext 153 at 15 s, 153 rang 12.4 s and answered, then
hung up after 5 s: we sent 153 nothing. The phone leg's answer was rewritten normally. The carrier
leg shows the caller sent only 870 packets (17 s) in a 32 s call: its audio stopped before 153
answered, so there was nothing to forward. Probably the course's caller going quiet during a long
transfer ring; not confirmed.

## Checks after deploying

- `journalctl -u kamailio | grep "orphaned transaction" | grep " INVITE "` on both edges: none.
- `grep -c "no available proxies"` stays at 0 during media-node stalls (`as a duplicate` still counted).
- `call-audio.jsonl` on the media nodes: no `silent_to_party` with an unrewritten 200 OK.
