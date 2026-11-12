import { classifyE164, normalizeDialed } from '@pbx/shared';
import type { HangupReason } from './ari/types.js';
import type { Ctx } from './ctx.js';
import { metrics } from './metrics.js';
import { accountCallerId, planPstnLeg } from './pstn.js';
import { ringTargets } from './ring.js';
import { connect, ringExtension, routeTo } from './router.js';
import { HangupError, newLeg, type CallSession } from './session.js';
import { voicemailAccess } from './vm-access.js';

// A call placed by one of the account's phones (desk phone or softphone), authenticated by
// Kamailio, which tells us who it is (X-PBX-User: <sip username>).
//
// The dialed string decides (spec §3):
//   *98                 -> voicemail access for the caller's extension
//   an extension number -> internal call ("Extensions dial each other by number")
//   a PSTN number       -> outgoing call via the US or international vendor
//     ("Accept US numbers as 10 digits or 1 + 10 digits, and any number as E.164 (+) or with 011.
//       Route by destination; present one of the account's numbers as caller ID.")
// Blocked outgoing calls (past due, international without the add-on) get 403 and a CDR with
// outcome "blocked".

export const VOICEMAIL_ACCESS_CODE = '*98';

const REASON: Record<string, HangupReason> = { busy: 'busy', no_answer: 'no_answer', failed: 'failure', blocked: 'rejected' };

export async function handleDeviceCall(ctx: Ctx, s: CallSession, sipUsername: string): Promise<void> {
  let reason: HangupReason = 'normal';
  try {
    const t = await ctx.cache.tenantForSipUser(sipUsername);
    const ext = t?.extBySip.get(sipUsername);
    if (!t || !ext) {
      s.log.warn({ sipUsername }, 'call from unknown SIP user');
      reason = 'rejected';
      return;
    }
    s.tenant = t;
    s.log = s.log.child({ callId: s.callId, tenant: t.id, ext: ext.number });
    s.ringCallerId = ext.number;
    const dialed = s.exten.trim();
    const common = { fromNumber: ext.number, fromExtension: ext.number, startedAt: new Date() };

    if (dialed === VOICEMAIL_ACCESS_CODE) {
      s.main = newLeg({ ...common, direction: 'internal', chargeClass: 'internal', toNumber: dialed });
      s.connected = true; // the caller reached their mailbox: answered
      await voicemailAccess(ctx, s, ext.mailboxId);
      return;
    }

    const target = t.extByNumber.get(dialed);
    if (target) {
      s.main = newLeg({ ...common, direction: 'internal', chargeClass: 'internal', toNumber: target.number, toExtension: target.number });
      s.presentedNumber = accountCallerId(t, ext.callerIdNumber);
      const next = await ringExtension(ctx, s, target);
      if (next) await routeTo(ctx, s, next);
      if (!s.connected && !s.answered) reason = REASON[s.ringOutcome ?? 'no_answer'] ?? 'normal';
      return;
    }

    const e164 = normalizeDialed(dialed);
    if (!e164) {
      s.log.info({ dialed }, 'not an extension or a valid number');
      s.main = newLeg({ ...common, direction: 'outgoing', chargeClass: 'us', toNumber: dialed, outcome: 'failed' });
      reason = 'unallocated';
      return;
    }

    const callerId = accountCallerId(t, ext.callerIdNumber);
    const cls = classifyE164(e164);
    s.presentedNumber = callerId;
    s.main = newLeg({ ...common, direction: 'outgoing', chargeClass: cls.region, toNumber: e164, did: callerId, fromNumber: callerId ?? ext.number });
    const plan = await planPstnLeg(ctx, t, e164, callerId);
    if (!plan.ok) {
      s.log.info({ e164, reason: plan.reason }, 'outgoing call blocked');
      s.main.outcome = plan.reason === 'no_caller_id' ? 'failed' : 'blocked';
      metrics.blockedCalls.inc();
      reason = plan.reason === 'no_caller_id' ? 'failure' : 'rejected';
      return;
    }
    const r = await ringTargets(ctx, s, [{ kind: 'external', number: e164, extension: null }], 120, { externalIsMain: true });
    if (r.winner) {
      await connect(ctx, s, r.winner);
      return;
    }
    s.ringOutcome = r.outcome;
    s.main.outcome ??= r.outcome;
    reason = REASON[r.outcome] ?? 'failure';
  } catch (err) {
    if (!(err instanceof HangupError)) {
      s.log.error({ err }, 'device call flow failed');
      if (s.main) s.main.outcome ??= 'failed';
      reason = 'failure';
    }
  } finally {
    await s.hangupPrimary(ctx.ari, reason).catch(() => {});
  }
}
