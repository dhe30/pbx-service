import { AriError, type Ari, type OriginateOptions } from '../../src/ari/client.js';
import type { AriEvent, Bridge, Channel, HangupReason, LiveRecording, Playback, TransferProgressState } from '../../src/ari/types.js';

// A small in-memory Asterisk for call-flow tests. It implements the ARI operations the app uses
// and emits the events real Asterisk would (StasisStart/End, ChannelDestroyed with Q.850 causes,
// PlaybackFinished, RecordingFinished, ChannelHold, ChannelTransfer, ...). Tests script how each
// phone / external number behaves and inject what the far ends do (DTMF, hold, REFER, hangup).

export interface Behavior {
  /** Answer after this many ms. */
  answerAfterMs?: number;
  /** End unanswered with this Q.850 cause after failAfterMs (17 busy, 20 not registered, 21 declined, 34/38 failure). */
  failCause?: number;
  failAfterMs?: number;
  /** Ring until the app gives up (default when nothing is scripted). */
}

export interface FakeChannel {
  id: string;
  name: string;
  exten: string;
  callerNumber: string;
  endpoint: string | null;
  callerId: string | null;
  inStasis: boolean;
  answered: boolean;
  rung: boolean;
  moh: boolean;
  vars: Record<string, string>;
  timers: NodeJS.Timeout[];
  hangupReason?: HangupReason;
}

const CAUSE: Record<HangupReason, number> = {
  normal: 16,
  busy: 17,
  congestion: 34,
  no_answer: 19,
  unallocated: 1,
  rejected: 21,
  failure: 38,
};

export type Target = { kind: 'sip'; user: string; trunk: string } | { kind: 'external'; number: string; vendor: string; trunk: string; host: string };

export function parseEndpoint(endpoint: string): Target {
  const v = /^PJSIP\/vendor-(us|intl)-([^/]+)\/sip:([^@]+)@(.+)$/.exec(endpoint);
  if (v) return { kind: 'external', vendor: v[1]!, trunk: v[2]!, number: v[3]!, host: v[4]! };
  const s = /^PJSIP\/([^@]+)@(.+)$/.exec(endpoint);
  if (s) return { kind: 'sip', user: s[1]!, trunk: s[2]! };
  throw new Error(`unparseable endpoint ${endpoint}`);
}

export class FakeAsterisk implements Ari {
  connected = true;
  onEvent: (ev: AriEvent) => void = () => {};
  readonly channels = new Map<string, FakeChannel>();
  readonly bridges = new Map<string, Set<string>>();
  readonly recordings = new Map<string, { target: string; kind: 'channel' | 'bridge' }>();
  readonly finishedRecordings: string[] = [];
  readonly originates: (OriginateOptions & { target: Target })[] = [];
  readonly plays: { channelId: string; media: string }[] = [];
  readonly transferProgressLog: { channelId: string; state: TransferProgressState }[] = [];
  readonly hangups: { channelId: string; reason: HangupReason }[] = [];
  readonly destroyed = new Map<string, number>();
  private readonly playbacks = new Map<string, { channelId: string; timer?: NodeJS.Timeout }>();
  private seq = 0;

  /** Per SIP user (all of an extension's devices, as Kamailio forks to them) and per external number. */
  readonly sip = new Map<string, Behavior>();
  readonly external = new Map<string, Behavior>();
  /** Trunks whose originates fail immediately (an edge is down). */
  readonly deadTrunks = new Set<string>();
  playMs = 2;

  private emit(ev: Record<string, unknown>): void {
    const full = { application: 'pbx-app', timestamp: new Date().toISOString(), ...ev } as unknown as AriEvent;
    setImmediate(() => this.onEvent(full));
  }

  chan(c: FakeChannel): Channel {
    return {
      id: c.id,
      name: c.name,
      state: c.answered ? 'Up' : 'Ring',
      caller: { name: '', number: c.callerNumber },
      connected: { name: '', number: '' },
      dialplan: { context: 'from-edge', exten: c.exten, priority: 1, app_name: 'Stasis', app_data: 'pbx-app' },
    };
  }

  private newChannel(fields: Partial<FakeChannel>): FakeChannel {
    const c: FakeChannel = {
      id: fields.id ?? `ch-${++this.seq}`,
      name: fields.name ?? `PJSIP/test-${this.seq}`,
      exten: '',
      callerNumber: '',
      endpoint: null,
      callerId: null,
      inStasis: false,
      answered: false,
      rung: false,
      moh: false,
      vars: {},
      timers: [],
      ...fields,
    };
    this.channels.set(c.id, c);
    return c;
  }

