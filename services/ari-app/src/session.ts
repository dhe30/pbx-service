import type { CallDisposition } from '@pbx/shared';
import type { Logger } from './log.js';

/** Thrown (via AbortSignal) into a call flow when the caller hangs up. */
export class HangupError extends Error {
  constructor() {
    super('caller hung up');
  }
}

/** Per-call state for one inbound call. Memory only: lost if the process dies (accepted). */
export class CallSession {
  readonly abort = new AbortController();
  callId: string | null = null;
  tenantId: string | null = null;
  disposition: CallDisposition | null = null;

  constructor(
    readonly channelId: string,
    readonly callerNumber: string,
    readonly exten: string,
    public log: Logger,
  ) {}

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get hungUp(): boolean {
    return this.abort.signal.aborted;
  }

  /** Called by the dispatcher on StasisEnd / ChannelHangupRequest / ChannelDestroyed. */
  markHungUp(): void {
    if (!this.abort.signal.aborted) this.abort.abort(new HangupError());
  }

  /** Throw HangupError if the caller is gone (call between steps). */
  check(): void {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
  }
}
