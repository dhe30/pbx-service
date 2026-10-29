import { randomUUID } from 'node:crypto';
import { onChannel, onChannels, onRecordingDone } from './ari/events.js';
import type { Ctx } from './ctx.js';
import { CallerHold } from './hold.js';
import type { StaffTarget } from './repo.js';
import type { CallSession } from './session.js';

// Ringing staff and connecting the caller to whoever answers.
//
// Each staff leg is originated through a PJSIP trunk to Kamailio: PJSIP/<sip_username>@edge-a.
// Kamailio looks the user up in the shared location table and delivers to the browser (WSS) or
// SIP phone (UDP). If Kamailio says the user isn't registered (480) the leg just fails.
// If a leg fails *immediately* for a network/server reason, the edge is probably down: retry the
// same user through the next trunk (edge-b).
//
// Call waiting: there is deliberately NO busy check. A staff member who is already on a call
// (active or held) is rung like anyone else; their softphone shows it as a waiting call and
// either answers it (holding the current one) or declines with 486, which counts as "didn't
// answer" (USER_CAUSES) for this leg. See docs/hold-call-waiting.md.

export interface AnsweredLeg {
  channelId: string;
  userId: string;
}

/** Leg failed within this window with a non-user cause => try the next trunk. */
const FAST_FAIL_MS = 3000;
/**
 * Q.850 causes that mean "the person didn't/couldn't answer", not "the path is broken".
 * 1 unallocated (404), 16 normal, 17 busy, 18 no user response (408/480), 19 no answer,
 * 20 subscriber absent (480), 21 rejected (603/decline).
 */
const USER_CAUSES = new Set([1, 16, 17, 18, 19, 20, 21]);
const RINGBACK = 'tone:ring;tonezone=us';

interface Leg {
  target: StaffTarget;
  trunkIdx: number;
  startedAt: number;
}

/**
 * Ring all `targets` at once; the first to answer wins and the others are hung up.
 * Returns null on timeout, if every leg failed, or if there were no targets.
 * Throws HangupError if the caller hangs up while ringing.
 */
export async function ringTargets(
  ctx: Ctx,
  s: CallSession,
  targets: StaffTarget[],
  timeoutSec: number,
): Promise<AnsweredLeg | null> {
  if (targets.length === 0) return null;
  const trunks = ctx.cfg.TRUNKS;
  const legs = new Map<string, Leg>();
  const pending = new Set<string>(); // live set: the subscription sees ids as they're added
  const sub = ctx.bus.subscribe(onChannels(pending, 'StasisStart', 'ChannelDestroyed'));
  const ringbackId = randomUUID();
  const deadline = Date.now() + timeoutSec * 1000;

  const originate = async (target: StaffTarget, fromTrunk: number): Promise<void> => {
    for (let i = fromTrunk; i < trunks.length; i++) {
      const channelId = randomUUID();
      pending.add(channelId);
      legs.set(channelId, { target, trunkIdx: i, startedAt: Date.now() });
      try {
        await ctx.ari.originate({
          endpoint: `PJSIP/${target.sipUsername}@${trunks[i]}`,
          channelId,
          appArgs: `outbound:${s.channelId}`,
          callerId: s.callerNumber,
          timeout: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
          originator: s.channelId,
        });
        return;
      } catch (err) {
        s.log.warn({ err, user: target.sipUsername, trunk: trunks[i] }, 'originate failed');
        pending.delete(channelId);
        legs.delete(channelId);
      }
    }
  };

  try {
    await ctx.ari.play(s.channelId, RINGBACK, ringbackId).catch(() => {});
    for (const t of targets) await originate(t, 0);

    while (pending.size > 0) {
      const ev = await sub.next({ signal: s.signal, timeoutMs: deadline - Date.now() });
      if (!ev) {
        s.log.info('ring: timeout');
        return null;
      }
      const leg = legs.get(ev.channel.id)!;
      pending.delete(ev.channel.id);
      if (ev.type === 'StasisStart') {
        s.log.info({ user: leg.target.sipUsername, trunk: trunks[leg.trunkIdx] }, 'ring: answered');
        return { channelId: ev.channel.id, userId: leg.target.userId };
      }
      // ChannelDestroyed before answer
      const fast = Date.now() - leg.startedAt < FAST_FAIL_MS;
      s.log.info({ user: leg.target.sipUsername, cause: ev.cause, causeTxt: ev.cause_txt }, 'ring: leg ended');
      if (fast && !USER_CAUSES.has(ev.cause) && leg.trunkIdx + 1 < trunks.length) {
        await originate(leg.target, leg.trunkIdx + 1);
      }
    }
    return null;
  } finally {
    sub.close();
    await ctx.ari.stopPlayback(ringbackId).catch(() => {});
    // Everyone still ringing lost (or we gave up): stop their phones.
    await Promise.all([...pending].map((id) => ctx.ari.hangupQuietly(id).catch(() => {})));
  }
}

