import { randomUUID } from 'node:crypto';
import { chKey, onRecordingDone, onWatched, type Subscription } from './ari/events.js';
import type { AriEvent, ChannelTransfer } from './ari/types.js';
import type { Ctx } from './ctx.js';
import { metrics } from './metrics.js';
import type { CallSession } from './session.js';

// A connected call: two parties in one Asterisk bridge, driven until it ends.
//
// Hold (spec §3 "Hold and transfer"): a phone holds with a re-INVITE (a=sendonly). Asterisk raises
// ChannelHold on THAT channel; we play music on hold to the OTHER party until ChannelUnhold.
// Either side may hold (staff answering a customer, or a phone that placed an outgoing call).
// Asterisk would pass hold on by itself only in a 2-party bridge; a recorded call has a third
// member (the recorder) and a softmix bridge, which drops hold frames, so we always do it here.
//
// Transfer: every party gets PJSIP_TRANSFER_HANDLING()=ari-only, so a REFER from a phone becomes a
// ChannelTransfer event instead of Asterisk acting on its own (Asterisk 22.1+). [VERIFY on VM]
//  - Blind (REFER to a number): we accept, drop the transferring phone, and the call flow routes
//    the remaining party to the target (extension number or external number).
//  - Attended (REFER with Replaces, after the phone held this call and called the target): Asterisk
//    resolves Replaces to our channel of the consult call. We move the consult call's other party
//    into THIS bridge and drop both of the transferring phone's legs. Needs both calls on the same
//    Asterisk: Kamailio keeps all calls of an account on one pbx node (tenant hash, B5).

export type ConversationEnd =
  | { reason: 'hangup'; by: string | null }
  /** Blind transfer: route `remaining` to `target` (a dial string: extension or number). */
  | { reason: 'blind_transfer'; remaining: string; target: string }
  /** Our other party was moved into another conversation (we were the consult call). */
  | { reason: 'released' };

interface ReleaseCommand {
  type: '_Release';
  channelId: string;
  done: () => void;
}

export interface ConversationOptions {
  record: boolean;
  mohClass: string;
}

