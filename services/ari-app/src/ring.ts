import { randomUUID } from 'node:crypto';
import type { CdrOutcome } from '@pbx/shared';
import { chKey, onWatched } from './ari/events.js';
import { ms, type Ctx } from './ctx.js';
import { metrics } from './metrics.js';
import { planPstnLeg, vendorEndpoint } from './pstn.js';
import { combineOutcomes, newLeg, outcomeFromCause, type CallSession, type LegDraft } from './session.js';
import type { ExtensionCfg } from './tenant.js';

// Ringing: "A call rings all of an extension's devices, its softphone, and its listed external
// numbers at once; the first answer wins and the rest stop." (spec §3)
//
//  - Devices: ONE originate per extension, PJSIP/<sip_username>@edge-a. Kamailio looks up every
//    registered contact of that user and forks to all of them in parallel (desk phones, softphone,
//    over UDP, TLS or WebSocket). When one answers, Kamailio CANCELs the rest.
//  - External numbers: one originate per number through a PSTN vendor; each is its own charged CDR
//    leg (outgoing, parent = the call's main row).
//  - A leg that fails *fast* for a non-user reason means that edge is probably down: retry it via
//    the next trunk (edge-b). (Kamailio-side failover covers pbx nodes; this covers edges.)
//
// Call waiting: no busy check. A device already on a call rings like any other; it either answers
// (holding its current call) or declines with 486 (busy).

export type RingTarget =
  | { kind: 'sip'; sipUsername: string; extension: ExtensionCfg | null }
  | { kind: 'external'; number: string; extension: ExtensionCfg | null };

export interface Winner {
  channelId: string;
  target: RingTarget;
}

export interface RingResult {
  winner: Winner | null;
  outcome: Exclude<CdrOutcome, 'blocked'>;
}

export interface RingOptions {
  /**
   * Use the session's main CDR row for the (single) external target instead of a child row:
   * a direct outgoing call from a phone IS the vendor leg.
   */
  externalIsMain?: boolean;
}

/** Leg failed within this window with a non-user cause => try the next trunk. */
const FAST_FAIL_MS = 3000;
/** Q.850 causes that mean "the person didn't/couldn't answer", not "the path is broken". */
const USER_CAUSES = new Set([1, 16, 17, 18, 19, 20, 21]);
const RINGBACK = 'tone:ring;tonezone=us';

interface Leg {
  target: RingTarget;
  trunkIdx: number;
  startedAt: number;
  draft: LegDraft | null;
}

/** All targets for one extension: its devices + its external numbers. */
export function extensionTargets(ext: ExtensionCfg): RingTarget[] {
  return [
    { kind: 'sip', sipUsername: ext.sipUsername, extension: ext },
    ...ext.externalNumbers.map((number): RingTarget => ({ kind: 'external', number, extension: ext })),
  ];
}

/**
 * Ring all `targets` at once; the first to answer wins and the others are hung up.
 * Throws HangupError if the caller hangs up while ringing.
 */
