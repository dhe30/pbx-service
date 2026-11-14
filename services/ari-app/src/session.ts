import { randomUUID } from 'node:crypto';
import { billingPeriod, type CdrDirection, type CdrOutcome, type ChargeClass, type PstnVendor } from '@pbx/shared';
import type { Ari } from './ari/client.js';
import type { HangupReason } from './ari/types.js';
import type { Logger } from './log.js';
import type { PendingCdr } from './repo.js';
import type { TenantConfig } from './tenant.js';

/** Thrown (via AbortSignal) into a call flow when the caller hangs up. */
export class HangupError extends Error {
  constructor() {
    super('caller hung up');
  }
}

/** One CDR row in the making (spec §5). Times are set as the leg progresses. */
export interface LegDraft {
  id: string;
  parentId: string | null;
  direction: CdrDirection;
  fromNumber: string | null;
  toNumber: string | null;
  did: string | null;
  fromExtension: string | null;
  toExtension: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  outcome: CdrOutcome | null;
  vendor: PstnVendor | null;
  ratePrefix: string | null;
  chargeClass: ChargeClass;
  costPerMin: number;
  voicemail: boolean;
  hangupCause: number | null;
}

export function newLeg(fields: Partial<LegDraft> & Pick<LegDraft, 'direction' | 'chargeClass'>): LegDraft {
  return {
    id: randomUUID(),
    parentId: null,
    fromNumber: null,
    toNumber: null,
    did: null,
    fromExtension: null,
    toExtension: null,
    startedAt: new Date(),
    answeredAt: null,
    endedAt: null,
    outcome: null,
    vendor: null,
    ratePrefix: null,
    costPerMin: 0,
    voicemail: false,
    hangupCause: null,
    ...fields,
  };
}

/**
 * Per-call state. Memory only: lost if the process dies (accepted; the call's audio is lost
 * too). `primary` is the channel the flow routes (the caller). It can change: after a blind
 * transfer the party that stays becomes the primary.
 */
export class CallSession {
  /** cdrs.call_id: groups every leg of this call. */
  readonly callId = randomUUID();
  readonly abort = new AbortController();
  tenant: TenantConfig | null = null;
  main: LegDraft | null = null;
  /** Extra legs we placed to external numbers, by channel id. */
  readonly children = new Map<string, LegDraft>();
  /** Channels of legs this session owns whose end we must wait for before writing CDRs. */
  readonly liveLegs = new Map<string, Promise<void>>();
  answered = false;
  /** A person (extension, external number) answered at least once. */
  connected = false;
  /** Outcome of the last ring attempt (busy / no answer / failed) if nobody answered. */
  ringOutcome: CdrOutcome | null = null;
  /** Caller ID we present on legs we place to external numbers (one of the account's numbers). */
  presentedNumber: string | null = null;
  /** What staff phones display when we ring them. */
  ringCallerId: string;
  /** Destinations followed so far (loop guard, MAX_ROUTE_HOPS). */
  hops = 0;
  /**
   * The primary channel was moved into ANOTHER call's conversation by an attended transfer (this
   * call was the consult call, e.g. the second of two calls a phone answered). That call drives
   * it now: our flow must not hang it up when it ends.
   */
  primaryHandedOver = false;

