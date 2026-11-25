# 2026-11-25: the audio monitor judged 0.1 % of calls (private-network phones taken for Asterisk)

Found while triaging the 17:27-19:40 UTC ticket wave (20 open tickets, alert `NewSupportTicket`).
Fix: branch `fix/call-audio-pbx-peers`. Times are UTC.

## Summary

`pbx-call-audio` (media nodes) gives every customer leg an audio verdict (ok / silent / format
mismatch). It decided which leg is Asterisk's by "the peer is a private address". Since 2026-11-23
the course's phones also reach us over the private network (10.0.0.0/16, CLAUDE.md §7), so their
legs were taken for Asterisk's and never judged. On media-1, **19,974 of the last 20,000 records
were `no_party_leg`**: our silent-leg monitoring was effectively off, and none of the day's
`no_audio` tickets left a trace in it.

What was blind because of it:
- alert `CustomerCallAudioBad` (could not fire for private-network phones);
- `loadtest/diag/silent-legs.py` ("SILENT RING LEGS: 0" meant nothing);
- the `aud:*` columns of `loadtest/diag/load-shape.py` (~0 for hours).

## How it was found

1. `silent-legs.py 19:15-19:45` found 1 audio record in 30 min on media-1..3; load-shape's `aud:*`
   columns were ~0 from 16:50 to 19:50 at 450-580 calls/min.
2. `pbx-call-audio` was running and writing (60 MB file, current). The newest record:

   ```
   verdict "no_party_leg"
     leg 1: peer 10.0.1.214  side "pbx"  PCMU   <- pbx-1
     leg 2: peer 10.0.2.248  side "pbx"  G723   <- none of our VMs; Asterisk never sends G.723
   ```
3. Verdicts of the last 20,000 records on media-1: `no_party_leg` 19,974, `ok` 26.
4. `pbx-call-audio.py`: `side = 'pbx' if is_private(peer_ip) else 'party'`.

## Proof that the new rule is right

Read-only re-judge of media-1's last 20,000 records (installed `judge()`, unchanged), with
Asterisk = the seven pbx nodes' private IPs:

| Peer | Legs by codec |
|---|---|
| pbx node | PCMU 17,308, unknown 2,498, nothing else |
| private, not ours (31 addresses) | PCMU 8,603, Opus 2,340, G.729 2,192, PCMA 2,117, G.723 2,091, unknown 111 |
| public | 1 |

- Asterisk only ever sends PCMU (CLAUDE.md §4.3 #3), and every pbx-node leg is PCMU or unknown.
- The other private peers use all five codecs, so they are phones.
- Only 111 calls had no pbx leg, matching the 111 unknown-codec phone legs / 108 `no_media`
  (calls that ended before any audio).
- Practically all phone media now arrives over the private network (1 public leg in 20,000).

Verdicts under the new rule: ok 17,310, no_media 108, **silent_to_party 35, silent_from_party 2
(~0.2 % silent)**, the same order as the `no_audio` tickets.

## Change

- `roles/rtpengine/files/pbx-call-audio.py`: `--pbx-peer IP` (repeatable). With it, exactly those
  peers are Asterisk's side; every other peer is a party and is judged. Without it, the old rule
  (manual `--stdin` runs).
- `roles/rtpengine/defaults/main.yml`: `call_audio_pbx_peers` = the `[pbx]` group's `private_ip`s,
  rendered into the unit's `ExecStart`.
- The call-audio tasks moved to `roles/rtpengine/tasks/call-audio.yml` (included by `main.yml`).
- `infra/ansible/call-audio.yml`: deploys only those tasks and restarts only `pbx-call-audio`.
  rtpengine is never restarted: no call is affected. (A full rtpengine role run could restart
  rtpengine, and its 20000-60000 port move is still deferred.)
- README §2.4 "Adding a pbx node": also run `call-audio.yml`, else the new node's legs are judged
  as customer legs.
- Tests (`services/ari-app/test/call-audio.test.ts`): the media-1 record shape is `no_party_leg`
  without `--pbx-peer`, `ok` with it, and `silent_to_party` when we send the phone nothing; the
  existing fixture gives identical results with and without the flag.

## Before deploying: alert threshold

`CustomerCallAudioBad` fires on > 0 bad customer legs per 15 min. At ~0.2 % silent that is about
one per 15 min per media node, so it would fire almost constantly. Make it a share first
(monitoring track), e.g.:

```
sum by (instance) (increase(pbx_call_audio_legs_total{test="false",verdict=~"format_mismatch|silent_from_party|silent_to_party"}[15m]))
  / sum by (instance) (increase(pbx_call_audio_legs_total{test="false"}[15m])) > 0.01
```

Deploy: `ansible-playbook call-audio.yml --ask-vault-pass --check --diff`, then without `--check`.
Verify on a media node: `tail -n 2000 /var/log/pbx/call-audio.jsonl | jq -r .verdict | sort | uniq -c`
should show mostly `ok`, not `no_party_leg`.

## Other findings from the same triage

- **No capacity problem.** `failed%` stayed at 0-0.5 % (16:50-19:50, 450-580 calls/min), except
  18:05 (Patroni shutdown, [2026-11-25-db-commit-stalls.md](2026-11-25-db-commit-stalls.md)) and
  19:25. No 503 failovers or "no pbx node" on edge-1 19:15-19:30.
- **`core show settings` "Maximum calls: 640 (Current N)" counts channels, not calls.** The
  limit applies to calls: pbx-1 showed `Current 1002` above its 640 cap and still took calls;
  `core show channels count` gave 340 calls, equal to `pbx_active_calls`. Compare the cap with
  the calls figure.
- **19:20 burst (4 tickets in 3 s, pbx-7 at ~590 calls):** not a crash (`NRestarts=0`, no core in
  `/var/crash`). pbx-7's root disk froze 19:16-19:20; greeting lookups waited behind CDR fsyncs
  and callers heard silence. Fixed in #150 (`ari-app: a stalled disk no longer blocks IVR/voicemail
  greetings or call end`), live after the next ARI app rollout.
- **18:19-18:34 `no_audio` tickets:** match the edge restarts of the media-6/7 rollout (18:26:52,
  18:31:16; commit 122217f). One-off.
- **New pbx/media nodes are not in a laptop's `known_hosts`:** `silent-legs.py` printed "Host key
  verification failed" for media-4..7 and pbx-6/7. Connect to each once before using the tool.

## Still open

- 19:37 Oakwood "extension 103 heard someone else" (misrouted audio): not traced yet.
- "extension 102 did not get the call" (17:33, 17:53, 19:40), forward/simultaneous ring to an
  external number "never rang" (17:27, 19:26), 18:07 Zhang forward always: not traced yet.
- Once the fix is live, classify each silent leg with `silent-legs.py` (late answer vs ours).
