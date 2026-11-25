import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './log.js';
import type { ObjectStore } from './object-store.js';
import type { Repo } from './repo.js';

// Tenant greetings and voicemail messages live in the object store; Asterisk can only play local
// files. Cache them under SOUNDS_CACHE_DIR/<media_id>.wav (8 kHz 16-bit mono wav). Media rows are
// immutable (a new upload = a new id), so a cached file never goes stale.
//
// Incident 2026-11-25 (pbx-7, 19:16-19:20 UTC): the root disk froze for ~4.5 min. Every fs call in
// Node goes through libuv's small thread pool, which was full of CDR fsyncs, so the `access()`
// below waited 245-279 s and IVR / voicemail callers heard silence until they hung up. Hence:
//   - a media id seen in the cache once is remembered: later calls do no file I/O at all;
//   - concurrent calls for the same media share one lookup;
//   - a lookup that takes longer than `timeoutMs` returns null, so the caller plays the default
//     prompt instead of waiting (the download keeps going and serves the next call).
export class MediaCache {
  private readonly cached = new Set<string>();
  private readonly loading = new Map<string, Promise<boolean>>();

  constructor(
    private readonly dir: string,
    private readonly repo: Repo,
    private readonly store: Pick<ObjectStore, 'getToFile'>,
    private readonly log: Logger,
    private readonly timeoutMs = 3000,
  ) {}

  /** ARI media URI for a greeting, or null if it can't be fetched (caller falls back to a default). */
  async soundUri(tenantId: string, mediaId: string): Promise<string | null> {
    return this.fetch(mediaId, () => this.repo.getMediaObjectKey(tenantId, mediaId));
  }

  /** ARI media URI for a stored object we already know the key of (voicemail playback). */
  async objectUri(mediaId: string, objectKey: string): Promise<string | null> {
    return this.fetch(mediaId, async () => objectKey);
  }

  private async fetch(mediaId: string, key: () => Promise<string | null>): Promise<string | null> {
    // Asterisk takes an absolute path without the extension and picks the format itself.
    const uri = `sound:${join(this.dir, mediaId)}`;
    if (this.cached.has(mediaId)) return uri;

    let load = this.loading.get(mediaId);
    if (!load) {
      load = this.load(mediaId, key).finally(() => this.loading.delete(mediaId));
      this.loading.set(mediaId, load);
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), this.timeoutMs);
    });
    const res = await Promise.race([load, timedOut]);
    clearTimeout(timer);
    if (res === 'timeout') {
      this.log.warn({ mediaId, timeoutMs: this.timeoutMs }, 'media lookup slow (disk or object store); playing the default');
      return null;
    }
    return res ? uri : null;
  }

  /** true once <dir>/<mediaId>.wav exists. Never throws. */
  private async load(mediaId: string, key: () => Promise<string | null>): Promise<boolean> {
    const file = join(this.dir, `${mediaId}.wav`);
    try {
      await access(file);
      this.cached.add(mediaId);
      return true;
    } catch {
      // not cached yet
    }
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const k = await key();
      if (!k) return false;
      await mkdir(this.dir, { recursive: true });
      await this.store.getToFile(k, tmp);
      await rename(tmp, file); // atomic: concurrent calls never see a half-written file
      this.cached.add(mediaId);
      return true;
    } catch (err) {
      this.log.warn({ err, mediaId }, 'media fetch failed');
      await unlink(tmp).catch(() => {});
      return false;
    }
  }
}
