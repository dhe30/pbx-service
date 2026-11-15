import { randomUUID } from 'node:crypto';
import { onChannel, onRecordingDone, type Subscription } from './ari/events.js';
import type { AriEvent } from './ari/types.js';
import type { Ctx } from './ctx.js';
import { playOnce } from './playback.js';
import type { CallSession } from './session.js';

// Leaving a voicemail: "Callers hear the greeting and leave a message." Implemented here, not with
// app_voicemail, so messages go to the object store and Postgres instead of a pbx node's disk.
//
// Callers may put the call on hold in the middle of the message (re-INVITE a=sendonly). A held
// caller sends no audio, and Asterisk ends a recording after 4 s without any frame ("No audio
// available"), reporting it like a normal end. Following that with goodbye + hangup cut off ~5% of
// the course's voicemails on 2026-11-15 (28 of 29 cut-offs came 4.01 s after a caller hold; the
// callers came back 0.4-16 s later). So hold is tracked on the caller's channel, and a recording
// that ends while the caller is held continues into the same file once they come back (no second
// beep), waiting at most VOICEMAIL_HOLD_WAIT_SEC. Hold time doesn't count toward VOICEMAIL_MAX_SEC.

const DEFAULT_GREETING = 'sound:vm-intro'; // "Please leave your message after the tone..."
const GOODBYE = 'sound:vm-goodbye';
const MAX_SILENCE_SEC = 5;

type HoldEvent = Extract<AriEvent, { type: 'ChannelHold' | 'ChannelUnhold' }>;

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

  // From before the greeting: a caller may hold while it plays.
  const hold = new HoldState(ctx.bus.subscribe(onChannel(s.primary, 'ChannelHold', 'ChannelUnhold')));
  try {
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
    await record(ctx, s, name, hold);
  } finally {
    hold.close();
  }

  if (!s.hungUp) await playOnce(ctx, s, GOODBYE).catch(() => {});
}

/** Records the message into `name`, across caller holds; hands the file to the uploader. */
async function record(ctx: Ctx, s: CallSession, name: string, hold: HoldState): Promise<void> {
  const done = ctx.bus.subscribe(onRecordingDone(name));
  let recordedSec = 0;
  let segments = 0;
  let saved = false;
  try {
    for (;;) {
      const resuming = segments > 0;
      const startedAt = Date.now();
      try {
        await ctx.ari.recordChannel(s.primary, {
          name,
          maxDurationSeconds: Math.max(1, Math.ceil(ctx.cfg.VOICEMAIL_MAX_SEC - recordedSec)),
          maxSilenceSeconds: MAX_SILENCE_SEC,
          beep: !resuming,
          terminateOn: '#',
          ...(resuming && { ifExists: 'append' as const }),
        });
      } catch (err) {
        if (resuming) {
          // Keep what was recorded before the hold rather than lose the whole message.
          s.log.warn({ err, name }, 'voicemail: could not resume after hold; saving what we have');
          break;
        }
        await ctx.uploader.abandon(name);
        s.check(); // caller already gone -> HangupError, otherwise a real failure
        throw err;
      }
      segments++;
      s.log.info({ name, resumed: resuming }, resuming ? 'voicemail: recording resumed after hold' : 'voicemail: recording');

      // Deliberately NOT tied to the caller's hangup signal: most callers hang up to end the
      // message, and Asterisk still finalizes the file and sends RecordingFinished.
      const ev = await done.next({ timeoutMs: (ctx.cfg.VOICEMAIL_MAX_SEC + 15) * 1000 });
      if (!ev) {
        s.log.warn({ name }, 'voicemail: no recording event; leaving to the sweep');
        break;
      }
      saved = true;
      recordedSec += (Date.now() - startedAt) / 1000;
      if (s.hungUp || ev.type === 'RecordingFailed' || recordedSec >= ctx.cfg.VOICEMAIL_MAX_SEC) break;
      if (!hold.held()) break; // a normal end: silence, '#' or max length

      s.log.info({ name }, 'voicemail: caller on hold; waiting to resume');
      if (!(await hold.waitForUnhold(ctx.cfg.VOICEMAIL_HOLD_WAIT_SEC * 1000, s.signal))) break;
    }
  } finally {
    done.close();
    if (saved) await ctx.uploader.finish(name); // uploader drops it if empty/too short
  }
}

/** Whether the caller's channel is on hold, from its ChannelHold / ChannelUnhold events. */
class HoldState {
  private onHold = false;

  constructor(private readonly sub: Subscription<HoldEvent>) {}

  /** Applies every event delivered so far and reports the current state. */
  held(): boolean {
    for (let ev = this.sub.takeQueued(); ev; ev = this.sub.takeQueued()) this.onHold = ev.type === 'ChannelHold';
    return this.onHold;
  }

  /** True once the caller is off hold; false on timeout or hangup. */
  async waitForUnhold(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.held()) {
      const ev = await this.sub.next({ timeoutMs: deadline - Date.now(), signal }).catch(() => null);
      if (!ev) return false;
      this.onHold = ev.type === 'ChannelHold';
    }
    return true;
  }

  close(): void {
    this.sub.close();
  }
}
