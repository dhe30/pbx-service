# 2026-11-18: off-peak "inbound" failures = one account's blocked caller

**Question.** Off-peak on 2026-11-18 the grader's failure chart showed a steady trickle of
`inbound` failures (~1 per 20 min, 0.1-0.2/min), while every other bucket was 0. What are they?

**Answer.** Eight of the nine (10:20-14:46 UTC) come 1-2 minutes after a call from the
**blocked caller +16315550252 to Maple IT Services** (tenant 96bd71a5, large, signed up 07:31 UTC
and blocked that number at signup). We rejected each one correctly, but with a **403**, which let the
carrier retry the call on our other edge. The grader's exact criterion is still unknown (see §3).
Times are UTC.

## 1. What a blocked call looks like on the wire

Kamailio's SIP history (`loadtest/diag/sip-history.py`, 2-minute windows), 12:31:46:

```
edge-1  carrier -> INVITE 16312490056      100, 180, 403 Forbidden   (12:31:46.131-.152)
edge-2  carrier -> INVITE 16312490056      100, 403 Forbidden        (12:31:46.157-.167)
```

The DID's trunk group has both edges. After a 4xx the carrier tries the next trunk, so the call
reaches the account's pbx node twice within ~20 ms. The ARI app logs `blocked caller` and then
`blocked caller, repeat attempt: rejected without a second CDR` (PR #38). Only one CDR is written,
with outcome `blocked`.

## 2. Why the SIP code was sometimes 603

`inbound.ts` hung up blocked callers with `reason=rejected` (cause 21 = 403). Its `finally` block
then hangs up again with `reason=normal`. DELETE /channels returns before the channel is gone, so
the second DELETE can land first. Cause 16 before answer has no SIP mapping in chan_pjsip, so the
INVITE ends with **603 Decline**. A 6xx means "do not try elsewhere" (RFC 3261 §21.6): one INVITE,
no carrier retry. Seen live: 12:10:00 (O'Brien), 13:00:36 (Maple) and 14:10:30 (Fischer, edge-2
only) were 603s.

## 3. Which calls the grader counted

| Maple call (+16315550252) | Edges, codes | Grader failure |
|---|---|---|
| 10:20:15, 12:03:43, 12:13:56, 12:18:44, 12:31:46, 14:13:10, 14:19:33, 14:44:08 | both, 403 / 403 | yes (+1-2 min) |
| 11:16:48 | both, 403 / 403 | no |
| 13:00:36 | edge-1 only, 603 | no |

At other tenants the same 403 + retry pattern (Singh Brothers 12:48, Hussain 13:12/13:13, Gallo,
Premier Day Care, O'Brien, Fischer) was **never** counted. The grader doesn't query `/calls` for
these callers (pbx-api logs). So the evidence that 603 fixes it is one call. The 13:30 failure has
no Maple call near it and is unexplained.

## 4. Change

Blocked callers are hung up with `reason=normal` (`BLOCKED_HANGUP_REASON` in
`services/ari-app/src/inbound.ts`): always 603, one INVITE per blocked call, and no race between
the two hangups. Spec: `test/spec/routing.test.ts` (§3 Caller blocklist). Blocked *outgoing*
calls (device.ts, toward our own phones) keep 403.

**Verify after deploy (V-T20):** SIP history shows 603 and a single INVITE for blocked callers,
and the grader's `inbound` trickle stops for Maple's +16315550252 calls.

## 5. Size of the effect

Leaderboard success = calls / (calls + failed). One failure costs ~0.002 points of the 24 h rate,
so this trickle costs ~0.01 points an hour. It is not why the rate fell after the 11-17 peak: that
was the rolling window (successful hours leaving, the peak's ~8.5k failures staying until they
leave 14:55-17:30 UTC on 11-18). It does count toward per-customer dissatisfaction.

## 6. Result after the deploy (V-T20, checked 19:20 UTC)

Deployed 15:24-15:57 (ari-app restarts: pbx-1 15:31, pbx-2 15:39, pbx-3 15:57). The drains caused
no failed INVITEs (SIP history 15:29-15:59 on both edges: only 486/487).

**On the wire: fixed.** Every blocked call is now one INVITE answered 180 + 603 within ~20 ms, on
one edge, with no carrier retry. For example, Maple at 19:11:02 (edge-2 -> pbx-3) and tenant
1a55df98 at 19:09:24 (edge-2 -> pbx-1) look the same.

**In the grader: not fixed.** Maple's blocked calls at 16:42, 17:35/17:36, 17:43/17:44, 18:16,
18:34 and 19:11 are each still followed by an `inbound` failure 1-2 min later. Other tenants'
blocked calls are still not counted. So the SIP code was never what the grader judged.

**What makes Maple different.** +16315550252 behaves like one of Maple's *regular* grader callers,
not like a blocked one:

| Caller (to Maple, 16:14-19:11) | Calls | Redials another Maple DID after rejection |
|---|---|---|
| +16315550252 (blocked) | 16 | yes, ~24 s later (Maple has 3 DIDs) |
| +16315550280 | 17 | - |
| +16315550213 | ~15 | - |
| +16315550249 | ~11 | - |

The blocked numbers at other tenants (e.g. +16315550738 at 1a55df98) call about once every 2 h and
never redial. Maple's blocklist row (created 07:31:21) is unchanged: the API logs on both app nodes
show one POST and one GET of `/blocked-numbers` for it today, and no DELETE.

**Conclusion.** The grader's Maple customer blocked one of its own regular callers and then counts
our (correct) rejection as a failed inbound call. We can't fix that without breaking the
blocklist requirement. It costs ~2-5 failures an hour (~0.01 points an hour) while Maple keeps
calling. Option: ask course staff whether this is intended. 603 stays: it is correct, deterministic
and halves the work per blocked call.
