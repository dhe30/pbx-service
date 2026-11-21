# 2026-11-20: support-ticket sweep (softphone login, 500 failover, keep-alive, and the rest)

Seventeen tickets were opened on 11-19/11-20 and closed after two quiet hours. Each one was traced through
the grader's market API, our `support_tickets` table, ARI app and Asterisk logs, Kamailio's SIP
history (`sip-history.py`), the media nodes' `call-audio.jsonl`, HAProxy logs and Prometheus
`ALERTS`. Times are UTC. Leaderboard at the time: 99.82 % over 24 h (39 failed), 2nd of 5.

| Ticket(s) | Cause | Ours? | Section |
|---|---|---|---|
| softphone "log in: locator.fill: Timeout 30000ms" (11-19 23:50, 09:20, 20:50, 21:00) | `/` had no login form | yes, fixed | §1 |
| voicemail "call failed_503" 19:49 + internal/US burst 19:50 | vendor DNS outage amplified by 500 failover | partly, fixed | §2 |
| call_records "fetch failed (UND_ERR_SOCKET)" 18:15 | HAProxy closed an idle keep-alive socket at 60 s | yes, fixed | §3 |
| forward_no_answer "+16315550233 never rang" 15:27 | our own-number forward guard | yes, open (decision) | §4 |
| voicemail_web "no message" (11-19 22:34, 13:03, 20:46) | grader's own *98 test deleted the message first | no | §5 |
| transfer_attended Garcia 19:40 | the caller held itself through the transfer | no | §6 |
| transfer_attended 16:43, 19:41, 21:34; transfer_blind 22:00 | unknown; all involve a G.723 phone | open | §6 |
| ivr 15:57, ring_group_sequential 17:28 "ext 102 heard nothing" | unknown; both 102s are Opus phones | open | §6 |

## 1. Softphone: the browser never reached a login form

HAProxy log, every course browser flow (130.245.136.233) since at least 11-19:

```
20:49:37.006 GET /                    200   (web)
20:49:37.025 GET /assets/index-*.js   200
20:49:37.247 GET /api/me              401
20:49:37.272 POST /api/auth/refresh   401
(nothing more from this client)
```

No browser sent `POST /api/auth/login` at all in the retained logs. The flow opens the site root and
looks for `data-testid="login-email"` right away. Our `/` was a landing page with links to
`/login`, so `locator.fill` waited 30 s and failed. The course spec names the testids, not a URL.
Not every failed flow became a ticket.

**Fix:** `/` renders the login page (`services/web/src/App.tsx`). `GuestRoute` still redirects a
logged-in user to the dashboard. The landing page is deleted (the login page links to sign-up).
Checked in the dev preview: `/` shows `login-email`, `login-password`, `login-submit`. Verify live: V-A7.

## 2. 19:49: one DNS minute became a pbx outage on edge-2

The platform resolver (10.0.0.2) failed to resolve `us-vendor.cse356.compas.cs.stonybrook.edu` for
about a minute (15 `could not resolve hostname` per edge, 19:49 only; group "bat" spiked at the same
time, so that part is shared). Vendor legs failed with cause 127, the ARI app hung the phone's call
up with `reason=failure`, and Asterisk answered **500**.

`failure_route[PBX_FAILOVER]` treated 500 like 503: `ds_mark_dst("ip")` and try the next node. Each
such call therefore marked pbx-2, pbx-1 and pbx-3 inactive in turn, until OPTIONS probing
re-activated them:

```
19:49:06.912 / .978 / 19:49:07.026   pbx ... failed (500), trying next   (x3)
19:49:09.688 .. 13.708               no pbx node available   (*98, extensions, DIDs, synthetic 902)
... 5 such cycles until 19:50:04
```

Hussain's *98 test got 503 ("call failed_503"), and so did the internal and inbound calls in the
grader's 19:50 bucket. The only alert that fired was `VendorCallsRejected` (19:50-19:54).

**Fix:** only 503 (ARI app down / Asterisk at maxcalls) and timeouts mark a node and fail over.
A 500 is one call failing and goes back to the caller (`telephony/kamailio/kamailio.cfg.j2`,
spec in `services/ari-app/test/configs.test.ts`). Verify live: V-T22.

