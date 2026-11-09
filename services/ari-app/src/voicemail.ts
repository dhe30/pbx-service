import { randomUUID } from 'node:crypto';
import { onRecordingDone } from './ari/events.js';
import type { Ctx } from './ctx.js';
import { playOnce } from './playback.js';
import type { CallSession } from './session.js';

// Leaving a voicemail: "Callers hear the greeting and leave a message." Implemented here, not with
// app_voicemail, so messages go to the object store and Postgres instead of a pbx node's disk.

const DEFAULT_GREETING = 'sound:vm-intro'; // "Please leave your message after the tone..."
const GOODBYE = 'sound:vm-goodbye';
const MAX_SILENCE_SEC = 5;

export async function leaveVoicemail(ctx: Ctx, s: CallSession, mailboxId: string): Promise<void> {
  const t = s.tenant;
  if (!t) return;
  const mailbox = t.mailboxes.get(mailboxId);
  if (!mailbox) {
    s.log.warn({ mailboxId }, 'voicemail: mailbox not found');
    return;
  }
  await s.ensureAnswered(ctx.ari);
  if (s.main) s.main.voicemail = true;

  const greeting = mailbox.greetingMediaId ? await ctx.media.soundUri(t.id, mailbox.greetingMediaId) : null;
  await playOnce(ctx, s, greeting ?? DEFAULT_GREETING);
  s.check();

  const mediaId = randomUUID();
  const name = `vm-${mediaId}`;
  await ctx.uploader.begin(name, {
    kind: 'voicemail',
    mediaId,
    tenantId: t.id,
    callId: s.callId,
    mailboxId,
    callerNumber: s.main?.fromNumber ?? s.callerNumber,
  });
  const done = ctx.bus.subscribe(onRecordingDone(name));
  try {
    try {
      await ctx.ari.recordChannel(s.primary, {
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
