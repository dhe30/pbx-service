import type { AriEvent } from './ari/types.js';

// Which channels are on hold right now, from every ChannelHold / ChannelUnhold the node sees.
//
// A Conversation only subscribes to hold events once it bridges its two parties. A caller can hold
// earlier: in the IVR or while an extension (or a blind-transfer target) is still ringing. The
// course simulator does that, and the extension then answered into silence: no music on hold, and
// a held caller sends no audio (Hussain Notary 2026-11-17 08:10 and 02:53 UTC,
// docs/incidents/2026-11-17-hold-before-answer.md). Conversation.run() asks this tracker for the
// state at bridge time; later changes reach it as events, as before.
//
// Fed by PbxApp.onEvent before the bus dispatches, so the state is current when a flow sees an event.
export class HoldState {
  private readonly held = new Set<string>();

  onEvent(ev: AriEvent): void {
    if (!('channel' in ev)) return;
    switch (ev.type) {
      case 'ChannelHold':
        this.held.add(ev.channel.id);
        break;
      case 'ChannelUnhold':
      case 'ChannelDestroyed':
        this.held.delete(ev.channel.id);
        break;
    }
  }

  isHeld(channelId: string): boolean {
    return this.held.has(channelId);
  }

  /** Channels currently tracked (tests: must return to 0 when calls end). */
  get size(): number {
    return this.held.size;
  }
}
