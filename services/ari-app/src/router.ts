import { isOpen, normalizeDialed, type Destination, type ForwardDestination } from '@pbx/shared';
import { Conversation } from './conversation.js';
import type { Ctx } from './ctx.js';
import { runIvr } from './ivr.js';
import { extensionTargets, ringSequential, ringTargets, type RingResult, type Winner } from './ring.js';
import type { CallSession, Party } from './session.js';
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
    s.step('route', { to: d });
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
        const now = new Date();
        const open = isOpen(h.schedule, t.timezone, now);
        // The local time the decision used, so "why voicemail at 9 am?" is answerable from the log.
        const local = new Intl.DateTimeFormat('en-US', { timeZone: t.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
        s.log.info({ open, local, tz: t.timezone }, 'business hours');
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
 * A forwarding rule, followed even when it points at the PSTN caller's own number. Ignoring such a
 * rule (2026-11-15 to 11-24) drew tickets on direct calls: "extension 101 rang" (forward always)
 * and "+1631555xxxx never rang" (forward no answer), each a call from the forward target itself.
 * The transfer case that motivated ignoring it ("extension 111 never rang after the transfer") is
 * covered by ringExtension() not applying "forward always" to blind transfers and consult calls.
 */
function forwardRule(f: ForwardDestination | null | undefined): Destination | null {
  return f ? forwardDest(f) : null;
}

/**
 * Ring an extension with its forwarding rules: always -> straight to the forward target;
 * otherwise ring all devices + external numbers; then busy -> forward_busy, no answer ->
 * forward_no_answer, else its voicemail box. Returns the next destination (or connects and
 * returns null).
 *
 * opts.blindTransfer: a blind transfer to this extension rings the extension itself; its
 * "forward always" is not applied (busy / no answer forwarding and voicemail still are). Seen live
 * 2026-11-15 (Zhang Animal Hospital): transfers to 111 and 109, both "forward always" to an
 * outside number, were sent to that number; the course counted each as "extension never rang
 * after the transfer (REFER 202)". Direct calls to those extensions follow the forward with no
 * complaint, so only transfers skip it.
 */
/**
 * The consult call of an attended transfer: a phone calls an extension while it holds another
 * call. The transfer target is reached through this call, so, like a blind transfer, it rings the
 * extension itself rather than its "forward always" (seen live 2026-11-15: 103 held a caller and
 * called 111, which forwards always to an outside number; the transfer joined the caller with that
 * number and 111 never rang). Ordinary calls between extensions still follow the forward.
 * Only calls of the caller's own account count: every account has a 101, 102, ... and a pbx node
 * carries many accounts. Comparing the number alone made any account's held 102 turn another
 * account's ordinary call from 102 into a "consult call", so its target's forward always was
 * skipped (live 2026-11-25, Pereira Deli 23:44 on pbx-5: "forward always not working: extension
 * 105 rang"; also Becker 101, Uptown 102).
 */
function isConsultCall(ctx: Ctx, s: CallSession): boolean {
  const from = s.main?.direction === 'internal' ? s.main.fromExtension : null;
  const tenantId = s.tenant?.id;
  if (!from || !tenantId) return false;
  for (const conv of new Set(ctx.conversations.values())) {
    if (conv.tenantId === tenantId && conv.holdingExtensions().includes(from)) return true;
  }
  return false;
}

export async function ringExtension(
  ctx: Ctx,
  s: CallSession,
  ext: ExtensionCfg,
  opts: { blindTransfer?: boolean } = {},
): Promise<Destination | null> {
  const leg = s.routingLeg;
  if (leg && !leg.toExtension) leg.toExtension = ext.number;
  const skipAlways = opts.blindTransfer ? 'blind transfer' : isConsultCall(ctx, s) ? 'consult call' : null;
  if (skipAlways && ext.forwardAlways) {
    s.log.info({ ext: ext.number, to: ext.forwardAlways, why: skipAlways }, 'forward always not applied to a transfer');
  }
  const always = skipAlways ? null : forwardRule(ext.forwardAlways);
  if (always) {
    s.log.info({ ext: ext.number, to: always }, 'forward always');
    return always;
  }
  const r: RingResult = await ringTargets(ctx, s, extensionTargets(ext, callerNumberOf(s)), ext.ringTimeoutSec);
  if (r.winner) {
    await connect(ctx, s, r.winner);
    return null;
  }
  s.ringOutcome = r.outcome;
  const next =
    r.outcome === 'busy' ? forwardRule(ext.forwardBusy) : forwardRule(ext.forwardNoAnswer);
  if (next) return next;
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
  // Before a transfer: the main row (the extension that answered first). After one: the transfer
  // leg (the extension the call was transferred to); the main row keeps the first answerer.
  const leg = s.routingLeg;
  if (leg) {
    if (winner.target.extension) leg.toExtension = winner.target.extension.number;
    if (leg !== s.main || leg.direction === 'internal') leg.answeredAt ??= new Date();
  }
  await s.ensureAnswered(ctx.ari);
  const conv = new Conversation(ctx, s, s.primary, winner.channelId, {
    record: !!s.tenant?.recordCalls,
    mohClass: ctx.cfg.HOLD_MOH_CLASS,
  });
  conv.identify(s.primary, s.primaryIs);
  conv.identify(winner.channelId, partyOf(winner));
  const end = await conv.run();
  if (end.reason === 'blind_transfer') {
    const at = new Date();
    // The party left on the call is the primary now (Conversation.transfer rebinds).
    s.primaryParty = conv.whoIs(end.remaining) ?? s.primaryIs;
    const dest = resolveDialTarget(s.tenant!, end.target);
    s.log.info({ target: end.target, dest }, 'routing blind transfer');
    if (dest?.type === 'extension') {
      // Ring the target extension itself (no "forward always"), then follow what it returns.
      const ext = s.tenant!.extensions.get(dest.id);
      if (!ext) return missing(s, dest);
      // Its own CDR row from now on (the main row keeps who answered before the transfer).
      s.beginTransferLeg(at, { extension: ext.number, number: ext.number });
      const next = await ringExtension(ctx, s, ext, { blindTransfer: true });
      if (next) await routeTo(ctx, s, next);
    } else {
      // To an outside number (its own charged leg, ring.ts) or nowhere: no transfer leg.
      s.endTransferLeg(at);
      if (dest) await routeTo(ctx, s, dest);
    }
  }
}

/** Who answered: an extension (its phone or one of its external numbers) or an outside number. */
function partyOf(w: Winner): Party {
  const ext = w.target.extension?.number ?? null;
  return { extension: ext, number: w.target.kind === 'external' ? w.target.number : ext };
}

/** A number typed on a phone (or a REFER target): extension of the account, else a PSTN number. */
export function resolveDialTarget(t: TenantConfig, dial: string): Destination | null {
  const ext = t.extByNumber.get(dial);
  if (ext) return { type: 'extension', id: ext.id };
  const e164 = normalizeDialed(dial);
  return e164 ? { type: 'external', number: e164 } : null;
}
