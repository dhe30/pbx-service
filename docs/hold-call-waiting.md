# Hold + call waiting

Requirement (course): a staff member can put a caller on hold, answer another call, then go back
to the first. This file fills in the details: what exactly must work, how each component does it,
which decisions were made, and how to test it. Status: **implemented in phase 1, not yet run on
a VM** (see "Verify on the first deploy").

## 1. Requirements

### Functional
| #   | Requirement |
|-----|-------------|
| H1  | While on a call, staff can **hold** it. The caller hears **music on hold** (MOH) within ~1 s, and neither side hears the other. |
| H2  | Staff can **resume** a held call. MOH stops and two-way audio returns within ~1 s. |
| H3  | Hold/resume can be repeated any number of times on the same call. |
| W1  | **Call waiting**: staff already on a call (active or held) is still offered new calls. The ARI app never skips a staff member because they are busy. |
| W2  | A waiting call is shown in the softphone with a short call-waiting beep (not a full ringtone), and can be answered or declined. |
| W3  | Answering a waiting call **automatically holds** the active one. At most one call is active (unheld) at a time. |
| W4  | Declining a waiting call sends **486 Busy Here**. The call keeps ringing any other ring-group members; for a single user it goes to voicemail, the same as no answer. |
| W5  | A softphone has **no limit** on calls at once (active + held + ringing). It never rejects a call by itself; only staff declining sends 486. |
| W6  | Staff can hang up any call, held or not. Hanging up the active call does **not** resume a held one automatically: staff resumes it explicitly. |
| W7  | If the held caller hangs up, their call disappears from the softphone. Nothing else changes. |

### Reliability (the grade)
| #   | Requirement |
|-----|-------------|
| R1  | A held call is not dropped by media timeouts while it is held, for up to **30 min** (`hold_max_sec`). After that it is treated as a dead device and hung up. |
| R2  | A failed hold or resume (re-INVITE rejected, timeout, 491 glare) leaves the call in its previous state, and staff can retry. |
| R3  | A failed MOH start or stop never drops the call (worst case: the caller hears silence on hold). |
| R4  | Hold works for browser (WebRTC) **and** plain SIP phones (UDP), and with call recording **on or off**. |
| R5  | Hold works with 2 edges (phase 4): the browser's WebSocket can be on a different edge than the one anchoring the call's media. |

### Out of scope (not required; the design leaves room)
Transfers (blind/attended), parking/pickup from another device, conferencing, a hold timer
announcement ("your call is important…"), per-tenant MOH upload, holding from the server side
(API button), the carrier holding *us* (the app ignores it; in a 2-party bridge Asterisk plays MOH to the staff
member by itself).

## 2. How it works

```
 Browser (SIP.js)            Kamailio              rtpengine           Asterisk           ARI app
   | re-INVITE a=sendonly ----->| leg=staff_ws        |                    |                  |
   |                            |-- offer (SAVPF->AVP) ->|                 |                  |
   |                            |------------- re-INVITE a=sendonly ------>|                  |
   |                            |<------------ 200 OK a=recvonly ----------|-- ChannelHold -->|
   |                            |-- answer (AVP->SAVPF) ->|                |                  |
   |<----- 200 OK a=recvonly ---|                     |                    |<- POST caller/moh|
   | ACK ---------------------->|------------------------------------------>|  caller hears MOH|
```

Resume is the same with `a=sendrecv`, `ChannelUnhold`, and `DELETE /channels/<caller>/moh`.

### Per component
- **Softphone** (`telephony/webrtc-test/index.html` now; `services/web` later): SIP.js
  `UserAgent` + `Invitation` (not `SimpleUser`, which has one session only). Hold = re-INVITE
  with `sessionDescriptionHandlerOptionsReInvite.hold = true`, which marks the SDP `sendonly`.
  The page also disables the local mic track and the remote audio track for that call.
- **Kamailio** (`kamailio.cfg.j2`): in-dialog re-INVITEs go through `route[INDLG_SDP]`. Each call
  leg is tagged when it is set up: `leg=carrier`, `leg=staff_ws` (browser) or `leg=staff_udp`
  (SIP phone). From the tag and the sender (Asterisk or not), Kamailio picks the rtpengine flags
  for the re-offer and the answer. It never decides from the request's own transport: with two
  edges, the browser's re-INVITE reaches the anchoring edge over UDP from the peer edge (R5).
- **rtpengine**: rewrites the re-offer and the answer like the initial ones. It keeps the
  DTLS-SRTP session and its role (`DTLS=passive`) toward the browser. The `a=sendonly` /
  `a=recvonly` attributes pass through unchanged. `silent-timeout` (3600 s) covers held streams
  with no packets.
- **Asterisk** (`pjsip.conf.j2`): a remote `sendonly`/`inactive`/`c=0.0.0.0` puts the staff
  channel on hold and fires ARI `ChannelHold`. `moh_passthrough=no` makes Asterisk play MOH itself
  instead of forwarding the hold to the carrier. `rtp_timeout_hold` = `hold_max_sec` (R1).
  The MOH class `default` plays the u-law "opsound" files (`musiconhold.conf.j2`).
