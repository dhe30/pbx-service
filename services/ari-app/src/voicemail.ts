import { randomUUID } from 'node:crypto';
import { onRecordingDone } from './ari/events.js';
import type { Ctx } from './ctx.js';
import { playOnce } from './playback.js';
import type { CallSession } from './session.js';

// Voicemail is implemented here, not with app_voicemail, so messages go to the object store and
// Postgres instead of a pbx node's disk (CLAUDE.md §4.3 #6).

const DEFAULT_GREETING = 'sound:vm-intro'; // "Please leave your message after the tone..."
const GOODBYE = 'sound:vm-goodbye';
const MAX_SILENCE_SEC = 5;

export async function voicemail(ctx: Ctx, s: CallSession, mailboxId: string): Promise<void> {
  if (!s.tenantId) return;
  const mailbox = await ctx.repo.getMailbox(s.tenantId, mailboxId);
  if (!mailbox) {
    s.log.warn({ mailboxId }, 'voicemail: mailbox not found');
    return;
  }

  const greeting = mailbox.greetingMediaId ? await ctx.greetings.soundUri(s.tenantId, mailbox.greetingMediaId) : null;
  await playOnce(ctx, s, greeting ?? DEFAULT_GREETING);
  s.check();

  const mediaId = randomUUID();
  const name = `vm-${mediaId}`;
  await ctx.uploader.begin(name, { kind: 'voicemail', mediaId, tenantId: s.tenantId, callId: s.callId, mailboxId });
  const done = ctx.bus.subscribe(onRecordingDone(name));
  try {
    try {
      await ctx.ari.recordChannel(s.channelId, {
        name,
        maxDurationSeconds: ctx.cfg.VOICEMAIL_MAX_SEC,
        maxSilenceSeconds: MAX_SILENCE_SEC,
        beep: true,
        terminateOn: '#',
      });
    } catch (err) {
      await ctx.uploader.abandon(name);
      s.check(); // caller already gone -> HangupError, otherwise a real failure
      throw err;
    }
    s.disposition = 'voicemail';
    s.log.info({ name }, 'voicemail: recording');

    // Deliberately NOT tied to the caller's hangup signal: most callers hang up to end the
    // message, and Asterisk still finalizes the file and sends RecordingFinished.
    const ev = await done.next({ timeoutMs: (ctx.cfg.VOICEMAIL_MAX_SEC + 15) * 1000 });
    if (ev) await ctx.uploader.finish(name); // uploader drops it if empty/too short
    else s.log.warn({ name }, 'voicemail: no recording event; leaving to the sweep');
  } finally {
    done.close();
  }

  if (!s.hungUp) await playOnce(ctx, s, GOODBYE).catch(() => {});
}
