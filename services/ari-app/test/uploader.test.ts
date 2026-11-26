import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '../src/metrics.js';
import { Uploader, type SpoolMeta } from '../src/uploader.js';

// pbx_upload_backlog counts finished recordings waiting for upload, not recordings of calls in
// progress (2026-11-26: pbx-7 had 131 sidecars, 0 finished, 0 failed uploads, and the alert fired).

const gauge = async (g: { get(): Promise<{ values: { value: number }[] }> }) => (await g.get()).values[0]?.value;

describe('Uploader spool gauges', () => {
  let dir: string;
  let uploaded: string[];
  let storeFails: boolean;
  let up: Uploader;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spool-'));
    uploaded = [];
    storeFails = false;
    up = new Uploader(
      dir,
      { saveUploadedRecording: async () => {} },
      {
        putFile: async (key: string) => {
          if (storeFails) throw new Error('object store down');
          uploaded.push(key);
        },
      },
      pino({ level: 'silent' }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A spooled recording whose wav was last written `wavAgeSec` ago. */
  async function spool(name: string, ready: boolean, wavAgeSec: number): Promise<void> {
    const meta: SpoolMeta = {
      kind: 'recording',
      mediaId: `00000000-0000-4000-8000-00000000000${name.length % 10}`,
      tenantId: '00000000-0000-4000-8000-000000000001',
      callId: null,
      mailboxId: null,
      createdAt: new Date(Date.now() - (wavAgeSec + 60) * 1000).toISOString(),
      ready,
    };
    await writeFile(join(dir, `${name}.meta.json`), JSON.stringify(meta));
    const wav = join(dir, `${name}.wav`);
    await writeFile(wav, Buffer.alloc(44 + 16000)); // 1 s of 8 kHz 16-bit audio
    const t = new Date(Date.now() - wavAgeSec * 1000);
    await utimes(wav, t, t);
  }

  it('counts recordings still being written as in progress, not as backlog, and leaves them', async () => {
    await spool('live-a', false, 5);
    await spool('live-b', false, 30);
    await up.sweep();
    expect(await gauge(metrics.uploadBacklog)).toBe(0);
    expect(await gauge(metrics.recordingsInProgress)).toBe(2);
    expect(await gauge(metrics.uploadOldestWaiting)).toBe(0);
    expect(uploaded).toEqual([]);
    expect((await readdir(dir)).length).toBe(4);
  });

  it('counts finished recordings the store refuses as backlog, with the oldest waiting time', async () => {
    storeFails = true;
    await spool('done-a', true, 900);
    await spool('done-b', true, 60);
    await spool('live', false, 5);
    await up.sweep();
    expect(await gauge(metrics.uploadBacklog)).toBe(2);
    expect(await gauge(metrics.recordingsInProgress)).toBe(1);
    expect(await gauge(metrics.uploadOldestWaiting)).toBeGreaterThanOrEqual(899);
    expect((await readdir(dir)).length).toBe(6); // nothing deleted while the upload fails
  });

  it('treats a recording whose wav stopped growing as finished (app died) and uploads it', async () => {
    await spool('orphaned', false, 300);
    await up.sweep();
    expect(await gauge(metrics.uploadBacklog)).toBe(1); // counted before this sweep's upload
    expect(uploaded).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
    await up.sweep();
    expect(await gauge(metrics.uploadBacklog)).toBe(0);
    expect(await gauge(metrics.uploadOldestWaiting)).toBe(0);
  });
});
