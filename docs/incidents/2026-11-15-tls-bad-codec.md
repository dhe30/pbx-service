# 2026-11-15: "bad_codec at a phone that takes PCMU with SRTP" (Zhang Animal Hospital)

At 12:51:07.598 UTC the course opened a `tls` ticket for Zhang Animal Hospital (mid size):
**"bad_codec at a phone that takes PCMU with SRTP"**. Times below are UTC.

## Which call

The ticket arrived 8 s after an inbound call was answered by Zhang's extension 102 (a TLS phone of the
course simulator, 130.245.136.25). SIP history on edge-1 (`sip-history.py --call-id 3bf2b8eb`), the
ARI app's trace (carrier Call-ID `0742332a…`) and rtpengine on edge-2:

| Time | |
|---|---|
| 12:50:46 | carrier call -> IVR, digit 2 -> extension 102 |
| 12:50:53.932 | INVITE to the phone, RTP/SAVP, PCMU first, two SDES suites |
| 12:50:59.466 | 200 OK: `RTP/SAVP 0 101`, `a=crypto:1 AES_CM_128_HMAC_SHA1_80` |
| 12:50:59.4997 | rtpengine, stream from Asterisk toward the phone: **SSRC changed** (15 ms after the first packet) |
| 12:51:02.47 | first RTP from the phone |
| 12:51:04.468 | **the phone sends BYE** (5 s after answering) |
| 12:51:07.598 | ticket |

Compared with two calls to the same phone that were not flagged (c7799bf0 12:31, 4deaa194 13:21),
the SDP, crypto suite, port learning (the simulator sends RTP from a different port than its SDP
says) and the 3 s before its first packet were all the same. Only this call had:

1. an SSRC switch on the stream toward the phone, with **1 error packet** counted by rtpengine on the
   stream from Asterisk (`in 245 p, 1 e`), and
2. the phone hanging up first (in the others Asterisk sent BYE, cause 16).

The SSRCs show where the switch came from: after it the phone received **5970dda1, the caller's own
SSRC** (the carrier leg's inbound stream on edge-1), and the caller received the phone's.

## Cause: Asterisk's native RTP bridge

Asterisk 22.11 source (pbx-1, `/usr/src/asterisk-22.11.0`):

- Our ARI bridges were `type: mixing`. With two PCMU channels Asterisk upgrades such a bridge to
  `native_rtp`; with `direct_media=no` that is a **local** native bridge, which forwards each
  party's packets to the other as they are. `res_rtp_asterisk.c` `bridge_p2p_rtp_write`: "Set the
  marker bit for the first local bridged packet which has the first bridged peer's SSRC", then
  `bridged->ssrc = ntohl(rtpheader[2])`. The stream toward the phone therefore changes to the far
  party's SSRC, sequence numbers and timestamps when the bridge goes native.
- When a packet goes out before the upgrade (here 1 packet, 15 ms), the phone sees the switch.

How often: the switch leaves exactly that signature (1 error packet on the pbx-side stream) in
the audio records. In `/var/log/pbx/call-audio.jsonl` of both edges on 2026-11-15:

| | no switch | switch |
|---|---|---|
| plain RTP calls | 1,766 | 130 (~7 %) |
| SRTP calls | 55 | 3 |

Of the 3 SRTP ones, ce669814 (12:29) was an Opus phone: rtpengine transcodes it, so the phone gets
rtpengine's own SSRC and never sees the switch; 7719aa69 (09:22) predates our SIP history.
**3bf2b8eb is the only call that day where an SRTP phone received the switch.**

## Reproduction: rtpengine is fine, some receivers are not

`loadtest/diag/srtp-ssrc-replay.py` drives edge-2's rtpengine (26.0.1.28, kernel forwarding) over
its ng port with Kamailio's staff_tls flags: fake Asterisk (RTP/AVP) <-> rtpengine <-> fake phone
(RTP/SAVP, SDES). The fake Asterisk switches SSRC like the native bridge; everything rtpengine sends
the phone is decrypted with the key it offered (the SRTP code passes the RFC 3711 test vectors) and
judged by three receiver models. 250 packets from Asterisk per case:

| Case | RFC 3711 receiver (context per SSRC) | keeps the first SSRC | one replay window for all SSRCs |
|---|---|---|---|
| no switch | 250/250 | 250/250 | 250/250 |
| switch after 1 packet, new seq lower (like 3bf2b8eb) | 251/251 | 1/251 | 1/251 (rest "replay") |
| switch after 1 packet, new seq higher | 251/251 | 1/251 | 251/251 |
| switch after 2 s, new seq lower | 250/250 | 100/250 | 100/250 |

Every case with a switch reproduced the `errors 1` on the stream from Asterisk; the control had 0.
So rtpengine re-encrypts the new SSRC correctly, but a phone whose SRTP receiver keeps one SSRC, or
one replay window across SSRCs (half the time: the new sequence numbers are random), discards all
audio after the switch. That fits a "bad codec" verdict and the phone hanging up 2 s after it
started sending. We cannot see the grader's phone, so this is the most likely cause, not a proof.

## Fix

The ARI app now creates its bridges as `mixing,proxy_media` (`services/ari-app/src/ari/client.ts`).
`res_stasis.c` maps `proxy_media` to `capabilities &= ~AST_BRIDGE_CAPABILITY_NATIVE`, so the bridge
stays `simple_bridge`: Asterisk relays frames and writes them with each channel's own SSRC and
sequence numbers. Cost: Asterisk handles every frame of a 2-party call (no transcoding, PCMU on both
sides) instead of forwarding raw packets; to be measured under traffic (V-T16).

Not covered: a channel still gets a new SSRC when it joins or leaves a non-mixing bridge
(`bridge_channel.c` -> `AST_CONTROL_SRCCHANGE` -> chan_pjsip picks a new SSRC). At the first join no
media has flowed yet; after a transfer the remaining party is moved to another bridge and its
stream does switch. If transfer tickets mention audio on TLS phones, look there next.

## Verify after deploying (V-T16)

- During a call: `asterisk -rx 'bridge show all'` lists technology `simple_bridge`.
- The switch signature disappears: on each edge, today's records with errors on the pbx-side leg
  (was ~7 % of calls):

  ```sh
  python3 -c 'import json,sys
  n=e=0
  for l in open("/var/log/pbx/call-audio.jsonl"):
      j=json.loads(l)
      if j["time"]<sys.argv[1]: continue
      n+=1; e+=any(x.get("in_e",0) and x["side"]=="pbx" for x in j["legs"])
  print(n,"calls",e,"with an SSRC switch from Asterisk")' 2026-11-15T15:00
  ```
- pbx CPU under traffic (`top`, node_exporter) compared with the day before.
