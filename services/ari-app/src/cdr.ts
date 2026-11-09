import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallPricing } from '@pbx/shared';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';
import type { PendingCdr, Repo } from './repo.js';

// Durable, batched CDR writes (bottleneck B6).
//
// Phase 1 inserted a `calls` row BEFORE answering and updated it twice (answered, ended): three
// primary-DB writes per call, the first on the post-dial-delay path, all blocking on a failover.
// Now a call writes nothing until it ends; then its legs go to a local spool file (crash-safe:
// fsync'd rename) and a background loop inserts them in batches. A pbx node that dies loses at most
// the legs of calls still in progress (which lose their audio anyway).
//
// "Search ... includes just-ended calls": the flush interval (CDR_FLUSH_MS, 250 ms) plus one insert
// keeps a finished call searchable within about a second, even under load.

const SUFFIX = '.cdr.json';
const MAX_BATCH = 200;

export class CdrWriter {
  private queue: PendingCdr[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private backoffMs = 0;
  private stopped = false;

  constructor(
    /** Spool directory, or null for memory-only (tests). */
    private readonly dir: string | null,
    private readonly repo: Repo,
    private readonly pricing: () => Promise<CallPricing>,
    private readonly log: Logger,
    private readonly flushMs = 250,
  ) {}

  /** Replay legs left in the spool by a previous process, then start flushing. */
  async start(): Promise<void> {
    if (this.dir) {
      await mkdir(this.dir, { recursive: true });
      for (const f of await readdir(this.dir)) {
        if (!f.endsWith(SUFFIX)) continue;
        try {
          this.queue.push(JSON.parse(await readFile(join(this.dir, f), 'utf8')) as PendingCdr);
        } catch (err) {
          this.log.error({ err, file: f }, 'unreadable CDR spool file; leaving it for inspection');
        }
      }
      if (this.queue.length) this.log.warn({ n: this.queue.length }, 'replaying spooled CDRs');
    }
    this.schedule();
  }

  async submit(cdr: PendingCdr): Promise<void> {
    if (this.dir) {
      const file = join(this.dir, `${cdr.id}${SUFFIX}`);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(cdr), { flush: true });
      await rename(tmp, file);
    }
    this.queue.push(cdr);
    metrics.cdrBacklog.set(this.queue.length);
    this.schedule();
  }

  get backlog(): number {
    return this.queue.length;
  }

  /** Write everything queued now (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      await this.flushOnce();
      if (this.queue.length > 0 && this.backoffMs > 0) await new Promise((r) => setTimeout(r, Math.min(this.backoffMs, 50)));
    }
    await this.flushing;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
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
        if (this.dir) await Promise.all(batch.map((c) => unlink(join(this.dir!, `${c.id}${SUFFIX}`)).catch(() => {})));
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
