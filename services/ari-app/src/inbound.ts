import type { IvrAction } from '@pbx/shared';
import type { Ctx } from './ctx.js';
import { didCandidates } from './did.js';
import { runIvr } from './ivr.js';
import { metrics } from './metrics.js';
import type { InboundRoute } from './repo.js';
import { connectToAgent, ringSequential, ringTargets } from './ring.js';
import { HangupError, type CallSession } from './session.js';
import { voicemail } from './voicemail.js';

// Inbound call flow (CLAUDE.md §10): DID lookup -> calls row -> answer -> IVR -> action.

export async function handleInbound(ctx: Ctx, s: CallSession): Promise<void> {
  let answered = false;
  try {
    const route = await ctx.repo.findInboundRoute(didCandidates(s.exten));
    if (!route) {
      s.log.info({ exten: s.exten }, 'unknown DID');
      await ctx.ari.hangupQuietly(s.channelId, 'unallocated'); // -> 404 to the carrier
      return;
    }
    s.tenantId = route.tenantId;
    s.callId = await ctx.repo.insertCall({
      tenantId: route.tenantId,
      phoneNumberId: route.phoneNumberId,
      callerNumber: s.callerNumber,
      pbxNode: ctx.cfg.PBX_NODE,
    });
    s.log = s.log.child({ callId: s.callId });
    s.check();

    await ctx.ari.answer(s.channelId);
    answered = true;
    s.log.info({ from: s.callerNumber, did: s.exten }, 'call answered by IVR');

    const action = await runIvr(ctx, s, route);
    if (action) await executeAction(ctx, s, route, action);
  } catch (err) {
    if (!(err instanceof HangupError)) {
      s.disposition ??= 'failed';
      s.log.error({ err }, 'call flow failed');
      // Before answer, 503 makes Kamailio retry the call on another pbx node.
      if (!answered) await ctx.ari.hangupQuietly(s.channelId, 'congestion').catch(() => {});
    }
  } finally {
    await ctx.ari.hangupQuietly(s.channelId).catch(() => {});
    if (s.callId) {
      const disposition = s.disposition ?? 'abandoned';
      metrics.callsTotal.inc({ disposition });
      await ctx.repo.finishCall(s.callId, disposition).catch((err) => s.log.error({ err }, 'finishCall failed'));
    }
    s.log.info({ disposition: s.disposition }, 'call ended');
  }
}

async function executeAction(ctx: Ctx, s: CallSession, route: InboundRoute, action: IvrAction): Promise<void> {
  const tenantId = route.tenantId;
  switch (action.action) {
    case 'voicemail':
      return voicemail(ctx, s, action.target);

    case 'ring_group': {
      const group = await ctx.repo.getRingGroup(tenantId, action.target);
      if (!group) {
        s.log.warn({ groupId: action.target }, 'ring group not found');
        return;
      }
      const ring = group.strategy === 'sequential' ? ringSequential : ringTargets;
      const agent = await ring(ctx, s, group.members, group.ringTimeoutSec);
      if (agent) return connectToAgent(ctx, s, agent, route.recordCalls);
      if (group.fallbackMailboxId) return voicemail(ctx, s, group.fallbackMailboxId);
      return;
    }

    case 'user': {
      const user = await ctx.repo.getStaffUser(tenantId, action.target);
      if (!user) {
        s.log.warn({ userId: action.target }, 'user not found or has no SIP account');
        return;
      }
      const agent = await ringTargets(ctx, s, [user], ctx.cfg.USER_RING_TIMEOUT_SEC);
      if (agent) return connectToAgent(ctx, s, agent, route.recordCalls);
      if (user.mailboxId) return voicemail(ctx, s, user.mailboxId);
      return;
    }
  }
}
