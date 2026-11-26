import { randomUUID } from 'node:crypto';
import { chKey, onChannel, onRecordingDone, onWatched, type Subscription } from './ari/events.js';
import type { AriEvent, ChannelTransfer } from './ari/types.js';
import type { Ctx } from './ctx.js';
import { metrics } from './metrics.js';
import type { CallSession, Party } from './session.js';
import { PART_SLOTS } from './uploader.js';

// A connected call: two parties in one Asterisk bridge, driven until it ends.
//
// Hold (spec §3 "Hold and transfer"): a phone holds with a re-INVITE (a=sendonly). Asterisk raises
// ChannelHold on THAT channel; we play music on hold to the OTHER party until ChannelUnhold.
// Either side may hold (staff answering a customer, or a phone that placed an outgoing call).
// Asterisk would pass hold on by itself only in a 2-party bridge; recorded calls used to have a
// third member (the bridge recorder) and a softmix bridge, which drops hold frames, so we always
// do it here.
//
// Recording (add-on): each party gets a snoop channel recording what that party says (spy=in) into
// its own part (<name>-a, <name>-b); the uploader mixes the parts into one WAV (uploader.ts). NOT the
// bridge: bridge recording made every recorded call a 3-member softmix bridge, and softmix corrupted
// Asterisk's heap under load (abort in ast_slinfactory_feed <- softmix_bridge_write_voice on a
// recorded call, 2026-11-25). One snoop with spy=both on one party held only that party's own audio
// (live 2026-11-26), hence one per party. If a party leaves in an attended transfer, its part
// continues on the party that joins (appended, same file).
// A hold from BEFORE the bridge (IVR, extension still ringing) comes from ctx.holds (hold-state.ts).
//
// Transfer: every party gets PJSIP_TRANSFER_HANDLING()=ari-only, so a REFER from a phone becomes a
// ChannelTransfer event instead of Asterisk acting on its own (Asterisk 22.1+). [VERIFY on VM]
//  - Blind (REFER to a number): we accept, drop the transferring phone, and the call flow routes
//    the remaining party to the target (extension number or external number).
//  - Attended (REFER with Replaces, after the phone held this call and called the target): Asterisk
//    resolves Replaces to our channel of the consult call. We move the consult call's other party
//    into THIS bridge and drop both of the transferring phone's legs. Needs both calls on the same
//    Asterisk: Kamailio keeps all calls of an account on one pbx node (tenant hash, B5).
//    Neither call has to be one the phone placed: with call waiting both of the phone's legs are
//    legs we originated, and the party we take over is the OTHER call's primary (its caller).
//    That call's flow then ends without hanging it up (CallSession.primaryHandedOver).

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
  private rec: Recording | null = null;
  /** Who each party is (for the CDR row a transfer starts). */
  private readonly who = new Map<string, Party>();

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

  identify(channelId: string, party: Party): void {
    this.who.set(channelId, party);
  }

  /** The account this call belongs to (extension numbers are only unique within one account). */
  get tenantId(): string | null {
    return this.s.tenant?.id ?? null;
  }

  /** Extensions of the parties currently holding this call (their phone put it on hold). */
  holdingExtensions(): string[] {
    return [...this.holding].map((ch) => this.who.get(ch)?.extension).filter((e): e is string => !!e);
  }

  whoIs(channelId: string): Party | null {
    return this.who.get(channelId) ?? null;
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
      // A party may have held before we bridged (caller in the IVR or while the extension rang):
      // its ChannelHold came before our subscription. Apply that state now; holds and resumes from
      // here on arrive as events (already queued ones included), and setHold() ignores repeats.
      for (const p of this.parties) if (ctx.holds.isHeld(p)) await this.setHold(p, true);

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
      if (this.rec) await this.finishRecording(true);
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
    const { ctx, s } = this;
    this.released.add(channelId);
    if (channelId === s.primary) {
      // The party handed over is the channel our call flow routes (e.g. the caller of the second
      // call a phone answered, call waiting). Our flow must not hang it up when it ends, and our
      // main leg lasts until that channel really ends (incoming toll-free is billed per minute).
      s.primaryHandedOver = true;
      if (s.main && !s.main.endedAt && !ctx.legs.isTracked(channelId) && !ctx.legs.tracksDraft(s.main)) {
        ctx.legs.track(channelId, s.main, s);
      }
    }
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
      if (s.primary === transferer) {
        s.rebind(remaining);
        s.primaryParty = this.whoIs(remaining) ?? s.primaryIs;
      }
      this.parties = [remaining, target];
      const targetIs = consult.whoIs(target);
      if (targetIs) this.who.set(target, targetIs);
      // The target's own CDR row from now on (main row: who answered before the transfer). The
      // consult call keeps its own rows (the phone's call to the target, ended now).
      s.beginTransferLeg(new Date(), targetIs, true);
      ctx.conversations.set(target, this);
      if (ctx.conversations.get(transferer) === this) ctx.conversations.delete(transferer);
      this.sub?.unwatch(chKey(transferer));
      this.sub?.watch(chKey(target));
      // The transferring phone leaves and the music stops BEFORE the target joins: joining first
      // put the target in a 3-way bridge with the transferring phone (live 2026-11-24, Hussain
      // Notary: "225 heard the transferring extension for 3.0 s and the caller for 0.9 s").
      await ctx.ari.removeFromBridge(this.bridgeId, [transferer]).catch(() => {});
      for (const p of [remaining, target]) {
        if (this.moh.delete(p)) await ctx.ari.stopMoh(p).catch(() => {});
      }
      await ctx.ari.addToBridge(this.bridgeId, [target]);
      await this.enableAriTransfer(target);
      await ctx.ari.transferProgress(transferer, 'channel_answered').catch(() => {});
      await ctx.ari.hangupQuietly(transferer).catch(() => {});
      // The part that recorded the phone that just left continues on the party that joined.
      const part = this.rec?.parts.find((p) => p.target === transferer);
      if (this.rec && part) {
        const rec = this.rec;
        await this.stopPart(rec.name, part);
        rec.parts = rec.parts.filter((p) => p !== part);
        const moved = await this.startPart(rec.name, part.slot, target, true);
        if (moved) rec.parts.push(moved);
      }
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

  /** Record the call: one snoop per party, each into its own part of the same recording. */
  private async startRecording(): Promise<void> {
    const { ctx, s } = this;
    if (!s.tenant) return;
    const mediaId = randomUUID();
    const name = `rec-${mediaId}`;
    await ctx.uploader.begin(name, { kind: 'recording', mediaId, tenantId: s.tenant.id, callId: s.callId, mailboxId: null });
    const rec: Recording = { name, parts: [] };
    for (let i = 0; i < this.parties.length && i < PART_SLOTS.length; i++) {
      const part = await this.startPart(name, PART_SLOTS[i]!, this.parties[i]!, false);
      if (part) rec.parts.push(part);
    }
    if (rec.parts.length) this.rec = rec;
    else await ctx.uploader.abandon(name);
  }

  /**
   * Record what `target` says (snoop spy=in) into part `slot` of recording `name`. `append`: continue
   * that part (an attended transfer replaced the party it recorded). null when it could not start.
   */
  private async startPart(name: string, slot: string, target: string, append: boolean): Promise<RecordingPart | null> {
    const { ctx, s } = this;
    const partName = `${name}-${slot}`;
    const snoopId = randomUUID();
    // Both subscriptions before the actions: the snoop enters Stasis asynchronously, and the
    // recording ends by itself (RecordingFinished) if the watched party hangs up first.
    const started = ctx.bus.subscribe(onChannel(snoopId, 'StasisStart', 'ChannelDestroyed'));
    const done = ctx.bus.subscribe(onRecordingDone(partName));
    try {
      await ctx.ari.snoop(target, snoopId, 'in');
      const ev = await started.next({ timeoutMs: 3000 });
      if (ev?.type !== 'StasisStart') throw new Error(`snoop channel did not enter Stasis (${ev?.type ?? 'timeout'})`);
      await ctx.ari.recordChannel(snoopId, {
        name: partName,
        maxDurationSeconds: 0, // 0 = no limit
        maxSilenceSeconds: 0,
        beep: false,
        terminateOn: 'none',
        ifExists: append ? 'append' : 'overwrite',
      });
      return { slot, snoopId, target, done: done as Subscription<AriEvent> };
    } catch (err) {
      s.log.error({ err, target, slot }, 'could not start call recording');
      done.close();
      await ctx.ari.hangupQuietly(snoopId).catch(() => {});
      return null;
    } finally {
      started.close();
    }
  }

  /** Stop one part and its snoop channel (waits for Asterisk to close the file). */
  private async stopPart(name: string, p: RecordingPart): Promise<void> {
    try {
      await this.ctx.ari.stopRecording(`${name}-${p.slot}`).catch(() => {});
      const ev = await p.done.next({ timeoutMs: 5000 });
      await this.ctx.ari.hangupQuietly(p.snoopId).catch(() => {});
      // Without the event the file may still be open; the uploader's stale-file sweep handles it.
      if (!ev) this.s.log.warn({ name, slot: p.slot }, 'no RecordingFinished event; leaving recording to the sweep');
    } finally {
      p.done.close();
    }
  }

  /** Stop every part. `file`: hand the recording to the uploader (call over), which mixes the parts. */
  private async finishRecording(file: boolean): Promise<void> {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    await Promise.all(r.parts.map((p) => this.stopPart(r.name, p)));
    if (file) await this.ctx.uploader.finish(r.name);
  }
}

interface Recording {
  name: string;
  parts: RecordingPart[];
}

interface RecordingPart {
  /** 'a' / 'b': the file <name>-<slot>.wav. */
  slot: string;
  /** The snoop channel being recorded. */
  snoopId: string;
  /** The party it watches. */
  target: string;
  done: Subscription<AriEvent>;
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
