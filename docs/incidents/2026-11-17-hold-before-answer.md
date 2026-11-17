# 2026-11-17: caller holds before the extension answers -> the extension hears nothing

Hussain Notary (tenant `95ce6c83…`) opened two tickets at 08:10:41 and 08:10:46 UTC:
**"no_audio at a phone that takes PCMU"** and **"routing: extension 103 heard nothing"**. Both are
the same call. The same bug caused the 02:53 silent leg in
[2026-11-17-orphan-transaction.md](2026-11-17-orphan-transaction.md). Times are UTC.

## The call (carrier Call-ID `2c5f2850…`, ARI `fcfaaa44`, pbx-3)

| Time | |
|---|---|
| 08:10:20.6 | carrier INVITE to 15127231672, the IVR answers |
| 08:10:23.8 | digit 9: invalid option, menu again |
| 08:10:28.1 | digit 3: ring extension 103 (UDP phone, PCMU) |
| **08:10:28.678** | **carrier re-INVITE `a=sendonly`** (the caller holds); Asterisk answers `recvonly` |
| 08:10:30.919 | 103 answers (200 OK correctly rewritten by rtpengine on media-2); the app bridges |
| 08:10:30.9-36.4 | 103's phone sends 275 packets, **Asterisk sends it 0** |
| 08:10:36.4 | 103 hangs up; tickets at 08:10:41 / 08:10:46 |

rtpengine (media-2): the caller sent 393 packets (7.9 s, i.e. until the hold) in a 15.7 s call;
across 1,423 carrier legs the caller normally sends audio for 90-100 % of the call. The ARI trace
has no `hold:` step.

## Why

`Conversation.run()` subscribes to `ChannelHold` / `ChannelUnhold` only when it bridges the two
parties. A hold earlier in the call (in the IVR, while an extension or a blind-transfer target
rings) was never seen, so no music on hold started when the extension answered. A held caller sends
no audio, and with `proxy_media` Asterisk only forwards what the other side sends: silence.

02:53 (`c11282fb…`, ARI `0839f58e`): 102 blind-transferred the caller to 153; the caller held at
02:52:49.36 while 153 rang; 153 answered at 02:52:50.33 into silence and hung up 5 s later.

## Fix (services/ari-app)

- `src/hold-state.ts`: `HoldState` tracks every channel's hold state from the node's
  `ChannelHold` / `ChannelUnhold` / `ChannelDestroyed` events (fed by `PbxApp.onEvent`, `ctx.holds`).
- `Conversation.run()` checks it right after bridging: a party already on hold gets music on hold
  to the other party at once. Events after the subscription still arrive and `setHold()` ignores
  repeats.
- Spec tests (`test/spec/hold-transfer.test.ts`): hold while the extension rings via the IVR, hold
  and resume before the answer (no MOH), hold while a blind-transfer target rings.

Deploy: call-app code -> pbx rollout (`--limit pbx`), which drains each node before restarting it.