/** Ring targets one at a time, each for `timeoutSec`. */
export async function ringSequential(
  ctx: Ctx,
  s: CallSession,
  targets: StaffTarget[],
  timeoutSec: number,
): Promise<AnsweredLeg | null> {
  for (const t of targets) {
    const leg = await ringTargets(ctx, s, [t], timeoutSec);
    if (leg) return leg;
  }
  return null;
}

/**
 * Bridge caller and agent, optionally record the bridge, and return when either side hangs up
 * (throws HangupError if it was the caller). While connected, the agent's hold/resume plays or
 * stops music on hold for the caller; the recording keeps running (decision D1).
 */
export async function connectToAgent(ctx: Ctx, s: CallSession, agent: AnsweredLeg, record: boolean): Promise<void> {
  const bridgeId = randomUUID();
  const agentEvents = ctx.bus.subscribe(
    onChannel(agent.channelId, 'StasisEnd', 'ChannelDestroyed', 'ChannelHold', 'ChannelUnhold'),
  );
  const hold = new CallerHold(ctx.ari, s.channelId, ctx.cfg.HOLD_MOH_CLASS, s.log);
  let recording: string | null = null;
  try {
    s.check();
    await ctx.ari.createBridge(bridgeId);
    await ctx.ari.addToBridge(bridgeId, [s.channelId, agent.channelId]);
    s.disposition = 'answered';
    if (s.callId) {
      ctx.repo.markCallAnswered(s.callId, agent.userId).catch((err) => s.log.warn({ err }, 'markCallAnswered failed'));
    }

    if (record && s.tenantId) {
      const mediaId = randomUUID();
      recording = `rec-${mediaId}`;
      await ctx.uploader.begin(recording, {
        kind: 'recording',
        mediaId,
        tenantId: s.tenantId,
        callId: s.callId,
        mailboxId: null,
      });
      try {
        await ctx.ari.recordBridge(bridgeId, recording);
      } catch (err) {
        s.log.error({ err }, 'could not start call recording');
        await ctx.uploader.abandon(recording);
        recording = null;
      }
    }

    // Until the agent hangs up, follow hold/resume from their phone.
    for (;;) {
      const ev = await agentEvents.next({ signal: s.signal });
      if (!ev || ev.type === 'StasisEnd' || ev.type === 'ChannelDestroyed') break;
      await hold.set(ev.type === 'ChannelHold');
    }
    s.log.info({ held: hold.isHeld }, 'agent hung up');
  } finally {
    agentEvents.close();
    hold.end();
    if (recording) await finishRecording(ctx, s, recording);
    await ctx.ari.hangupQuietly(agent.channelId).catch(() => {});
    await ctx.ari.destroyBridge(bridgeId).catch(() => {});
  }
}

async function finishRecording(ctx: Ctx, s: CallSession, name: string): Promise<void> {
  const done = ctx.bus.subscribe(onRecordingDone(name));
  try {
    await ctx.ari.stopRecording(name).catch(() => {});
    const ev = await done.next({ timeoutMs: 5000 });
    // Without the event the file may still be open; the uploader's stale-file sweep handles it.
    if (ev) await ctx.uploader.finish(name);
    else s.log.warn({ name }, 'no RecordingFinished event; leaving recording to the sweep');
  } finally {
    done.close();
  }
}