export async function ringTargets(
  ctx: Ctx,
  s: CallSession,
  targets: RingTarget[],
  timeoutSec: number,
  opts: RingOptions = {},
): Promise<RingResult> {
  const t = s.tenant!;
  const trunks = ctx.cfg.TRUNKS;
  const legs = new Map<string, Leg>();
  const outcomes: CdrOutcome[] = [];
  const sub = ctx.bus.subscribe(onWatched('StasisStart', 'ChannelDestroyed'));
  const ringbackId = randomUUID();
  const deadline = Date.now() + ms(ctx, timeoutSec);
  let winner: Winner | null = null;

  const originate = async (target: RingTarget, fromTrunk: number, draft: LegDraft | null, endpointFor: (trunk: string) => string, callerId: string) => {
    for (let i = fromTrunk; i < trunks.length; i++) {
      const channelId = randomUUID();
      sub.watch(chKey(channelId));
      legs.set(channelId, { target, trunkIdx: i, startedAt: Date.now(), draft });
      if (draft) ctx.legs.track(channelId, draft, s);
      try {
        await ctx.ari.originate({
          endpoint: endpointFor(trunks[i]!),
          channelId,
          appArgs: `outbound:${s.primary}`,
          callerId,
          timeout: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
          originator: s.primary,
        });
        return true;
      } catch (err) {
        s.log.warn({ err, endpoint: endpointFor(trunks[i]!) }, 'originate failed');
        sub.unwatch(chKey(channelId));
        legs.delete(channelId);
      }
    }
    if (draft) {
      draft.outcome ??= 'failed';
      draft.endedAt ??= new Date();
    }
    outcomes.push('failed');
    return false;
  };

  const start = async (target: RingTarget, fromTrunk = 0, existing: LegDraft | null = null): Promise<void> => {
    if (target.kind === 'sip') {
      await originate(target, fromTrunk, null, (trunk) => `PJSIP/${target.sipUsername}@${trunk}`, s.ringCallerId);
      return;
    }
    const plan = await planPstnLeg(ctx, t, target.number, s.presentedNumber);
    let draft = existing;
    if (!draft) {
      draft = opts.externalIsMain && s.main ? s.main : newLeg({ direction: 'outgoing', chargeClass: plan.ok ? plan.chargeClass : 'us', parentId: s.main?.id ?? null });
      draft.toNumber = target.number;
      draft.fromNumber = s.presentedNumber;
      draft.did = s.presentedNumber;
      draft.toExtension ??= null;
      if (draft !== s.main) s.children.set(draft.id, draft);
    }
    if (!plan.ok) {
      s.log.info({ number: target.number, reason: plan.reason }, 'external leg blocked');
      draft.outcome = plan.reason === 'no_caller_id' ? 'failed' : 'blocked';
      draft.endedAt = new Date();
      outcomes.push(draft.outcome);
      return;
    }
    Object.assign(draft, { vendor: plan.vendor, chargeClass: plan.chargeClass, costPerMin: plan.costPerMin, ratePrefix: plan.ratePrefix });
    metrics.vendorLegs.inc({ vendor: plan.vendor });
    await originate(target, fromTrunk, draft, (trunk) => vendorEndpoint(ctx, plan.vendor, plan.host, trunk, target.number), plan.callerId);
  };

  try {
    if (!s.answered) await ctx.ari.ring(s.primary).catch(() => {});
    else await ctx.ari.play(s.primary, RINGBACK, ringbackId).catch(() => {});
    // In parallel: a 50-member ring group must not ring member 50 seconds after member 1 (B7).
    await Promise.all(targets.map((tg) => start(tg)));

    while (legs.size > 0) {
      const ev = await sub.next({ signal: s.signal, timeoutMs: deadline - Date.now() });
      if (!ev) {
        s.log.info('ring: timeout');
        return { winner: null, outcome: combineOutcomes(outcomes, true) };
      }
      const leg = legs.get(ev.channel.id);
      if (!leg) continue;
      legs.delete(ev.channel.id);
      if (ev.type === 'StasisStart') {
        sub.unwatch(chKey(ev.channel.id));
        s.log.info({ target: leg.target, trunk: trunks[leg.trunkIdx] }, 'ring: answered');
        winner = { channelId: ev.channel.id, target: leg.target };
        return { winner, outcome: 'answered' };
      }
      // ChannelDestroyed before answer
      const fast = Date.now() - leg.startedAt < FAST_FAIL_MS;
      s.log.info({ target: leg.target, cause: ev.cause, causeTxt: ev.cause_txt }, 'ring: leg ended');
      if (fast && !USER_CAUSES.has(ev.cause) && leg.trunkIdx + 1 < trunks.length) {
        if (leg.draft) leg.draft.endedAt = leg.draft.outcome = null;
        await start(leg.target, leg.trunkIdx + 1, leg.draft);
        continue;
      }
      outcomes.push(outcomeFromCause(ev.cause));
      if (leg.target.kind === 'external') metrics.vendorLegFailures.inc({ cause: String(ev.cause) });
    }
    return { winner: null, outcome: combineOutcomes(outcomes, false) };
  } finally {
    sub.close();
    await ctx.ari.stopPlayback(ringbackId).catch(() => {});
    // Everyone still ringing lost (or we gave up): stop their phones. Their CDR legs end as no answer.
    await Promise.all(
      [...legs.entries()]
        .filter(([id]) => id !== winner?.channelId)
        .map(([id, leg]) => {
          if (leg.draft && !leg.draft.answeredAt) leg.draft.outcome ??= 'no_answer';
          return ctx.ari.hangupQuietly(id).catch(() => {});
        }),
    );
  }
}

/**
 * Ring targets one group at a time (sequential ring groups), each group for `timeoutSec`, all of
 * them together for at most `totalSec` (null = no cap): the member ringing when it runs out is cut
 * short and the rest are skipped.
 */
export async function ringSequential(
  ctx: Ctx,
  s: CallSession,
  groups: RingTarget[][],
  timeoutSec: number,
  totalSec: number | null = null,
): Promise<RingResult> {
  const outcomes: CdrOutcome[] = [];
  const end = totalSec === null ? Infinity : Date.now() + ms(ctx, totalSec);
  for (const g of groups) {
    // Seconds left of the overall timeout (unscaled, like timeoutSec). Under a second: stop here
    // rather than ring a member for a moment.
    const leftSec = (end - Date.now()) / (1000 * ctx.cfg.TIME_SCALE);
    if (leftSec < 1) break;
    const r = await ringTargets(ctx, s, g, Math.min(timeoutSec, leftSec));
    if (r.winner) return r;
    outcomes.push(r.outcome);
  }
  return { winner: null, outcome: combineOutcomes(outcomes, false) };
}