- **ARI app** (`services/ari-app/src/ring.ts`, `connectToAgent`): while caller and agent are
  bridged, on `ChannelHold`/`ChannelUnhold` for the **agent** channel it starts/stops MOH on the
  **caller** channel. Errors are logged, never fatal (R3). Metrics: `pbx_calls_on_hold`,
  `pbx_holds_total`.
  - *Why the app does it, not Asterisk*: Asterisk passes the hold on to the other party only in
    a 2-party "simple" bridge. A recorded call has a third member (the recorder), so it uses the
    softmix bridge, which drops hold frames (`bridge_softmix.c`). Without the app, recorded calls
    would get silence on hold. With 2 parties both mechanisms start the same MOH; a second
    start/stop does nothing extra.
  - Channel MOH replaces the bridge audio going to the caller (Asterisk drops bridge frames while
    a generator plays). So the caller hears only MOH and the agent hears nothing (the agent's
    leg is `recvonly` from Asterisk's side).
- **Call waiting** needs nothing on the server: Kamailio has no busy state, and the ARI app rings
  whoever the ring group lists (`ring.ts` header comment). The softphone does the rest (W2–W6).

## 3. Decisions (confirmed 2026-10-28)

| # | Decision | Why / alternative |
|---|----------|-------------------|
| D1 | **Recording keeps running during hold.** The file has the caller's side (anything they say while held) and silence from the agent. MOH is **not** in the recording (channel MOH bypasses the bridge mix). | Pausing (`POST /recordings/live/<name>/pause`) adds state that can go wrong: if the unpause fails, the rest of the call is lost. Switch if the course or tenants need "no audio while held" (PCI-style). |
| D2 | **Max hold 30 min** (`hold_max_sec: 1800`, used by Asterisk `rtp_timeout_hold`). After that the held staff leg is hung up and the caller is disconnected. | Protects against a browser that died while holding (nobody would ever resume). Lower it for a stricter policy. rtpengine's `silent-timeout` (3600) must stay above it. |
| D3 | **Stock Asterisk MOH** (opsound, u-law), one class `default` for all tenants. | Per-tenant MOH upload = future API feature: add a class per tenant and pass it in `startMoh`. |
| D4 | **No call limit per softphone** (W5). | A cap would send calls to voicemail under load tests that ring one user many times at once, which looks like failed calls. Browsers handle dozens of WebRTC connections; only hundreds would be a problem. |
| D5 | **Decline = 486 Busy Here** (was 480). | Correct code for "I'm on another call". The ARI app treats 486, 480 and 603 alike (no trunk retry). |
| D6 | **Answering a waiting call auto-holds the active one** (W3). | Otherwise the mic goes to two callers at once. |
| D7 | **No server-side busy check** (W1). The browser decides. | "Busy = skip this member" would need presence tracking. Not required, and it would break call waiting. |
| D8 | **Hold is not stored in the database** (no column on `calls`). Metrics only. | Add `calls.hold_count/hold_ms` later if call history needs it; the ARI app already sees every event. |

## 4. Tests

- **Browser** (manual, `docs/phase1.md` §4): two inbound calls to alice; answer 1, hold, answer 2,
  hang up 2, resume 1; hold for > 2 min (longer than rtpengine `timeout`=60 s and Asterisk
  `rtp_timeout`=60 s) and check that resume brings audio back.
- **SIPp** (`loadtest/sipp/uas_staff_hold.xml`): staff phone answers, holds for 10 s with
  `a=sendonly`, resumes, then waits for BYE. Call waiting: two concurrent carrier calls to the
  same UAS (`-m 2 -l 2`).
- **Checks while held**: `asterisk -rx "core show channels"` shows the caller with `MusicOnHold`.
  `rtpengine-ctl list sessions all` still lists both legs. ARI app logs `agent hold` /
  `agent unhold`. `curl 127.0.0.1:9101/metrics | grep hold`.

## 5. Verify on the first deploy
- [ ] Browser hold re-INVITE: rtpengine answers with `a=setup:passive` and the DTLS session
      survives. Symptom if not: no audio after resume. Look at the SDP in sngrep.
- [ ] Caller hears MOH on hold **with recording on** (softmix) and **off** (simple bridge).
- [ ] A held UDP leg that sends no RTP survives > 60 s (rtpengine `silent-timeout` applies to
      `sendonly`/`recvonly` streams, not `timeout`).
- [ ] SIPp UAS `[routes]` (from `rrs="true"` on the received INVITE) routes the re-INVITE back
      through Kamailio.
- [ ] MOH files are installed in `/var/lib/asterisk/moh` (u-law).
- [ ] **On a cloud (KVM) VM**: music on hold sounds clean, and Asterisk sends ~50 packets/s per
      stream (`docs/local-vm.md` §7). Can't be judged on the local VirtualBox VM under Hyper-V:
      its guest clock runs ~8% slow there (2026-10-29), which garbles music.
      If music is still choppy on KVM, switch `CallerHold` (hold.ts) to bridge MOH
      (`POST/DELETE /bridges/<id>/moh`): it sounded better in the local test, but puts the music
      into recordings (changes D1). Kept channel MOH for now (decided 2026-10-29).