export class Conversation {
  readonly bridgeId = randomUUID();
  private parties: string[];
  /** Party -> it currently has the call on hold (so the other hears MOH). */
  private readonly holding = new Set<string>();
  private readonly moh = new Set<string>();
  private readonly released = new Set<string>();
  private sub: Subscription<AriEvent> | null = null;
  private recording: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly s: CallSession,
    a: string,
    b: string,
    private readonly opts: ConversationOptions,
  ) {
    this.parties = [a, b];
  }

  other(channelId: string): string | null {
    return this.parties.find((p) => p !== channelId) ?? null;
  }

  has(channelId: string): boolean {
    return this.parties.includes(channelId);
  }

  /** Bridge both parties and drive the call until it ends. */
  async run(): Promise<ConversationEnd> {
    const { ctx, s } = this;
    const sub = ctx.bus.subscribe(onWatched('StasisEnd', 'ChannelDestroyed', 'ChannelHangupRequest', 'ChannelHold', 'ChannelUnhold', 'ChannelTransfer'));
    this.sub = sub as Subscription<AriEvent>;
    for (const p of this.parties) {
      sub.watch(chKey(p));
      ctx.conversations.set(p, this);
    }
    let end: ConversationEnd = { reason: 'hangup', by: null };
    try {
      await ctx.ari.createBridge(this.bridgeId);
      await ctx.ari.addToBridge(this.bridgeId, this.parties);
      await Promise.all(this.parties.map((p) => this.enableAriTransfer(p)));
      if (this.opts.record) await this.startRecording();

      for (;;) {
        const ev = (await sub.next()) as AriEvent | ReleaseCommand | null;
        if (!ev) break;
        if (ev.type === '_Release') {
          await this.release(ev.channelId);
          ev.done();
          end = { reason: 'released' };
          break;
        }
        const ch = 'channel' in ev ? ev.channel.id : ev.type === 'ChannelTransfer' ? ev.referred_by.source_channel.id : null;
        if (!ch || !this.parties.includes(ch)) continue;
        if (ev.type === 'ChannelHold' || ev.type === 'ChannelUnhold') {
          await this.setHold(ch, ev.type === 'ChannelHold');
          continue;
        }
        if (ev.type === 'ChannelTransfer') {
          const r = await this.transfer(ev);
          if (r) {
            end = r;
            break;
          }
          continue;
        }
        // StasisEnd / ChannelHangupRequest / ChannelDestroyed of a party: the conversation is over.
        end = { reason: 'hangup', by: ch };
        break;
      }
    } finally {
      sub.close();
      this.sub = null;
      for (const p of this.parties) if (ctx.conversations.get(p) === this) ctx.conversations.delete(p);
      for (const p of [...this.holding]) this.holding.delete(p);
      if (this.recording) await this.finishRecording(this.recording);
      const keep = end.reason === 'blind_transfer' ? end.remaining : null;
      for (const p of this.parties) {
        if (p === keep || this.released.has(p)) continue;
        await ctx.ari.hangupQuietly(p).catch(() => {});
      }
      if (keep) {
        await ctx.ari.stopMoh(keep).catch(() => {});
        await ctx.ari.removeFromBridge(this.bridgeId, [keep]).catch(() => {});
      }
      await ctx.ari.destroyBridge(this.bridgeId).catch(() => {});
    }
    return end;
  }

  /**
   * Called by ANOTHER conversation during an attended transfer: hand `channelId` over (stop
   * driving it, don't hang it up) and end this conversation (the transferring phone's leg here is
   * hung up). Resolves once the channel is out of our bridge.
   */
  releaseParty(channelId: string): Promise<void> {
    return new Promise((done) => {
      const cmd: ReleaseCommand = { type: '_Release', channelId, done };
      if (this.sub) (this.sub as unknown as { push(e: unknown): void }).push(cmd);
      else done();
    });
  }

  private async release(channelId: string): Promise<void> {
    this.released.add(channelId);
    await this.ctx.ari.stopMoh(channelId).catch(() => {});
    await this.ctx.ari.removeFromBridge(this.bridgeId, [channelId]).catch(() => {});
    if (this.ctx.conversations.get(channelId) === this) this.ctx.conversations.delete(channelId);
  }

  private async enableAriTransfer(channelId: string): Promise<void> {
    await this.ctx.ari
      .setChannelVar(channelId, 'PJSIP_TRANSFER_HANDLING()', 'ari-only')
      .catch((err) => this.s.log.warn({ err, channelId }, 'could not enable ARI transfer handling'));
  }

  private async setHold(holder: string, held: boolean): Promise<void> {
    const other = this.other(holder);
    if (!other) return;
    if (held === this.holding.has(holder)) return;
    if (held) {
      this.holding.add(holder);
      metrics.callsOnHold.inc();
      metrics.holdsTotal.inc();
      this.s.log.info({ holder }, 'hold: music on hold to the other party');
      this.moh.add(other);
      await this.ctx.ari.startMoh(other, this.opts.mohClass).catch((err) => this.s.log.warn({ err }, 'could not start music on hold'));
    } else {
      this.holding.delete(holder);
      metrics.callsOnHold.dec();
      this.s.log.info({ holder }, 'unhold');
      this.moh.delete(other);
      await this.ctx.ari.stopMoh(other).catch((err) => this.s.log.warn({ err }, 'could not stop music on hold'));
    }
  }

  private clearHoldOf(channelId: string): void {
    if (this.holding.delete(channelId)) metrics.callsOnHold.dec();
  }

  /** Handle a REFER from one of our parties. Returns how the conversation ends, or null to continue. */
  private async transfer(ev: ChannelTransfer): Promise<ConversationEnd | null> {
    const { ctx, s } = this;
    const transferer = ev.referred_by.source_channel.id;
    const remaining = this.other(transferer);
    if (!remaining) return null;
    const replacesCh = ev.refer_to.destination_channel?.id;
    const consult = replacesCh ? ctx.conversations.get(replacesCh) : undefined;

    if (replacesCh && consult && consult !== this) {
      // ---- attended: the consult call's other party joins our remaining party ----
      const target = consult.other(replacesCh);
      if (!target) return null;
      metrics.transfersTotal.inc({ kind: 'attended' });
      s.log.info({ transferer, remaining, target }, 'attended transfer');
      await consult.releaseParty(target); // consult conversation ends, hangs up the phone's consult leg
      this.clearHoldOf(transferer);
      // Rebind first so the transferring phone hanging up doesn't end this call flow.
      if (s.primary === transferer) s.rebind(remaining);
      this.parties = [remaining, target];
      ctx.conversations.set(target, this);
      if (ctx.conversations.get(transferer) === this) ctx.conversations.delete(transferer);
      this.sub?.unwatch(chKey(transferer));
      this.sub?.watch(chKey(target));
      await ctx.ari.addToBridge(this.bridgeId, [target]);
      await this.enableAriTransfer(target);
      for (const p of [remaining, target]) {
        if (this.moh.delete(p)) await ctx.ari.stopMoh(p).catch(() => {});
      }
      await ctx.ari.transferProgress(transferer, 'channel_answered').catch(() => {});
      await ctx.ari.removeFromBridge(this.bridgeId, [transferer]).catch(() => {});
      await ctx.ari.hangupQuietly(transferer).catch(() => {});
      return null; // keep driving the joined call
    }

    // ---- blind (or attended whose consult call isn't on this node: treat its target as blind) ----
    const target = referTarget(ev);
    if (!target) {
      await ctx.ari.transferProgress(transferer, 'channel_declined').catch(() => {});
      return null;
    }
    metrics.transfersTotal.inc({ kind: 'blind' });
    s.log.info({ transferer, remaining, target }, 'blind transfer');
    this.clearHoldOf(transferer);
    if (s.primary === transferer) s.rebind(remaining);
    if (ctx.conversations.get(remaining) === this) ctx.conversations.delete(remaining);
    await ctx.ari.transferProgress(transferer, 'channel_answered').catch(() => {});
    return { reason: 'blind_transfer', remaining, target };
  }

  private async startRecording(): Promise<void> {
    const { ctx, s } = this;
    if (!s.tenant) return;
    const mediaId = randomUUID();
    const name = `rec-${mediaId}`;
    await ctx.uploader.begin(name, { kind: 'recording', mediaId, tenantId: s.tenant.id, callId: s.callId, mailboxId: null });
    try {
      await ctx.ari.recordBridge(this.bridgeId, name);
      this.recording = name;
    } catch (err) {
      s.log.error({ err }, 'could not start call recording');
      await ctx.uploader.abandon(name);
    }
  }

  private async finishRecording(name: string): Promise<void> {
    const done = this.ctx.bus.subscribe(onRecordingDone(name));
    try {
      await this.ctx.ari.stopRecording(name).catch(() => {});
      const ev = await done.next({ timeoutMs: 5000 });
      // Without the event the file may still be open; the uploader's stale-file sweep handles it.
      if (ev) await this.ctx.uploader.finish(name);
      else this.s.log.warn({ name }, 'no RecordingFinished event; leaving recording to the sweep');
    } finally {
      done.close();
    }
  }
}

/** The dial string a REFER points at: user part of the Refer-To URI, without parameters. */
export function referTarget(ev: ChannelTransfer): string | null {
  const raw = ev.refer_to.requested_destination?.destination?.trim();
  if (!raw) return null;
  let s = raw.replace(/^<|>$/g, '');
  const m = /^sips?:([^@;?>]+)/i.exec(s);
  if (m) s = m[1]!;
  s = decodeURIComponent(s.split(/[;?]/)[0]!);
  return s || null;
}
