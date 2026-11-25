import type { AriEvent, Channel } from './ari/types.js';
import type { Ctx } from './ctx.js';
import { handleDeviceCall } from './device.js';
import { handleCarrierCall } from './inbound.js';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';
import { CallSession } from './session.js';

// Routes ARI events. A new call enters Stasis from the dialplan with
//   Stasis(pbx-app, <source>, <sip user>)
// where Kamailio set the source header: "carrier" (PSTN call to a DID) or "device" (a call placed by
// one of our phones, X-PBX-User = its SIP username). Legs we originate enter Stasis with
// "outbound:<caller channel>" when they answer, call recordings' snoop channels with "snoop".

export class PbxApp {
  /** Session by its primary channel id (the channel whose hangup ends the flow). */
  private readonly sessions = new Map<string, CallSession>();
  private readonly flows = new Set<Promise<void>>();

  constructor(
    private readonly ctx: Ctx,
    private readonly log: Logger,
  ) {}

  get activeCalls(): number {
    return this.flows.size;
  }

  onEvent(ev: AriEvent): void {
    this.ctx.legs.onEvent(ev);
    this.ctx.holds.onEvent(ev);
    const taken = this.ctx.bus.dispatch(ev);
    switch (ev.type) {
      case 'StasisStart': {
        // Stasis(pbx-app,<source>,<SIP user>,<SIP Call-ID>) (extensions.conf). The Call-ID is last
        // and re-joined in case it contains a comma; older dialplans pass only two arguments.
        const [src = '', user = '', ...callIdParts] = ev.args;
        if (src === 'carrier' || src === 'inbound' || src === 'device') {
          this.start(ev.channel, src === 'device' ? 'device' : 'carrier', user, callIdParts.join(','));
        } else if (src.startsWith('outbound:') && !taken) {
          // A leg answered after we stopped waiting for it (caller left, or someone else won).
          this.log.info({ ch: ev.channel.id }, 'late answer on abandoned leg; hanging up');
          void this.ctx.ari.hangupQuietly(ev.channel.id).catch(() => {});
        } else if (src === 'snoop') {
          // A call recording's snoop channel (conversation.ts): its conversation drives it.
        } else if (!src.startsWith('outbound:')) {
          this.log.warn({ args: ev.args }, 'unknown Stasis source; hanging up');
          void this.ctx.ari.hangupQuietly(ev.channel.id, 'failure').catch(() => {});
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

  private start(ch: Channel, kind: 'carrier' | 'device', sipUser: string, sipCallId: string): void {
    // `sip` (the SIP Call-ID) is on every line of the call: the same id the edges' SIP captures,
    // rtpengine and the per-call audio records use, so one call can be followed end to end.
    const bindings = sipCallId ? { ch: ch.id, kind, sip: sipCallId } : { ch: ch.id, kind };
    const s = new CallSession(
      ch.id,
      ch.caller.number,
      ch.dialplan.exten,
      this.log.child(bindings),
      (from, to, sess) => {
        if (this.sessions.get(from) === sess) this.sessions.delete(from);
        this.sessions.set(to, sess);
      },
      sipCallId,
    );
    this.sessions.set(ch.id, s);
    metrics.activeCalls.inc();
    const flow = (kind === 'device' ? handleDeviceCall(this.ctx, s, sipUser) : handleCarrierCall(this.ctx, s))
      .then(() => this.finish(s))
      .catch((err) => s.log.error({ err }, 'call flow crashed'))
      .finally(() => {
        for (const [k, v] of this.sessions) if (v === s) this.sessions.delete(k);
        metrics.activeCalls.dec();
        this.flows.delete(flow);
      });
    this.flows.add(flow);
  }

  private async finish(s: CallSession): Promise<void> {
    const cdrs = await s.finish({ pbxNode: this.ctx.cfg.PBX_NODE });
    for (const c of cdrs) {
      metrics.callsTotal.inc({ direction: c.direction, outcome: c.outcome });
      await this.ctx.cdr.submit(c).catch((err) => s.log.error({ err, cdr: c }, 'could not spool CDR'));
    }
    // The whole route trace rides on this one line (src/trace.ts).
    s.log.info({ outcome: s.main?.outcome, legs: cdrs.length, trace: s.trace.toJSON() }, 'call ended');
  }

  /** Wait for every running call flow (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.flows.size > 0) await Promise.allSettled([...this.flows]);
  }

  /**
   * Hang up channels left in our Stasis app by a previous (crashed) process. Nobody is driving
   * them, so the callers would just hear silence. Run before handling any new events.
   */
  async hangupOrphans(keep: Set<string>, listChannels: () => Promise<Channel[]>): Promise<void> {
    const channels = await listChannels();
    const orphans = channels.filter(
      (c) => !keep.has(c.id) && c.dialplan.app_name === 'Stasis' && (c.dialplan.app_data ?? '').startsWith(this.ctx.cfg.ARI_APP),
    );
    for (const c of orphans) {
      this.log.warn({ ch: c.id }, 'hanging up orphaned channel from previous run');
      await this.ctx.ari.hangupQuietly(c.id).catch(() => {});
    }
  }
}
