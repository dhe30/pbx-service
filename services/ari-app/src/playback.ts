import { randomUUID } from 'node:crypto';
import { chKey, onPlaybackFinished, onWatched } from './ari/events.js';
import type { ChannelDtmfReceived, PlaybackFinished } from './ari/types.js';
import { ms, type Ctx } from './ctx.js';
import type { CallSession } from './session.js';

// Safety net: no prompt we play is anywhere near this long.
const MAX_PROMPT_MS = 5 * 60_000;

/** Play one prompt to the caller and wait for it to finish. Throws HangupError if the caller leaves. */
export async function playOnce(ctx: Ctx, s: CallSession, media: string): Promise<void> {
  const playbackId = randomUUID();
  const done = ctx.bus.subscribe(onPlaybackFinished(playbackId));
  try {
    await ctx.ari.play(s.primary, media, playbackId);
    await done.next({ signal: s.signal, timeoutMs: MAX_PROMPT_MS });
  } finally {
    done.close();
  }
}

/**
 * A digit reader for one channel: buffers every DTMF digit from creation until close(), so digits
 * typed quickly (e.g. "##" in voicemail, or a digit right as a prompt ends) are never lost.
 */
export class DigitReader {
  private readonly sub;

  constructor(
    private readonly ctx: Ctx,
    private readonly s: CallSession,
  ) {
    this.sub = ctx.bus.subscribe(onWatched('ChannelDtmfReceived', 'PlaybackFinished'));
    this.sub.watch(chKey(s.primary));
  }

  /**
   * Play prompts in order; a digit interrupts them and is returned. Then wait up to `waitSec` for
   * a digit. Returns null if none.
   */
  async prompt(media: string[], waitSec: number): Promise<string | null> {
    for (const m of media) {
      const playbackId = randomUUID();
      await this.ctx.ari.play(this.s.primary, m, playbackId);
      for (;;) {
        const ev = await this.sub.next({ signal: this.s.signal, timeoutMs: MAX_PROMPT_MS });
        if (!ev) break;
        if (ev.type === 'ChannelDtmfReceived') {
          await this.ctx.ari.stopPlayback(playbackId);
          return ev.digit;
        }
        if ((ev as PlaybackFinished).playback.id === playbackId) break; // prompt done: next one
      }
    }
    return this.digit(waitSec);
  }

  /** Next digit within `waitSec` (already-buffered digits return immediately), else null. */
  async digit(waitSec: number): Promise<string | null> {
    const deadline = Date.now() + ms(this.ctx, waitSec);
    for (;;) {
      const ev = await this.sub.next({ signal: this.s.signal, timeoutMs: deadline - Date.now() });
      if (!ev) return null;
      if (ev.type === 'ChannelDtmfReceived') return (ev as ChannelDtmfReceived).digit;
      // a late PlaybackFinished from a stopped prompt: ignore
    }
  }

  close(): void {
    this.sub.close();
  }
}

/** Play prompts (DTMF interrupts them), then wait up to `waitSec` for a digit. */
export async function playAndCollect(ctx: Ctx, s: CallSession, media: string[], waitSec: number): Promise<string | null> {
  const r = new DigitReader(ctx, s);
  try {
    return await r.prompt(media, waitSec);
  } finally {
    r.close();
  }
}
