// Incident 2026-11-25 (pbx-7, 19:16-19:20 UTC): the root disk froze ~4.5 min. Per-call CDR fsyncs
// filled libuv's 4 threads, so greeting lookups on the IVR / voicemail path waited behind them and
// callers heard silence. These tests pin the two guarantees that fix it (src/cdr.ts, src/greetings.ts).
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CALL_PRICING } from '@pbx/shared';
import { CdrWriter, type SpoolFs } from '../src/cdr.js';
import { MediaCache } from '../src/greetings.js';
import type { PendingCdr, Repo } from '../src/repo.js';

const log = pino({ level: 'silent' });
const leg = (id: string) => ({ id }) as unknown as PendingCdr;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
}

/** Fake fs that records calls, counts concurrency, and can hang writes until released. */
function fakeFs(gate?: Promise<void>) {
  const ops: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const wrap =
    <A extends unknown[]>(name: string, fn: (...a: A) => Promise<unknown> = async () => undefined) =>
    async (...a: A) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      ops.push(`${name} ${String(a[0]).split(/[\\/]/).pop()}`);
      try {
        return await fn(...a);
      } finally {
        inFlight--;
      }
    };
  const fs = {
    mkdir: wrap('mkdir'),
    readdir: wrap('readdir', async () => []),
    readFile: wrap('readFile', async () => ''),
    rename: wrap('rename'),
    unlink: wrap('unlink'),
    writeFile: wrap('writeFile', async () => gate),
  } as unknown as SpoolFs;
  return { fs, ops, max: () => maxInFlight };
}

function fakeRepo() {
  const inserted: string[] = [];
  const repo = { insertCdrs: async (b: PendingCdr[]) => void inserted.push(...b.map((c) => c.id)) } as unknown as Repo;
  return { repo, inserted };
}

describe('CdrWriter spool never blocks calls (incident 2026-11-25)', () => {
  it('submit returns and Postgres inserts continue while the spool disk is frozen', async () => {
    const gate = deferred();
    const { fs, max } = fakeFs(gate.p);
    const { repo, inserted } = fakeRepo();
    const w = new CdrWriter('/spool', repo, async () => DEFAULT_CALL_PRICING, log, 5, fs);
    await w.start();

    for (let i = 0; i < 50; i++) await w.submit(leg(`c${i}`)); // would hang on a frozen disk before the fix
    await tick(50);

    expect(inserted).toHaveLength(50); // DB path unaffected by the stuck disk
    expect(max()).toBe(1); // only one fs call ever in flight: the thread pool stays free
    expect(w.spoolPending).toBeGreaterThan(0);

    gate.release();
    await w.drain();
    expect(w.spoolPending).toBe(0);
    w.stop();
  });

  it('skips spooling legs that reached Postgres first, and unlinks the ones it wrote', async () => {
    const gate = deferred();
    const { fs, ops } = fakeFs(gate.p);
    const { repo } = fakeRepo();
    const w = new CdrWriter('/spool', repo, async () => DEFAULT_CALL_PRICING, log, 5, fs);
    await w.start();

    await w.submit(leg('a')); // its write hangs on the gate...
    await w.submit(leg('b'));
    await tick(50); // ...while both legs are inserted
    gate.release();
    await w.drain();
    w.stop();

    const spoolOps = ops.filter((o) => !o.startsWith('mkdir') && !o.startsWith('readdir'));
    // a: written (it was already in flight), renamed, then unlinked. b: never written, nothing to unlink.
    expect(spoolOps).toEqual(['writeFile a.cdr.json.tmp', 'rename a.cdr.json.tmp', 'unlink a.cdr.json']);
  });

  it('replays spooled legs at start and removes their files after the insert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cdr-'));
    try {
      await writeFile(join(dir, 'old.cdr.json'), JSON.stringify({ id: 'old' }));
      const { repo, inserted } = fakeRepo();
      const w = new CdrWriter(dir, repo, async () => DEFAULT_CALL_PRICING, log, 5);
      await w.start();
      await w.submit(leg('new'));
      await w.drain();
      w.stop();
      expect(inserted.sort()).toEqual(['new', 'old']);
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MediaCache on a slow disk / object store (incident 2026-11-25)', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const repo = { getMediaObjectKey: async () => 'k/x' } as unknown as Repo;

  it('a cached greeting is served from memory with no file I/O', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snd-'));
    await writeFile(join(dir, 'm1.wav'), 'x');
    const store = { getToFile: async () => { throw new Error('should not download'); } };
    const m = new MediaCache(dir, repo, store, log);
    expect(await m.soundUri('t', 'm1')).toBe(`sound:${join(dir, 'm1')}`);
    await unlink(join(dir, 'm1.wav')); // a second lookup that touched the disk would now fail
    expect(await m.soundUri('t', 'm1')).toBe(`sound:${join(dir, 'm1')}`);
  });

  it('gives up after the timeout (caller plays the default) and serves the next call once loaded', async () => {
    dir = await mkdtemp(join(tmpdir(), 'snd-'));
    const gate = deferred();
    let downloads = 0;
    const store = {
      getToFile: async (_k: string, to: string) => {
        downloads++;
        await gate.p;
        await writeFile(to, 'x');
      },
    };
    const m = new MediaCache(dir, repo, store, log, 30);
    const [a, b] = await Promise.all([m.soundUri('t', 'm2'), m.objectUri('m2', 'k/x')]);
    expect([a, b]).toEqual([null, null]); // nobody waits longer than 30 ms
    expect(downloads).toBe(1); // concurrent callers share one lookup
    gate.release();
    await tick(50);
    expect(await m.soundUri('t', 'm2')).toBe(`sound:${join(dir, 'm2')}`);
    expect(downloads).toBe(1);
  });
});
