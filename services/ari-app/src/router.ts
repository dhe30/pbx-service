import { isOpen, normalizeDialed, type Destination, type ForwardDestination } from '@pbx/shared';
import { Conversation } from './conversation.js';
import type { Ctx } from './ctx.js';
import { runIvr } from './ivr.js';
import { extensionTargets, ringSequential, ringTargets, type RingResult, type Winner } from './ring.js';
import type { CallSession } from './session.js';
import type { ExtensionCfg, TenantConfig } from './tenant.js';
import { leaveVoicemail } from './voicemail.js';

// Where a call goes (spec §3). Every routing decision is a Destination:
//   extension | ring_group | ivr_menu | voicemail | business_hours | external | hangup
// routeTo() executes one and follows the chain (menu -> ring group -> no-answer destination ...)
// up to MAX_ROUTE_HOPS, so a misconfigured loop (A forwards to B forwards to A) ends the call
// instead of spinning forever.

export async function routeTo(ctx: Ctx, s: CallSession, dest: Destination | null): Promise<void> {
  const t = s.tenant!;
  for (let d = dest; d; ) {
    s.check();
    if (++s.hops > ctx.cfg.MAX_ROUTE_HOPS) {
      s.log.warn({ dest: d }, 'route: too many hops (loop?); hanging up');
      return;
    }
    switch (d.type) {
      case 'hangup':
        return;
      case 'extension': {
        const ext = t.extensions.get(d.id);
        if (!ext) return missing(s, d);
        d = await ringExtension(ctx, s, ext);
        break;
      }
      case 'ring_group': {
        const g = t.ringGroups.get(d.id);
        if (!g) return missing(s, d);
        const members = g.memberIds.map((id) => t.extensions.get(id)).filter((e): e is ExtensionCfg => !!e);
        if (members.length === 0) {
          // Every member was deleted: nobody to ring, go straight to the no-answer destination.
          s.ringOutcome = 'no_answer';
          d = g.noAnswer;
          break;
        }
        const caller = callerNumberOf(s);
        const targetsOf = (e: ExtensionCfg) => extensionTargets(e, caller);
        const r =
          g.strategy === 'sequential'
            ? await ringSequential(ctx, s, members.map(targetsOf), g.ringTimeoutSec, g.totalTimeoutSec)
            : await ringTargets(ctx, s, members.flatMap(targetsOf), Math.min(g.ringTimeoutSec, g.totalTimeoutSec ?? Infinity));
        if (r.winner) return connect(ctx, s, r.winner);
        s.ringOutcome = r.outcome;
        d = g.noAnswer;
        break;
      }
      case 'ivr_menu': {
        const m = t.ivrMenus.get(d.id);
        if (!m) return missing(s, d);
        d = await runIvr(ctx, s, m);
        break;
      }
      case 'voicemail':
        return leaveVoicemail(ctx, s, d.id);
      case 'business_hours': {
        const h = t.businessHours.get(d.id);
        if (!h) return missing(s, d);
        const open = isOpen(h.schedule, t.timezone, new Date());
        s.log.info({ open }, 'business hours');
        d = open ? h.open : h.closed;
        break;
      }
      case 'external': {
        const r = await ringTargets(ctx, s, [{ kind: 'external', number: d.number, extension: null }], 60);
        if (r.winner) return connect(ctx, s, r.winner);
        s.ringOutcome = r.outcome;
        return;
      }
    }
  }
}

function missing(s: CallSession, d: Destination): void {
  s.log.warn({ dest: d }, 'route: destination no longer exists; hanging up');
}

/** ForwardDestination is a subset of Destination (extension | voicemail | external). */
const forwardDest = (f: ForwardDestination): Destination => f;

/**
 * Ring an extension with its forwarding rules: always -> straight to the forward target;
 * otherwise ring all devices + external numbers; then busy -> forward_busy, no answer ->
 * forward_no_answer, else its voicemail box. Returns the next destination (or connects and
 * returns null).
 */
export async function ringExtension(ctx: Ctx, s: CallSession, ext: ExtensionCfg): Promise<Destination | null> {
  if (s.main && !s.main.toExtension) s.main.toExtension = ext.number;
  if (ext.forwardAlways) {
    s.log.info({ ext: ext.number, to: ext.forwardAlways }, 'forward always');
    return forwardDest(ext.forwardAlways);
  }
  const r: RingResult = await ringTargets(ctx, s, extensionTargets(ext, callerNumberOf(s)), ext.ringTimeoutSec);
  if (r.winner) {
    await connect(ctx, s, r.winner);
    return null;
  }
  s.ringOutcome = r.outcome;
  if (r.outcome === 'busy' && ext.forwardBusy) return forwardDest(ext.forwardBusy);
  if (r.outcome !== 'busy' && ext.forwardNoAnswer) return forwardDest(ext.forwardNoAnswer);
  if (ext.mailboxId) return { type: 'voicemail', id: ext.mailboxId };
  return null;
}

/** The PSTN caller's number (E.164), never rung as one of an extension's external numbers. */
function callerNumberOf(s: CallSession): string | null {
  return s.main?.direction === 'incoming' ? s.main.fromNumber : null;
}

/** Bridge the caller with whoever answered and drive the call; follows blind transfers. */
export async function connect(ctx: Ctx, s: CallSession, winner: Winner): Promise<void> {
  s.connected = true;
  s.ringOutcome = null;
  if (s.main) {
    if (winner.target.extension) s.main.toExtension = winner.target.extension.number;
    if (s.main.direction === 'internal') s.main.answeredAt ??= new Date();
  }
  await s.ensureAnswered(ctx.ari);
  const conv = new Conversation(ctx, s, s.primary, winner.channelId, {
    record: !!s.tenant?.recordCalls,
    mohClass: ctx.cfg.HOLD_MOH_CLASS,
  });
  const end = await conv.run();
  if (end.reason === 'blind_transfer') {
    const dest = resolveDialTarget(s.tenant!, end.target);
    s.log.info({ target: end.target, dest }, 'routing blind transfer');
    if (dest) await routeTo(ctx, s, dest);
  }
}

/** A number typed on a phone (or a REFER target): extension of the account, else a PSTN number. */
export function resolveDialTarget(t: TenantConfig, dial: string): Destination | null {
  const ext = t.extByNumber.get(dial);
  if (ext) return { type: 'extension', id: ext.id };
  const e164 = normalizeDialed(dial);
  return e164 ? { type: 'external', number: e164 } : null;
}