  constructor(
    public primary: string,
    readonly callerNumber: string,
    readonly exten: string,
    public log: Logger,
    private readonly onRebind: (from: string, to: string, s: CallSession) => void = () => {},
  ) {
    this.ringCallerId = callerNumber;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get hungUp(): boolean {
    return this.abort.signal.aborted;
  }

  /** Called by the dispatcher when the primary channel leaves (StasisEnd / hangup / destroyed). */
  markHungUp(): void {
    if (!this.abort.signal.aborted) this.abort.abort(new HangupError());
  }

  /** Throw HangupError if the caller is gone (call between steps). */
  check(): void {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
  }

  /** The remaining party of a transfer becomes the channel this flow routes. */
  rebind(channelId: string): void {
    if (channelId === this.primary) return;
    const from = this.primary;
    this.primary = channelId;
    this.onRebind(from, channelId, this);
  }

  /** Hang up the primary at the end of the flow, unless another call took it over. */
  async hangupPrimary(ari: Ari, reason?: HangupReason): Promise<void> {
    if (this.primaryHandedOver) return;
    await ari.hangupQuietly(this.primary, reason);
  }

  /** Answer the primary channel once (before playing media or bridging). */
  async ensureAnswered(ari: Ari): Promise<void> {
    if (this.answered) return;
    await ari.answer(this.primary);
    this.answered = true;
    // Answering the caller ourselves (IVR, voicemail, *98) is when an incoming or internal call is
    // answered. Before 2026-11-14 only incoming calls got this, so every *98 call was stored as
    // "answered" with no answer time. Outgoing calls are answered by the vendor leg instead.
    if (this.main && !this.main.answeredAt && this.main.direction !== 'outgoing') this.main.answeredAt = new Date();
  }

  /** The final CDR rows, once every owned leg has ended. */
  async finish(opts: { pbxNode: string; endedAt?: Date }): Promise<PendingCdr[]> {
    const endedAt = opts.endedAt ?? new Date();
    // A leg moved to another call by an attended transfer is still ours to bill: wait for it.
    if (this.liveLegs.size > 0) await Promise.allSettled([...this.liveLegs.values()]);
    if (!this.main || !this.tenant) return [];
    const t = this.tenant;
    const main = this.main;
    main.endedAt ??= endedAt;
    if (!main.outcome) {
      main.outcome = this.connected ? 'answered' : (this.ringOutcome ?? 'no_answer');
    }
    const out = [main, ...this.children.values()].map((l) => toPending(l, this.callId, t, opts.pbxNode, endedAt));
    return out;
  }
}

function toPending(l: LegDraft, callId: string, t: TenantConfig, pbxNode: string, fallbackEnd: Date): PendingCdr {
  const ended = l.endedAt ?? fallbackEnd;
  const answered = l.answeredAt && l.answeredAt <= ended ? l.answeredAt : null;
  return {
    id: l.id,
    callId,
    parentId: l.parentId,
    tenantId: t.id,
    direction: l.direction,
    fromNumber: l.fromNumber,
    toNumber: l.toNumber,
    did: l.did,
    fromExtension: l.fromExtension,
    toExtension: l.toExtension,
    startedAt: l.startedAt.toISOString(),
    answeredAt: answered ? answered.toISOString() : null,
    endedAt: ended.toISOString(),
    outcome: l.outcome ?? (answered ? 'answered' : 'no_answer'),
    vendor: l.vendor,
    ratePrefix: l.ratePrefix,
    voicemail: l.voicemail,
    hangupCause: l.hangupCause,
    pbxNode,
    chargeClass: l.chargeClass,
    costPerMin: l.costPerMin,
    periodStart: billingPeriod(t.timezone, t.createdAt, l.startedAt).startDate,
    includedAllowanceSec: t.includedUsMinutes * 60,
  };
}

/**
 * Q.850 cause -> CDR outcome for a leg that ended without being answered.
 * 17 user busy (486), 21 call rejected (603 decline / 403) -> busy.
 * 16 normal (cancelled / declined by an app), 18 no user response (408), 19 no answer,
 * 20 subscriber absent (480, e.g. extension with no registered device) -> no answer.
 * Anything else (404, 5xx, 402 from an unfunded vendor, ...) -> failed.
 */
export function outcomeFromCause(cause: number | null | undefined): Exclude<CdrOutcome, 'answered' | 'blocked'> {
  if (cause === 17 || cause === 21) return 'busy';
  if (cause === 16 || cause === 18 || cause === 19 || cause === 20 || cause === 0 || cause === undefined || cause === null) return 'no_answer';
  return 'failed';
}

/** Combine the outcomes of several legs rung for one call. */
export function combineOutcomes(outcomes: CdrOutcome[], timedOut: boolean): Exclude<CdrOutcome, 'answered' | 'blocked'> {
  if (timedOut) return 'no_answer';
  if (outcomes.length > 0 && outcomes.every((o) => o === 'busy')) return 'busy';
  if (outcomes.some((o) => o === 'no_answer' || o === 'busy')) return 'no_answer';
  return outcomes.length === 0 ? 'no_answer' : 'failed';
}
