import type { AriEvent, Channel } from './ari/types.js';
import type { Ctx } from './ctx.js';
import { handleInbound } from './inbound.js';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';
import { CallSession } from './session.js';

/** Routes ARI events: new inbound calls start a flow; everything else goes to waiting flows. */
export class PbxApp {
  private readonly sessions = new Map<string, CallSession>();

  constructor(
    private readonly ctx: Ctx,
    private readonly log: Logger,
  ) {}

  get activeCalls(): number {
    return this.sessions.size;
  }

  onEvent(ev: AriEvent): void {
    const taken = this.ctx.bus.dispatch(ev);
    switch (ev.type) {
      case 'StasisStart': {
        const arg = ev.args[0] ?? '';
        if (arg === 'inbound') {
          this.startInbound(ev.channel);
        } else if (arg.startsWith('outbound:') && !taken) {
          // A staff leg answered after we stopped waiting for it (caller left, or someone else won).
          this.log.info({ ch: ev.channel.id }, 'late answer on abandoned leg; hanging up');
          void this.ctx.ari.hangupQuietly(ev.channel.id).catch(() => {});
        }
        break;
      }
      case 'StasisEnd':
      case 'ChannelHangupRequest':
      case 'ChannelDestroyed':
        this.sessions.get(ev.channel.id)?.markHungUp();
        break;
    }
  }

  private startInbound(ch: Channel): void {
    const s = new CallSession(ch.id, ch.caller.number, ch.dialplan.exten, this.log.child({ ch: ch.id }));
    this.sessions.set(ch.id, s);
    metrics.activeCalls.set(this.sessions.size);
    void handleInbound(this.ctx, s).finally(() => {
      this.sessions.delete(ch.id);
      metrics.activeCalls.set(this.sessions.size);
    });
  }

  /**
   * Hang up channels left in our Stasis app by a previous (crashed) process. Nobody is driving
   * them, so the callers would just hear silence. Run before handling any new events.
   */
  async hangupOrphans(keep: Set<string>): Promise<void> {
    const channels = await this.ctx.ari.listChannels();
    const orphans = channels.filter(
      (c) =>
        !keep.has(c.id) &&
        c.dialplan.app_name === 'Stasis' &&
        (c.dialplan.app_data ?? '').startsWith(this.ctx.cfg.ARI_APP),
    );
    for (const c of orphans) {
      this.log.warn({ ch: c.id }, 'hanging up orphaned channel from previous run');
      await this.ctx.ari.hangupQuietly(c.id).catch(() => {});
    }
  }
}