Not changed: `inbound.ts` still hangs up carrier calls that fail before answer with
`congestion` (503) to get a retry on another node. That also marks the node. Revisit if it shows
up the same way.

## 3. UND_ERR_SOCKET: keep-alive closed at the moment of reuse

The grader's API client reused sockets after about 60 s idle. HAProxy had only `timeout client 60s`,
which also limits idle keep-alive time:

```
18:14:23.835 130.245.136.222:24111  POST /auth/refresh 200      (last use of this socket)
18:15:23.869 130.245.136.222:31653  GET /calls ... 401          (other socket, idle 59.9 s: made it)
18:15:23.8x  refresh on :24111 -> socket closed by HAProxy at 60.0 s -> fetch failed
```

**Fix:** `timeout http-keep-alive 120s`, and every response carries `Keep-Alive: timeout=55`,
which undici (Node fetch) and browsers follow. The client retires the socket at about 54 s, long
before HAProxy closes it. The frontend is HTTP/1.1-only, so the header is legal. Verify: V-A8.

## 4. Forward no answer to the caller's own number (decision needed)

Village Martial Arts 15:24: caller +16315550233 -> IVR -> extension, no answer, forward-no-answer
target is +16315550233 as well. `router.ts` (`forwardUnlessCaller`, commit 31ef7cb) skips a forward to
the caller's own number and goes to voicemail. The grader expected the number to ring. The guard
exists because of an 11-15 Zhang ticket (forward always to the caller's number: "extension 111
never rang"). The two tickets pull in opposite directions. Skipped forwards since 11-17: 15 always,
15 no_answer.

## 5. Missing voicemails: the grader deleted them itself

All three cases are the same pattern (Garcia Plumbing):

| Message recorded | Uploaded | *98 on the same extension: play, key 3 (delete) | Web check |
|---|---|---|---|
| 13:03:41 ext 104 | 13:04:31.6 | 13:05:07 | ticket 13:05:38 |
| 20:46:43 ext 105 | 20:47:33.8 | 20:48:28.8 | `GET /voicemails?mailboxId=` 20:48:39.1 |
| 11-19 22:34:04 ext 195 | 22:34:54 | 22:35:41 | ticket 22:36:06 |

In each case the *98 session found exactly one new message and deleted it. Nothing to fix.

## 6. Silent transfers and "heard nothing"

- **Garcia 19:40 (attended):** ext 157 (the caller) sent its own hold re-INVITE at 19:40:20.5,
  1.6 s before the transfer, and resumed only at 19:40:34.5, so 197 got nothing from it. That's
  the grader.
- **16:43 (Hussain, 102->210), 19:41 (Hussain, 252->105), 21:34 (Oakwood, 102->135) attended,
  22:00 (Hussain, 243->128) blind:** rtpengine's records show continuous packets both ways
  for the whole call. The SIP of the 19:41 case is clean (hold, REFER 202, NOTIFY, BYE; 30 s refreshes).
  The 16:43, 19:41 and 21:34 cases follow the same Asterisk sequence: the target joins, the bridge
  goes simple -> softmix (3 parties) -> the transferer leaves.
  The common factor: a **G.723 phone** is in every case, as target (210, 135) or caller (158, 118).
  By chance alone that's about 2 %. 344 attended and 335 blind transfers ran today.
- **"ext 102 heard nothing" (IVR 15:57 Hussain, sequential ring group 17:28 Oakwood):** both 102s
  are Opus phones. We sent them 89-99 bytes/packet (speech-sized; silence is far smaller).

Packet counts can't show what the packets carried. No RTP capture was running. Next time: a
bounded full-payload capture on the media nodes, then `loadtest/diag/rtp-audio.py --corr` on the
caller's stream into Asterisk vs Asterisk's stream to the target (plan in
[2026-11-17-hold-before-answer.md](2026-11-17-hold-before-answer.md)).

## 7. Smaller things seen

- Missing prompts: `vm-nomore` (734 failed playbacks today) and `option-is-invalid` (300) aren't
  installed on the pbx nodes; callers hear silence there.
- 390 voicemail playbacks from `/var/lib/asterisk/sounds/cache/` failed right after the message was
  recorded (16:43:37 for a file written at 16:43). Looks like a cache-write race.
- Asterisk's `messages.log` on the pbx nodes is in UTC.