  private need(id: string): FakeChannel {
    const c = this.channels.get(id);
    if (!c) throw new AriError(404, 'POST', `/channels/${id}`, 'Channel not found');
    return c;
  }

  // ---- test-side actions -------------------------------------------------------------------

  /** The carrier delivers a PSTN call to `did` (R-URI user, digits as the carrier sends them). */
  carrierCall(did: string, caller: string): string {
    const c = this.newChannel({ exten: did, callerNumber: caller, inStasis: true, name: 'PJSIP/edge-a-carrier' });
    this.emit({ type: 'StasisStart', args: ['carrier', ''], channel: this.chan(c) });
    return c.id;
  }

  /** One of the account's phones (SIP user `sipUser`) dials `dialed`. */
  deviceCall(sipUser: string, dialed: string): string {
    const c = this.newChannel({ exten: dialed, callerNumber: sipUser, inStasis: true, name: `PJSIP/edge-a-${sipUser}` });
    this.emit({ type: 'StasisStart', args: ['device', sipUser], channel: this.chan(c) });
    return c.id;
  }

  dtmf(channelId: string, digits: string): void {
    for (const d of digits) this.emit({ type: 'ChannelDtmfReceived', digit: d, duration_ms: 100, channel: this.chan(this.need(channelId)) });
  }

  /** The far end of `channelId` hangs up. */
  remoteHangup(channelId: string, cause = 16): void {
    if (this.channels.has(channelId)) this.destroy(channelId, cause);
  }

  hold(channelId: string): void {
    this.emit({ type: 'ChannelHold', channel: this.chan(this.need(channelId)) });
  }

  unhold(channelId: string): void {
    this.emit({ type: 'ChannelUnhold', channel: this.chan(this.need(channelId)) });
  }

  /** The phone on `channelId` sends REFER to `target` (blind transfer). */
  referBlind(channelId: string, target: string): void {
    this.emit({
      type: 'ChannelTransfer',
      refer_to: { requested_destination: { protocol_id: 'sip', destination: `sip:${target}@group.test` } },
      referred_by: { source_channel: this.chan(this.need(channelId)) },
    });
  }

  /** The phone on `channelId` sends REFER with Replaces naming its consult call `consultChannelId`. */
  referAttended(channelId: string, consultChannelId: string, target = 'x'): void {
    this.emit({
      type: 'ChannelTransfer',
      refer_to: {
        requested_destination: { protocol_id: 'sip', destination: `sip:${target}@group.test` },
        destination_channel: this.chan(this.need(consultChannelId)),
      },
      referred_by: { source_channel: this.chan(this.need(channelId)) },
    });
  }

  /** Originated channels toward a SIP user or external number. */
  legsTo(who: string): FakeChannel[] {
    return [...this.originates]
      .filter((o) => (o.target.kind === 'sip' ? o.target.user === who : o.target.number === who))
      .map((o) => this.channels.get(o.channelId))
      .filter((c): c is FakeChannel => !!c);
  }

  /** The channel in the same bridge as `channelId`. */
  peerOf(channelId: string): string | null {
    for (const members of this.bridges.values()) {
      if (members.has(channelId)) for (const m of members) if (m !== channelId) return m;
    }
    return null;
  }

  // ---- ARI ----------------------------------------------------------------------------------

  async listChannels(): Promise<Channel[]> {
    return [...this.channels.values()].map((c) => this.chan(c));
  }

  async answer(channelId: string): Promise<void> {
    this.need(channelId).answered = true;
  }

  async ring(channelId: string): Promise<void> {
    this.need(channelId).rung = true;
  }

  async hangup(channelId: string, reason: HangupReason = 'normal'): Promise<void> {
    const c = this.need(channelId);
    c.hangupReason = reason;
    this.hangups.push({ channelId, reason });
    this.destroy(channelId, CAUSE[reason]);
  }

  async hangupQuietly(channelId: string, reason: HangupReason = 'normal'): Promise<void> {
    if (this.channels.has(channelId)) await this.hangup(channelId, reason);
  }

  private destroy(channelId: string, cause: number): void {
    const c = this.channels.get(channelId);
    if (!c) return;
    this.channels.delete(channelId);
    this.destroyed.set(channelId, cause);
    for (const t of c.timers) clearTimeout(t);
    for (const [pid, p] of this.playbacks) {
      if (p.channelId === channelId) {
        if (p.timer) clearTimeout(p.timer);
        this.playbacks.delete(pid);
      }
    }
    for (const [name, r] of this.recordings) {
      if (r.kind === 'channel' && r.target === channelId) this.finishRecording(name);
    }
    for (const m of this.bridges.values()) m.delete(channelId);
    const ch = this.chan(c);
    if (c.inStasis) this.emit({ type: 'StasisEnd', channel: ch });
    this.emit({ type: 'ChannelDestroyed', cause, cause_txt: `cause ${cause}`, channel: ch });
  }

