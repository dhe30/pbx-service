import type { Logger } from './log.js';

// Per-call route trace (2026-11-15). Investigating the course's failures meant rebuilding each call
// from scattered log lines by timestamp. Now every info/warn/error line a call's logger writes is
// also recorded, in order, as a compact step, together with a few routing steps that aren't worth
// a log line of their own (see CallSession.step). The whole trace goes out once, on the call's
// "call ended" line, next to the SIP Call-ID that the edges' captures and audio records use:
//
//   journalctl -u pbx-ari-app -o cat | grep '"msg":"call ended"' | grep <sip call-id>
//
// Bounded so one pathological call can't produce a huge line.

export interface TraceStep {
  /** ms since the call started */
  t: number;
  /** log level: 30 info, 40 warn, 50 error; 0 = trace-only step */
  l: number;
  msg: string;
  [field: string]: unknown;
}

const MAX_STEPS = 80;
const MAX_FIELD_CHARS = 160;
/** Fields every line of the call already carries (bindings), or that are too bulky to repeat. */
const SKIP = new Set(['ch', 'kind', 'callId', 'tenant', 'sip', 'ext']);

export class CallTrace {
  readonly steps: TraceStep[] = [];
  dropped = 0;
  private readonly startedAt = Date.now();

  add(level: number, msg: string, fields?: unknown): void {
    if (this.steps.length >= MAX_STEPS) {
      this.dropped++;
      return;
    }
    const step: TraceStep = { t: Date.now() - this.startedAt, l: level, msg };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        if (SKIP.has(k) || v === undefined) continue;
        step[k] = compact(v);
      }
    }
    this.steps.push(step);
  }

  /** For the "call ended" line. */
  toJSON(): { steps: TraceStep[]; dropped?: number } {
    return this.dropped ? { steps: this.steps, dropped: this.dropped } : { steps: this.steps };
  }
}

/** Errors become their message; objects and long strings are cut to MAX_FIELD_CHARS of JSON. */
function compact(v: unknown): unknown {
  if (v instanceof Error) return v.message.slice(0, MAX_FIELD_CHARS);
  if (typeof v === 'string') return v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…` : v;
  if (v === null || typeof v !== 'object') return v;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…` : v;
}

const LEVELS: Record<string, number> = { info: 30, warn: 40, error: 50 };

/**
 * `base`, but every info/warn/error call is also added to `trace`. child() returns a traced
 * logger feeding the same trace, so flows that rebind `s.log = s.log.child({...})` keep tracing.
 */
export function tracedLogger(base: Logger, trace: CallTrace): Logger {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in LEVELS) {
        const level = LEVELS[prop]!;
        const fn = (target as unknown as Record<string, (...a: unknown[]) => void>)[prop]!;
        return (first: unknown, ...rest: unknown[]) => {
          if (typeof first === 'string') trace.add(level, first);
          // The line that carries the trace ("call ended") isn't a step of it: recording it nested
          // a "[Circular]" copy at the end of every trace.
          else if (!(first && typeof first === 'object' && 'trace' in first)) {
            trace.add(level, typeof rest[0] === 'string' ? rest[0] : '', first);
          }
          return fn.call(target, first, ...rest);
        };
      }
      if (prop === 'child') {
        return (bindings: Record<string, unknown>, opts?: Parameters<Logger['child']>[1]) =>
          tracedLogger(target.child(bindings, opts) as unknown as Logger, trace);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
