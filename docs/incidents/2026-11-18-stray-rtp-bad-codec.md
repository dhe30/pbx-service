# 2026-11-18: Hussain Notary tickets (bad_codec on G.729, attended transfer)

Two open grader tickets for Hussain Notary (tenant 95ce6c83, pbx-3). Times are UTC.

| Ticket | Grader text | Our finding |
|---|---|---|
| dc9480d4 `codecs` (19:07:31) | "bad_codec on a us call in G729" | a stray RTP stream from another host relayed untranscoded to a G.729-only phone: **fixed** (§1) |
| 5a0c85d0 `transfer_attended`, 1st failure (17:26) | "extension 183 heard nothing after the transfer" | transfer completed and media flowed both ways; cause not found (§2) |
| 5a0c85d0, 2nd failure (19:00:11) | "extension 124 never rang after the transfer (REFER not sent)" | no consult call to 124 and no REFER ever reached us: question for course staff (§3) |

## 1. bad_codec: a stray stream on the Asterisk-facing port

Ext 161 (a G.729-only phone) called +16315550168 via the US vendor at 19:07:19. Media-3 handled
both legs. The caller hung up after 5 s.

media-3's audio record for the phone leg (`/var/log/pbx/call-audio.jsonl`) shows the only
`format_mismatch` of the day. There were about 1,500 G.729 phone legs on the three media nodes, and
no other mismatch for any codec.

| Direction | Packets | Bytes/packet |
|---|---|---|
| phone -> us (G.729) | 251 | 32 (correct: 20 B G.729 + 12 B RTP header) |
| Asterisk side -> us | 2057, **1808 counted as errors** | 172 |
| us -> phone | 2057 | **155** (PCMU/PCMA-sized: not G.729) |

rtpengine's log on media-3, port 36752 (the Asterisk-facing side of this call):

```
19:07:19 RTP packet with unknown payload type 8 received from 130.245.136.111:16335
19:07:19 Confirmed peer address as 10.0.1.0:13674           (pbx-3, correct)
19:07:34 RTP packet with unknown payload type 8 received from 130.245.136.111:16335
19:07:49 RTP packet with unknown payload type 8 received from 130.245.136.111:16335
```

130.245.136.111 is none of our nodes. It most likely held this port for an earlier call and kept
sending after it ended. rtpengine learned the right peer (pbx-3), but without `strict-source` it
still relays packets from any other source. Payload type 8 is not in this stream's codec list, so
it was not transcoded either: the G.729 phone got raw PCMA. The Asterisk-facing ports are reachable
from the internet because the media nodes bind one local address for both interfaces (1:1 NAT), so
the cloud firewall can't tell them apart. .111 hit our ports 4 times today; this is the only call it
broke.

**Fix:** `strict-source` in every rtpengine offer/answer (`BASE` in
`telephony/kamailio/kamailio.cfg.j2`; test in `services/ari-app/test/configs.test.ts`). After
endpoint learning, packets from any other address are dropped. A legitimate new address arrives with
a re-INVITE and is learned again. To check after deploy: **V-T21**. The risk to watch is a NATed
phone whose source port changes mid-call without a re-INVITE, which would now go silent.

Deploy: the **edge** group (Kamailio renders the flags; rtpengine on the media nodes is unchanged):
`ansible-playbook site.yml --ask-vault-pass --limit edge`.

## 2. "183 heard nothing after the transfer" (17:23)

The attended transfer itself worked:

```
17:23:31.9  carrier caller <-> ext 102 (Opus phone): 102 holds -> ARI app: MOH to the caller
17:23:31.9  102 calls 183 (consult); 183 (PCMU phone) answers 17:23:40
17:23:43.97 102 sends REFER (Replaces = consult call) -> pbx-3 202 Accepted
17:23:43.98 ARI app "attended transfer": 183 joins the caller's bridge, MOH stopped, 102 hung up
```

media-2 relayed about 48k packets each way on the caller's leg (980f02d8) and on 183's leg
(dd203f03), so audio flowed for the next 16 minutes. The one change at transfer time is an SSRC
switch on the stream toward 183 (Asterisk sends `AST_CONTROL_SRCCHANGE` when a channel moves bridge;
rtpengine logged "SSRC changed" and 1 error packet). 183 is a plain RTP/AVP UDP phone. The
2026-11-15 analysis (docs/incidents/2026-11-15-tls-bad-codec.md) found the simulator's plain-RTP
phones cope with SSRC switches; only SRTP phones had trouble. So this is not strong evidence, and
nothing was changed. Packet counts can't show content: if this recurs, capture the target's leg
(`loadtest/diag/rtp-audio.py`) during a transfer.

## 3. "124 never rang after the transfer (REFER not sent)" (19:00:11): not seen by us

- From 18:58 to 19:01, neither edge received or sent any request for `sip:124@` (SIP history,
  all transports including TLS and WS).
- No REFER from any Hussain phone in 18:50-19:01. The REFERs in that window were other tenants'
  transfers, all accepted.
- Since 12:00 the ARI app shows no call to ext 124 at all (only calls 124 made).
- 124 was registered (UDP, on edge-2, User-Agent cse356-market).

So the transferring phone never placed the consult call (or placed it somewhere other than us), and
never sent a REFER. Nothing on our side failed. Question for course staff:

> Hussain Notary (group 4), ticket `transfer_attended`, failure at 2026-11-18 19:00:11 UTC:
> "extension 124 never rang after the transfer (REFER not sent)". Our edges received no INVITE for
> extension 124 and no REFER from any of this customer's phones between 18:58 and 19:01. Extension
> 124 was registered the whole time. What was the expected flow for this attended transfer: should
> the transferring phone have placed the consult call to 124 itself (an INVITE to us), or did the
> test expect our system to call 124? And who was supposed to send the REFER: the simulated phone,
> or us? If the phone's consult INVITE failed before reaching us, can you share what it sent and
> where?