  async play(channelId: string, media: string, playbackId: string): Promise<Playback> {
    this.need(channelId);
    this.plays.push({ channelId, media });
    const p: Playback = { id: playbackId, media_uri: media, target_uri: `channel:${channelId}`, state: 'playing' };
    const entry: { channelId: string; timer?: NodeJS.Timeout } = { channelId };
    this.playbacks.set(playbackId, entry);
    if (!media.startsWith('tone:')) {
      entry.timer = setTimeout(() => {
        if (!this.playbacks.delete(playbackId)) return;
        this.emit({ type: 'PlaybackFinished', playback: { ...p, state: 'done' } });
      }, this.playMs);
    }
    return p;
  }

  async stopPlayback(playbackId: string): Promise<void> {
    const p = this.playbacks.get(playbackId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.playbacks.delete(playbackId);
    this.emit({ type: 'PlaybackFinished', playback: { id: playbackId, media_uri: '', target_uri: `channel:${p.channelId}`, state: 'done' } });
  }

  async startMoh(channelId: string): Promise<void> {
    this.need(channelId).moh = true;
  }

  async stopMoh(channelId: string): Promise<void> {
    const c = this.channels.get(channelId);
    if (c) c.moh = false;
  }

  async recordChannel(channelId: string, opts: { name: string }): Promise<LiveRecording> {
    this.need(channelId);
    this.recordings.set(opts.name, { target: channelId, kind: 'channel' });
    return { name: opts.name, format: 'wav', target_uri: `channel:${channelId}`, state: 'recording' };
  }

  finishRecording(name: string): void {
    if (!this.recordings.delete(name)) return;
    this.finishedRecordings.push(name);
    this.emit({ type: 'RecordingFinished', recording: { name, format: 'wav', target_uri: '', state: 'done', duration: 3 } });
  }

  async originate(opts: OriginateOptions): Promise<Channel> {
    const target = parseEndpoint(opts.endpoint);
    if (this.deadTrunks.has(target.trunk)) throw new AriError(500, 'POST', '/channels', 'trunk unreachable');
    this.originates.push({ ...opts, target });
    const c = this.newChannel({ id: opts.channelId, endpoint: opts.endpoint, callerId: opts.callerId ?? null, name: opts.endpoint });
    const b = (target.kind === 'sip' ? this.sip.get(target.user) : this.external.get(target.number)) ?? {};
    if (b.answerAfterMs !== undefined) {
      c.timers.push(
        setTimeout(() => {
          if (!this.channels.has(c.id)) return;
          c.answered = true;
          c.inStasis = true;
          this.emit({ type: 'StasisStart', args: [opts.appArgs], channel: this.chan(c) });
        }, b.answerAfterMs),
      );
    } else if (b.failCause !== undefined) {
      c.timers.push(setTimeout(() => this.destroy(c.id, b.failCause!), b.failAfterMs ?? 1));
    }
    return this.chan(c);
  }

  async setChannelVar(channelId: string, variable: string, value: string): Promise<void> {
    this.need(channelId).vars[variable] = value;
  }

  async transferProgress(channelId: string, states: TransferProgressState): Promise<void> {
    this.transferProgressLog.push({ channelId, state: states });
  }

  async createBridge(bridgeId: string): Promise<Bridge> {
    this.bridges.set(bridgeId, new Set());
    return { id: bridgeId, bridge_type: 'mixing', channels: [] };
  }

  async addToBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    const b = this.bridges.get(bridgeId);
    if (!b) throw new AriError(404, 'POST', `/bridges/${bridgeId}`, 'Bridge not found');
    for (const id of channelIds) {
      this.need(id);
      for (const other of this.bridges.values()) other.delete(id);
      b.add(id);
    }
  }

  async removeFromBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    const b = this.bridges.get(bridgeId);
    for (const id of channelIds) b?.delete(id);
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    this.bridges.delete(bridgeId);
    for (const [name, r] of this.recordings) if (r.kind === 'bridge' && r.target === bridgeId) this.finishRecording(name);
  }

  async recordBridge(bridgeId: string, name: string): Promise<LiveRecording> {
    this.recordings.set(name, { target: bridgeId, kind: 'bridge' });
    return { name, format: 'wav', target_uri: `bridge:${bridgeId}`, state: 'recording' };
  }

  async stopRecording(name: string): Promise<void> {
    this.finishRecording(name);
  }
}
