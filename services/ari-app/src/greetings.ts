import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from './log.js';
import type { ObjectStore } from './object-store.js';
import type { Repo } from './repo.js';

// Tenant greetings and voicemail messages live in the object store; Asterisk can only play local
// files. Cache them under SOUNDS_CACHE_DIR/<media_id>.wav (8 kHz 16-bit mono wav). Media rows are
// immutable (a new upload = a new id), so a cached file never goes stale.
export class MediaCache {
  constructor(
    private readonly dir: string,
    private readonly repo: Repo,
    private readonly store: Pick<ObjectStore, 'getToFile'>,
    private readonly log: Logger,
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
      const k = await key();
      if (!k) return null;
      await mkdir(this.dir, { recursive: true });
      await this.store.getToFile(k, tmp);
      await rename(tmp, file); // atomic: concurrent calls never see a half-written file
      return uri;
    } catch (err) {
      this.log.warn({ err, mediaId }, 'media fetch failed');
      await unlink(tmp).catch(() => {});
      return null;
    }
  }
}
