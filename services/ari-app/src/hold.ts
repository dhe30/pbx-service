import type { AriClient } from './ari/client.js';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';

// Hold, as seen by the ARI app (docs/hold-call-waiting.md).
//
// The agent's phone holds with a re-INVITE (a=sendonly). Asterisk then raises ChannelHold on the
// AGENT channel; our job is to play music on hold to the CALLER until ChannelUnhold.
// Asterisk would pass the hold on by itself only in a 2-party bridge; a recorded call has a third
// member (the recorder) and a softmix bridge, which drops hold frames, so we always do it here.
// A second MOH start/stop for the same channel (ours + Asterisk's) is harmless.
//
// MOH failures are logged, never thrown: a hold must not drop the call (worst case the caller
// hears silence while held).

export class CallerHold {
  private held = false;

  constructor(
    private readonly ari: Pick<AriClient, 'startMoh' | 'stopMoh'>,
    private readonly callerChannelId: string,
    private readonly mohClass: string,
    private readonly log: Logger,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Apply the agent's hold state. Repeated events with the same state are ignored. */
  async set(held: boolean): Promise<void> {
    if (held === this.held) return;
    this.held = held;
    if (held) {
      metrics.callsOnHold.inc();
      metrics.holdsTotal.inc();
      this.log.info('agent hold: music on hold to caller');
      await this.ari
        .startMoh(this.callerChannelId, this.mohClass)
        .catch((err) => this.log.warn({ err }, 'could not start music on hold'));
    } else {
      metrics.callsOnHold.dec();
      this.log.info('agent unhold');
      await this.ari
        .stopMoh(this.callerChannelId)
        .catch((err) => this.log.warn({ err }, 'could not stop music on hold'));
    }
  }

  /** Call is over: MOH ends with the channel, only the gauge needs fixing. */
  end(): void {
    if (this.held) {
      this.held = false;
      metrics.callsOnHold.dec();
    }
  }
}
