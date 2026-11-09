import type { AriEvent } from './ari/types.js';
import { outcomeFromCause, type CallSession, type LegDraft } from './session.js';

// Keeps CDR leg drafts in sync with their channels: answer time on StasisStart (ARI originate
// channels enter Stasis when answered), end time + cause on ChannelDestroyed. A session waits for
// all its live legs before writing CDRs, so a leg handed to another call (attended transfer) is
// still billed to the call that placed it, until it really ends.

interface Tracked {
  draft: LegDraft;
  session: CallSession;
  done: () => void;
}

export class LegTracker {
  private readonly legs = new Map<string, Tracked>();

  track(channelId: string, draft: LegDraft, session: CallSession): void {
    let done!: () => void;
    const p = new Promise<void>((r) => (done = r));
    session.liveLegs.set(channelId, p);
    this.legs.set(channelId, { draft, session, done });
  }

  isTracked(channelId: string): boolean {
    return this.legs.has(channelId);
  }

  onEvent(ev: AriEvent): void {
    if (!('channel' in ev)) return;
    const t = this.legs.get(ev.channel.id);
    if (!t) return;
    if (ev.type === 'StasisStart') {
      t.draft.answeredAt ??= new Date(ev.timestamp || Date.now());
    } else if (ev.type === 'ChannelDestroyed') {
      t.draft.endedAt ??= new Date(ev.timestamp || Date.now());
      t.draft.hangupCause ??= ev.cause;
      t.draft.outcome ??= t.draft.answeredAt ? 'answered' : outcomeFromCause(ev.cause);
      this.legs.delete(ev.channel.id);
      t.session.liveLegs.delete(ev.channel.id);
      t.done();
    }
  }

  get size(): number {
    return this.legs.size;
  }
}
