import { randomUUID } from 'node:crypto';
import { access, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './log.js';
import type { ObjectStore } from './object-store.js';
import type { Repo } from './repo.js';

// Tenant greetings live in the object store; Asterisk can only play local files. Cache them under
// SOUNDS_CACHE_DIR/<media_id>.wav (the API already converted them to 8 kHz mono wav). Media rows
// are immutable (a new upload = a new id), so a cached file never goes stale.
export class GreetingCache {
  constructor(
    private readonly dir: string,
    private readonly repo: Repo,
    private readonly store: ObjectStore,
    private readonly log: Logger,
  ) {}

  /** ARI media URI for a greeting, or null if it can't be fetched (caller falls back to a default). */
  async soundUri(tenantId: string, mediaId: string): Promise<string | null> {
    const base = join(this.dir, mediaId);
    const file = `${base}.wav`;
    // Asterisk takes an absolute path without the extension and picks the format itself.
    const uri = `sound:${base}`;
    try {
      await access(file);
      return uri;
    } catch {
      // not cached yet
    }
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const key = await this.repo.getMediaObjectKey(tenantId, mediaId);
      if (!key) return null;
      await this.store.getToFile(key, tmp);
      await rename(tmp, file); // atomic: concurrent calls never see a half-written file
      return uri;
    } catch (err) {
      this.log.warn({ err, mediaId }, 'greeting fetch failed; using default prompt');
      await unlink(tmp).catch(() => {});
      return null;
    }
  }
}
