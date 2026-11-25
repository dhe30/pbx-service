import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { CallPricing } from '@pbx/shared';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';
import type { PendingCdr, Repo } from './repo.js';

// Durable, batched CDR writes (bottleneck B6).
//
// Phase 1 inserted a `calls` row BEFORE answering and updated it twice (answered, ended): three
// primary-DB writes per call, the first on the post-dial-delay path, all blocking on a failover.
// Now a call writes nothing until it ends; then its legs go to an in-memory queue that a
// background loop inserts in batches, and to a local spool file (crash-safe: fsync'd rename) so a
// restart replays legs that were not in Postgres yet. A pbx node that dies loses at most the legs
// of calls still in progress (which lose their audio anyway) plus legs not spooled yet (normally
// a few ms).
//
// Spool I/O never blocks a call (incident 2026-11-25, pbx-7 19:16-19:20 UTC): `submit` returns as
// soon as the leg is queued, and every spool operation (write+fsync, rename, unlink) runs one at a
// time in the background. Node runs fs calls on libuv's thread pool (4 threads by default); when
// the root disk froze for ~4.5 min, per-call parallel fsyncs held all of them and every other fs
// call in the process (greeting lookups on the IVR / voicemail path) waited behind them. Now the
// spool holds at most one thread, and inserts into Postgres continue while the disk is stuck.
//
// "Search ... includes just-ended calls": the flush interval (CDR_FLUSH_MS, 250 ms) plus one insert
// keeps a finished call searchable within about a second, even under load.

const SUFFIX = '.cdr.json';
const MAX_BATCH = 200;

/** The fs calls the spool uses (injectable for tests). */
export type SpoolFs = Pick<typeof nodeFs, 'mkdir' | 'readdir' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>;

export class CdrWriter {
  private queue: PendingCdr[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private backoffMs = 0;
  private stopped = false;

  /** Serial chain of spool operations: at most one fs call in flight. */
  private diskTail: Promise<void> = Promise.resolve();
  private diskPending = 0;
  /** Legs whose spool file exists (written by us or found at start). */
  private readonly spooled = new Set<string>();
  /** Legs already in Postgres whose spool step has not run yet: no need to write them. */
  private readonly inserted = new Set<string>();

  constructor(
    /** Spool directory, or null for memory-only (tests). */
    private readonly dir: string | null,
    private readonly repo: Repo,
    private readonly pricing: () => Promise<CallPricing>,
    private readonly log: Logger,
    private readonly flushMs = 250,
    private readonly fs: SpoolFs = nodeFs,
  ) {}

  /** Replay legs left in the spool by a previous process, then start flushing. */
  async start(): Promise<void> {
    if (this.dir) {
      await this.fs.mkdir(this.dir, { recursive: true });
      for (const f of await this.fs.readdir(this.dir)) {
        if (!f.endsWith(SUFFIX)) continue;
        try {
          const cdr = JSON.parse(await this.fs.readFile(join(this.dir, f), 'utf8')) as PendingCdr;
          this.queue.push(cdr);
          this.spooled.add(cdr.id);
        } catch (err) {
          this.log.error({ err, file: f }, 'unreadable CDR spool file; leaving it for inspection');
        }
      }
      if (this.queue.length) this.log.warn({ n: this.queue.length }, 'replaying spooled CDRs');
    }
    this.schedule();
  }

  /** Queue a finished leg. Returns at once: the spool file is written in the background. */
  async submit(cdr: PendingCdr): Promise<void> {
    this.queue.push(cdr);
    metrics.cdrBacklog.set(this.queue.length);
    if (this.dir) this.onDisk(() => this.spool(cdr));
    this.schedule();
  }

  get backlog(): number {
    return this.queue.length;
  }

  /** Spool operations queued or running (> a few = the disk is slow). */
  get spoolPending(): number {
    return this.diskPending;
  }

  /** Write everything queued now, then let the spool catch up (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flushOnce();
      if (this.queue.length > 0 && this.backoffMs > 0) await new Promise((r) => setTimeout(r, Math.min(this.backoffMs, 50)));
    }
    await this.flushing;
    await this.spoolIdle();
  }

  /** Resolves once every spool operation queued so far has run (tests, shutdown). */
  async spoolIdle(): Promise<void> {
    await this.diskTail;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private onDisk(op: () => Promise<void>): void {
    this.diskPending++;
    metrics.cdrSpoolPending.set(this.diskPending);
    this.diskTail = this.diskTail.then(op).finally(() => {
      this.diskPending--;
      metrics.cdrSpoolPending.set(this.diskPending);
    });
  }

  /** Write one leg's spool file, unless it reached Postgres first. Never throws. */
  private async spool(cdr: PendingCdr): Promise<void> {
    if (this.inserted.has(cdr.id)) return; // its unlink step (queued after this one) clears the mark
    const file = join(this.dir!, `${cdr.id}${SUFFIX}`);
    const tmp = `${file}.tmp`;
    try {
      await this.fs.writeFile(tmp, JSON.stringify(cdr), { flush: true });
      await this.fs.rename(tmp, file);
      this.spooled.add(cdr.id);
    } catch (err) {
      // Still queued in memory; only a crash before the insert would lose it.
      this.log.error({ err, cdr }, 'could not spool CDR');
    }
  }

  /** After an insert: remove the leg's spool file. Runs after that leg's spool step (same chain). */
  private async unspool(id: string): Promise<void> {
    this.inserted.delete(id);
    if (!this.spooled.delete(id)) return;
    await this.fs.unlink(join(this.dir!, `${id}${SUFFIX}`)).catch(() => {});
  }

  private schedule(): void {
    if (this.stopped || this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushOnce().finally(() => this.schedule());
    }, this.flushMs + this.backoffMs);
  }

  private async flushOnce(): Promise<void> {
    if (this.flushing) return this.flushing;
    const batch = this.queue.slice(0, MAX_BATCH);
    if (batch.length === 0) return;
    this.flushing = (async () => {
      try {
        await this.repo.insertCdrs(batch, await this.pricing());
        this.queue.splice(0, batch.length);
        this.backoffMs = 0;
        metrics.cdrsWritten.inc(batch.length);
        if (this.dir) {
          for (const c of batch) {
            this.inserted.add(c.id);
            this.onDisk(() => this.unspool(c.id));
          }
        }
      } catch (err) {
        this.backoffMs = Math.min(10_000, Math.max(500, this.backoffMs * 2));
        metrics.cdrWriteErrors.inc();
        this.log.warn({ err, n: batch.length, retryInMs: this.backoffMs }, 'CDR insert failed; will retry');
      } finally {
        metrics.cdrBacklog.set(this.queue.length);
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}
