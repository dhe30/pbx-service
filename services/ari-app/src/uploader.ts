import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaObjectKey } from '@pbx/shared';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';
import type { ObjectStore } from './object-store.js';
import type { Repo } from './repo.js';
import { wavDurationMs } from './wav.js';

// Moves finished recordings from Asterisk's local spool to the object store + DB.
//
// Crash safety: before a recording starts, a sidecar `<name>.meta.json` is written next to where
// Asterisk will write `<name>.wav`. The sidecar carries everything needed to file the recording,
// so after a crash the startup sweep can still upload it. Local files are deleted only after both
// the upload and the DB insert succeeded; until then the sweep keeps retrying every minute.

export interface SpoolMeta {
  kind: 'voicemail' | 'recording';
  mediaId: string;
  tenantId: string;
  callId: string | null;
  mailboxId: string | null;
  /** Voicemail: who left it (voicemails.caller_number). */
  callerNumber?: string | null;
  createdAt: string;
  /** Set when ARI reported RecordingFinished. */
  ready: boolean;
}

const META_SUFFIX = '.meta.json';
/** A not-ready recording whose wav hasn't been written for this long is finished (the app died mid-call). */
const STALE_MS = 2 * 60_000;
/** A sidecar with no wav after this long belongs to a recording that never started. */
const ORPHAN_MS = 10 * 60_000;
/** Voicemails shorter than this are hang-ups at the beep; drop them. */
const MIN_VOICEMAIL_MS = 1000;
const SWEEP_INTERVAL_MS = 60_000;

type SpoolState = 'recording' | 'upload' | 'drop';

/**
 * What to do with a spooled recording: still being written, ready to upload, or drop (no audio
 * file). A recording is finished when ARI said so (ready) or its wav stopped growing for STALE_MS
 * (the app died mid-call).
 */
function spoolState(meta: SpoolMeta, wav: { mtimeMs: number } | null, now: number): SpoolState {
  if (!wav) return meta.ready || now - Date.parse(meta.createdAt) > ORPHAN_MS ? 'drop' : 'recording';
  if (!meta.ready && now - wav.mtimeMs < STALE_MS) return 'recording';
  return 'upload';
}

export class Uploader {
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spoolDir: string,
    private readonly repo: Pick<Repo, 'saveUploadedRecording'>,
    private readonly store: Pick<ObjectStore, 'putFile'>,
    private readonly log: Logger,
  ) {}

  /** Write the sidecar. Call BEFORE asking Asterisk to start recording `name`. */
  async begin(name: string, meta: Omit<SpoolMeta, 'createdAt' | 'ready'>): Promise<void> {
    await this.writeMeta(name, { ...meta, createdAt: new Date().toISOString(), ready: false });
  }

  /** Recording finished: mark ready and upload now (the sweep retries on failure). */
  async finish(name: string): Promise<void> {
    try {
      const meta = await this.readMeta(name);
      await this.writeMeta(name, { ...meta, ready: true });
    } catch (err) {
      this.log.warn({ err, name }, 'could not mark recording ready; sweep will pick it up');
    }
    void this.process(name);
  }

  /** Recording never started (e.g. caller hung up first): drop the sidecar. */
  async abandon(name: string): Promise<void> {
    await unlink(this.metaPath(name)).catch(() => {});
    await unlink(this.wavPath(name)).catch(() => {});
  }

  start(): void {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.spoolDir)).filter((f) => f.endsWith(META_SUFFIX)).map((f) => f.slice(0, -META_SUFFIX.length));
    } catch (err) {
      this.log.error({ err, dir: this.spoolDir }, 'cannot read spool dir');
      return;
    }
    await this.updateGauges(names);
    for (const name of names) await this.process(name);
  }

  /**
   * Backlog = finished recordings not uploaded yet, NOT every sidecar: recordings of calls in
   * progress are counted separately, or a busy node looks stuck while every upload succeeds.
   * Waiting time counts from the wav's last write (about when the recording ended).
   */
  private async updateGauges(names: string[]): Promise<void> {
    const now = Date.now();
    let waiting = 0;
    let recording = 0;
    let oldest = now;
    for (const name of names) {
      const meta = await this.readMeta(name).catch(() => null);
      if (!meta) continue;
      const wav = await stat(this.wavPath(name)).catch(() => null);
      const state = spoolState(meta, wav, now);
      if (state === 'recording') recording++;
      else if (state === 'upload') {
        waiting++;
        oldest = Math.min(oldest, wav!.mtimeMs);
      }
    }
    metrics.uploadBacklog.set(waiting);
    metrics.recordingsInProgress.set(recording);
    metrics.uploadOldestWaiting.set(Math.max(0, Math.round((now - oldest) / 1000)));
  }

  private async process(name: string): Promise<void> {
    if (this.inFlight.has(name)) return;
    this.inFlight.add(name);
    try {
      let meta: SpoolMeta;
      try {
        meta = await this.readMeta(name);
      } catch {
        return; // already processed by a concurrent run, or unreadable (logged by sweep later)
      }
      const wav = await stat(this.wavPath(name)).catch(() => null);
      const state = spoolState(meta, wav, Date.now());
      if (state === 'drop') {
        this.log.warn({ name }, 'recording has no audio file; dropping');
        await this.abandon(name);
        return;
      }
      if (state === 'recording' || !wav) return; // still recording (or about to start)

      const durationMs = wavDurationMs(wav.size);
      if (meta.kind === 'voicemail' && durationMs < MIN_VOICEMAIL_MS) {
        this.log.info({ name, durationMs }, 'voicemail too short; dropping');
        await this.abandon(name);
        return;
      }

      const objectKey = mediaObjectKey(meta.tenantId, meta.kind, meta.mediaId);
      await this.store.putFile(objectKey, this.wavPath(name));
      await this.repo.saveUploadedRecording({ ...meta, objectKey, durationMs });
      await unlink(this.wavPath(name));
      await unlink(this.metaPath(name));
      metrics.uploadsTotal.inc({ result: 'ok' });
      this.log.info({ name, objectKey, durationMs }, 'recording uploaded');
    } catch (err) {
      metrics.uploadsTotal.inc({ result: 'error' });
      this.log.warn({ err, name }, 'upload failed; will retry on next sweep');
    } finally {
      this.inFlight.delete(name);
    }
  }

  private wavPath(name: string): string {
    return join(this.spoolDir, `${name}.wav`);
  }

  private metaPath(name: string): string {
    return join(this.spoolDir, `${name}${META_SUFFIX}`);
  }

  private async readMeta(name: string): Promise<SpoolMeta> {
    return JSON.parse(await readFile(this.metaPath(name), 'utf8')) as SpoolMeta;
  }

  private async writeMeta(name: string, meta: SpoolMeta): Promise<void> {
    const tmp = `${this.metaPath(name)}.tmp`;
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, this.metaPath(name));
  }
}
