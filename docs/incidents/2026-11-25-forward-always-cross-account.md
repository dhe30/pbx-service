# 2026-11-25: "forward always" skipped because another account's extension held a call

Found while triaging the 19:41-00:24 UTC tickets. Fix: branch `fix/consult-call-per-account`
(commit 0b12423). Times are UTC.

## Summary

An extension with "forward always" sometimes rang itself instead of forwarding. The ARI app took
an ordinary call between two extensions for the consult call of an attended transfer, and consult
calls deliberately skip "forward always" (so the transfer target itself rings, 2026-11-15, commit
1ceb1d6). The consult-call check compared only the caller's **extension number** against every
held call on the pbx node, across **all accounts**. Every account has a 101, 102, 103 ... and a
pbx node carries many accounts, so any other account's 102 holding a call was enough to make this
account's call from 102 a "consult call".

Tickets with this pattern ("forward always not working: extension N rang"):

| Time | Account | Extension that rang |
|---|---|---|
| 20:08 | Becker Staffing | 101 |
| 20:26 | Pereira Deli | 101 |
| 22:50 | Uptown Mortgage | 102 |
| 23:45 | Pereira Deli | 105 (traced, below) |

Only the 23:45 ticket was traced in the logs; the others match the pattern. The 18:07 Zhang Animal
Hospital "forward always" ticket may be the same bug (not traced).

## How it was found

`journalctl -u pbx-ari-app` on all pbx nodes, 23:44:30-23:46:30, grep `forward`. On pbx-5:

```
23:44:36  tenant bc7b012f…  ext 102 -> ext 105 (forwardAlways: external +16315550701)
          why "consult call"   msg "forward always not applied to a transfer"
23:44:44  ring: answered -> Desk 105
23:45:54  ticket: "forward always not working: extension 105 rang"
```

Nothing in that account was on hold. Other forward-always calls in the same minute (pbx-2, pbx-3)
were logged `forward always` and forwarded correctly.

## Cause

`services/ari-app/src/router.ts`, `isConsultCall()`:

```ts
for (const conv of new Set(ctx.conversations.values())) {
  if (conv.holdingExtensions().includes(from)) return true;   // number only, any account
}
```

`Party` (`session.ts`) holds only `number` and `extension`, not the account, so the check could not
tell accounts apart.

## Change

- `conversation.ts`: `Conversation` exposes `tenantId` (the account of the call's session).
- `router.ts`: `isConsultCall()` only counts conversations with the caller's `tenantId`; a call
  without a known account is never a consult call.
- Every conversation has an account: both entry points set `s.tenant` before any routing
  (`device.ts`, `inbound.ts`), and conversations are only created in `router.ts` `connect()` from
  that session. A call to another account's number is a separate session in that account.

## Tests

- New spec test (`test/spec/hold-transfer.test.ts`): another account's 103 holds a call; this
  account's 103 calls 111 (forward always to an outside number) -> forwarded, 111 does not ring.
  It **fails on the old rule** ("timed out waiting for forwarded to the outside number") and passes
  with the fix.
- The existing attended-transfer tests still pass, including the 2026-11-15 case (a real consult
  call to a forward-always extension rings the extension itself).
- Full ari-app suite on Node 24: 203 passed; `configs.test.ts` skipped (needs rendered configs,
  unrelated). `tsc --noEmit` clean.

Local test note: if every spec test times out at 20 s, the local build of `services/shared`
(`dist/`, gitignored) is probably stale. Here it dated from 2026-11-09 and lacked
`callPricingForLeg` (added 2026-11-22), so every CDR insert failed and the tests waited forever.
Run `npm run build` in `services/shared`.

## Deploy

Live with the next ARI app rollout (pbx nodes drain one at a time, README §2.4), together with #150
(disk stall) and #154 (recording via snoop). Not deployed yet. After it is live, a call like the one
above logs `forward always` instead of `forward always not applied to a transfer`.

## Other findings from the same triage

- **pbx-3 Asterisk restarted at 21:18:06** (`NRestarts=5`; pbx-1 `NRestarts=2`, others 0). It
  matches the 21:16-21:19 tickets: `refresh_failed_481/408` (Garcia Plumbing), `no_audio` (Prairie
  Appliances) and the missing call record for Garcia's 21:16:57 call. Likely the softmix recording
  crash fixed in #154; not yet confirmed from the journal or a core dump.
- **Voicemail deleted by phone (*98, 3) still listed on the website** (Oakwood 21:14, Garcia 21:58):
  not traced yet (`vm-access.ts`).
- **Hussain Notary, 4 tickets 22:53-00:15:** no ARI app errors or timeouts on any pbx node
  23:59-00:16, so not a sick node; not traced call by call yet.
