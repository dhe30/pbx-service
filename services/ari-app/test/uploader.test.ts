import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { metrics } from '../src/metrics.js';
import { Uploader, type SpoolMeta } from '../src/uploader.js';
import { mixWavs, wavData, wavHeader } from '../src/wav.js';
import { readFile } from 'node:fs/promises';

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

describe('Call recording parts (one file per party)', () => {
  const tone = (v: number, n: number) => {
    const d = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) d.writeInt16LE(v, i * 2);
    return Buffer.concat([wavHeader(d.length), d]);
  };

  it('mixWavs adds the samples, clips, and lasts as long as the longest part', () => {
    const out = mixWavs([tone(1000, 8000), tone(-300, 4000)]);
    const d = wavData(out);
    expect(d.length).toBe(16000);
    expect(d.readInt16LE(0)).toBe(700);
    expect(d.readInt16LE(2 * 7999)).toBe(1000);
    expect(wavData(mixWavs([tone(30000, 10), tone(30000, 10)])).readInt16LE(0)).toBe(32767);
    expect(out.readUInt32LE(24)).toBe(8000);
  });

  it('a finished recording with parts is mixed into <name>.wav, uploaded, and every file removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spool-'));
    try {
      const puts: { key: string; data: Buffer }[] = [];
      const up = new Uploader(dir, { saveUploadedRecording: async () => {} },
        { putFile: async (key: string, path: string) => { puts.push({ key, data: await readFile(path) }); } },
        pino({ level: 'silent' }));
      await up.begin('rec-x', { kind: 'recording', mediaId: '00000000-0000-4000-8000-000000000009',
        tenantId: '00000000-0000-4000-8000-000000000001', callId: null, mailboxId: null });
      await writeFile(join(dir, 'rec-x-a.wav'), tone(100, 8000));
      await writeFile(join(dir, 'rec-x-b.wav'), tone(200, 8000));
      await up.finish('rec-x');
      for (let i = 0; i < 50 && puts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(puts).toHaveLength(1);
      expect(wavData(puts[0]!.data).readInt16LE(0)).toBe(300);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
