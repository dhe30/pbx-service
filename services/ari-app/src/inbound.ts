import { normalizeCarrierNumber } from '@pbx/shared';
import type { Ctx } from './ctx.js';
import { didCandidates } from './did.js';
import { metrics } from './metrics.js';
import { routeTo } from './router.js';
import { HangupError, newLeg, type CallSession } from './session.js';

// A call from the PSTN to one of our DIDs (carrier -> Kamailio -> this Asterisk, X-PBX-Src: carrier).
//
// Post-dial delay (graded, p95): we send 180 Ringing BEFORE any lookup. The account config is
// normally already in memory (ConfigCache), so routing starts within a few ms; nothing is written
// to the database until the call ends (CdrWriter).

// A rejected call comes straight back: on 2026-11-13 every blocked call reached the same pbx node
// twice within the same second (most likely the carrier trying the DID's other trunk after our
// 403), and each attempt wrote its own CDR, so call history showed every blocked call twice.
// Repeats of the same caller -> DID within this window are still rejected but not recorded again.
export const BLOCKED_REPEAT_MS = 10_000;
const recentlyBlocked = new Map<string, number>();

/** true if this caller -> DID was already rejected (and recorded) within BLOCKED_REPEAT_MS. */
function isBlockedRepeat(key: string, now = Date.now()): boolean {
  for (const [k, at] of recentlyBlocked) if (now - at > BLOCKED_REPEAT_MS) recentlyBlocked.delete(k);
  const seen = recentlyBlocked.has(key);
  recentlyBlocked.set(key, now);
  return seen;
}

export async function handleCarrierCall(ctx: Ctx, s: CallSession): Promise<void> {
  void ctx.ari.ring(s.primary).catch(() => {});
  let failedBeforeAnswer = false;
  try {
    const dids = didCandidates(s.exten);
    const t = await ctx.cache.tenantForDid(dids);
    const num = t && dids.map((d) => t.numbers.get(d)).find((n) => !!n);
    if (!t || !num) {
      s.log.info({ exten: s.exten }, 'unknown DID');
      await ctx.ari.hangupQuietly(s.primary, 'unallocated'); // -> 404 to the carrier
      return;
    }
    s.tenant = t;
    const caller = normalizeCarrierNumber(s.callerNumber);
    const rates = await ctx.cache.getRates();
    s.main = newLeg({
      direction: 'incoming',
      fromNumber: caller ?? (s.callerNumber || null),
      toNumber: num.did,
      did: num.did,
      // Incoming toll-free: always per minute (we pay DIDWW per second of it too). Others are free.
      chargeClass: num.kind === 'toll_free' ? 'toll_free_in' : 'incoming',
      costPerMin: num.kind === 'toll_free' ? (num.incomingCostPerMin ?? rates.pricing.tollFreeInCostPerMin) : 0,
    });
    // Legs we place for this call (forward, simultaneous ring, IVR -> external) show the DID.
    s.presentedNumber = num.did;
    s.log = s.log.child({ callId: s.callId, tenant: t.id });

    // "Caller blocklist. Listed callers are rejected."
    if (caller && t.blocked.has(caller)) {
      if (isBlockedRepeat(`${t.id}|${caller}|${num.did}`)) {
        s.log.info({ caller }, 'blocked caller, repeat attempt: rejected without a second CDR');
        s.main = null; // finish() writes nothing
      } else {
        s.log.info({ caller }, 'blocked caller');
        s.main.outcome = 'blocked';
        metrics.blockedCalls.inc();
      }
      await ctx.ari.hangupQuietly(s.primary, 'rejected');
      return;
    }

    await routeTo(ctx, s, num.destination);
  } catch (err) {
    if (!(err instanceof HangupError)) {
      s.log.error({ err }, 'inbound call flow failed');
      if (s.main) s.main.outcome ??= 'failed';
      // Before answer, 503 makes Kamailio retry the call on another pbx node.
      failedBeforeAnswer = !s.answered;
    }
  } finally {
    await s.hangupPrimary(ctx.ari, failedBeforeAnswer ? 'congestion' : 'normal').catch(() => {});
  }
}
