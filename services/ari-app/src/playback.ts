import { randomUUID } from 'node:crypto';
import type { AriEvent, ChannelDtmfReceived, PlaybackFinished } from './ari/types.js';
import { onPlaybackFinished } from './ari/events.js';
import type { Ctx } from './ctx.js';
import type { CallSession } from './session.js';

// Safety net: no prompt we play is anywhere near this long.
const MAX_PROMPT_MS = 5 * 60_000;

/** Play one prompt to the caller and wait for it to finish. Throws HangupError if the caller leaves. */
export async function playOnce(ctx: Ctx, s: CallSession, media: string): Promise<void> {
  const playbackId = randomUUID();
  const done = ctx.bus.subscribe(onPlaybackFinished(playbackId));
  try {
    await ctx.ari.play(s.channelId, media, playbackId);
    await done.next({ signal: s.signal, timeoutMs: MAX_PROMPT_MS });
  } finally {
    done.close();
  }
}

/**
 * Play prompts (DTMF interrupts them), then wait up to `timeoutMs` for a digit.
 * Returns the first digit pressed, or null if none.
 */
export async function playAndCollect(ctx: Ctx, s: CallSession, media: string[], timeoutMs: number): Promise<string | null> {
  // One subscription for both digits and "prompt finished" so nothing is missed between awaits.
  const target = `channel:${s.channelId}`;
  const sub = ctx.bus.subscribe(
    (e: AriEvent): e is ChannelDtmfReceived | PlaybackFinished =>
      (e.type === 'ChannelDtmfReceived' && e.channel.id === s.channelId) ||
      (e.type === 'PlaybackFinished' && e.playback.target_uri === target),
  );
  try {
    for (const m of media) {
      const playbackId = randomUUID();
      await ctx.ari.play(s.channelId, m, playbackId);
      for (;;) {
        const ev = await sub.next({ signal: s.signal, timeoutMs: MAX_PROMPT_MS });
        if (!ev) break;
        if (ev.type === 'ChannelDtmfReceived') {
          await ctx.ari.stopPlayback(playbackId);
          return ev.digit;
        }
        if (ev.playback.id === playbackId) break; // this prompt is done; play the next
      }
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ev = await sub.next({ signal: s.signal, timeoutMs: deadline - Date.now() });
      if (!ev) return null;
      if (ev.type === 'ChannelDtmfReceived') return ev.digit;
      // a late PlaybackFinished from a stopped prompt: ignore
    }
  } finally {
    sub.close();
  }
}
