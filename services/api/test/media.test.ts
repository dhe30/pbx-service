import { randomUUID } from 'node:crypto';
import { mediaObjectKey, type Sql } from '@pbx/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegConverter, wavDurationMs } from '../src/audio.js';
import { ACCESS_COOKIE } from '../src/auth.js';
import { HttpError } from '../src/errors.js';
import { MemoryStore, build, connectTestDb, hasFfmpeg } from './helpers.js';

// Step 6: greeting upload (ffmpeg conversion), media listing, audio download, delete.

/** A 16-bit PCM WAV with a 440 Hz tone: what a customer might upload (CD-quality stereo by default). */
function toneWav(seconds: number, rate = 44100, channels = 2): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Format fields of a WAV header: [audio format, channels, sample rate, bits per sample]. */
const wavFormat = (wav: Buffer) => [wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)];
const PHONE_WAV = [1, 1, 8000, 16];

function multipartBody(field: string, filename: string, contentType: string, content: Buffer) {
  const boundary = `----pbxtest${randomUUID()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head), content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const ffmpeg = hasFfmpeg();

describe('media routes without a DB', () => {
  it('require login and the owner role', async () => {
    const app = await build();
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    const id = randomUUID();
    const routes = [
      ['GET', '/media'],
      ['GET', `/media/${id}`],
      ['GET', `/media/${id}/audio`],
      ['DELETE', `/media/${id}`],
    ] as const;
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url} anonymous`).toBe(401);
      const res = await app.inject({ method, url, cookies: { [ACCESS_COOKIE]: staff } });
      expect(res.statusCode, `${method} ${url} as staff`).toBe(403);
    }
  });

  it('checks login before reading an upload', async () => {
    const app = await build();
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    const upload = { method: 'POST', url: '/media', payload: toneWav(0.1), headers: { 'content-type': 'audio/wav' } } as const;
    expect((await app.inject(upload)).statusCode).toBe(401);
    expect((await app.inject({ ...upload, cookies: { [ACCESS_COOKIE]: staff } })).statusCode).toBe(403);
  });
});

describe('wavDurationMs', () => {
  it('reads the data chunk of 8 kHz 16-bit mono audio', () => {
    expect(wavDurationMs(toneWav(1.5, 8000, 1))).toBe(1500);
  });

  it('rejects something that is not a WAV file', () => {
    expect(() => wavDurationMs(Buffer.from('hello world, not a wav'))).toThrow();
  });
});

describe.skipIf(!ffmpeg)('FfmpegConverter', () => {
  const conv = new FfmpegConverter();
  const rejectsWith = async (p: Promise<unknown>, code: string, msg: RegExp) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 400, code });
    expect((err as Error).message).toMatch(msg);
  };

  it('converts to 16-bit mono 8 kHz WAV', async () => {
    const { wav, durationMs } = await conv.toPhoneWav(toneWav(1), 10);
    expect(wavFormat(wav)).toEqual(PHONE_WAV);
    expect(wav.toString('ascii', 36, 40)).toBe('data'); // plain 44-byte header, no metadata chunks
    expect(durationMs).toBe(1000);
    expect(wav.length).toBe(44 + 16000);
  });

  it('rejects empty, non-audio and too-long input', async () => {
    await rejectsWith(conv.toPhoneWav(Buffer.alloc(0), 10), 'invalid_audio', /empty/);
    await rejectsWith(conv.toPhoneWav(Buffer.from('definitely not audio'), 10), 'invalid_audio', /Not a supported audio file/);
    await rejectsWith(conv.toPhoneWav(toneWav(3), 2), 'invalid_audio', /longer than 2 seconds/);
  });

  it('refuses playlist formats that would open other files', async () => {
    const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n';
    await rejectsWith(conv.toPhoneWav(Buffer.from(hls), 10), 'invalid_audio', /Not a supported/);
    const concat = "ffconcat version 1.0\nfile '/etc/passwd'\n";
    await rejectsWith(conv.toPhoneWav(Buffer.from(concat), 10), 'invalid_audio', /Not a supported/);
  });

  it('never leaks temp file paths in its message', async () => {
    const err = (await conv.toPhoneWav(Buffer.from('junk'), 10).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/pbx-audio-|\/tmp/);
  });
});

const db = await connectTestDb();

describe.skipIf(!db || !ffmpeg)('media (Postgres + ffmpeg)', () => {
  const sql = db as Sql;
  const store = new MemoryStore();
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  interface Tenant {
    tenantId: string;
    cookies: Record<string, string>;
  }
  let a: Tenant;
  let b: Tenant;

  async function makeTenant(): Promise<Tenant> {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('Media test') returning id`;
    const tenantId = t!.id;
    tenantIds.push(tenantId);
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${tenantId}, ${`owner-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    return {
      tenantId,
      cookies: { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: tenantId, role: 'owner', typ: 'access' }) },
    };
  }

  const call = (t: Tenant, opts: InjectOptions) => app.inject({ ...opts, cookies: t.cookies });
  const upload = (t: Tenant, body: Buffer, contentType = 'audio/wav') =>
    call(t, { method: 'POST', url: '/media', payload: body, headers: { 'content-type': contentType } });
  async function greeting(t: Tenant): Promise<string> {
    const res = await upload(t, toneWav(0.5));
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  beforeAll(async () => {
    app = await build({ sql, store });
    a = await makeTenant();
    b = await makeTenant();
  });

  afterAll(async () => {
    await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('uploads a greeting as raw audio, converted and stored under the tenant', async () => {
    const res = await upload(a, toneWav(1.5));
    expect(res.statusCode).toBe(201);
    const m = res.json();
    expect(m).toEqual({
      id: expect.any(String),
      kind: 'greeting',
      format: 'wav',
      durationMs: 1500,
      callId: null,
      createdAt: expect.any(String),
      audioUrl: `/media/${m.id}/audio`,
    });
    const key = mediaObjectKey(a.tenantId, 'greeting', m.id);
    const [row] = await sql`select object_key, duration_ms from media where id = ${m.id}`;
    expect(row).toEqual({ objectKey: key, durationMs: 1500 });
    const stored = store.objects.get(key)!;
    expect(stored.contentType).toBe('audio/wav');
    expect(wavFormat(stored.body)).toEqual(PHONE_WAV);
  });

  it('accepts multipart/form-data and application/octet-stream', async () => {
    const form = await call(a, { method: 'POST', url: '/media', ...multipartBody('file', 'hello.wav', 'audio/wav', toneWav(0.25)) });
    expect(form.statusCode).toBe(201);
    expect(form.json().durationMs).toBe(250);
    const raw = await upload(a, toneWav(0.25), 'application/octet-stream');
    expect(raw.statusCode).toBe(201);
  });

  it('rejects bad uploads without storing anything', async () => {
    const before = store.objects.size;
    const junk = await upload(a, Buffer.from('not audio at all'));
    expect(junk.statusCode).toBe(400);
    expect(junk.json().error).toBe('invalid_audio');
    const json = await call(a, { method: 'POST', url: '/media', payload: { file: 'x' } });
    expect(json.statusCode).toBe(400);
    expect(json.json().error).toBe('invalid_request');
    const text = await upload(a, Buffer.from('hi'), 'image/png');
    expect(text.statusCode).toBe(415);
    const noFile = await call(a, {
      method: 'POST',
      url: '/media',
      payload: '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--x--\r\n',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(noFile.statusCode).toBe(400);
    expect(store.objects.size).toBe(before);
  });

  it('lists, gets and serves audio, with Range support', async () => {
    const id = await greeting(a);
    const [rec] = await sql<{ id: string }[]>`
      insert into media (tenant_id, kind, object_key, format, duration_ms, call_id)
      values (${a.tenantId}, 'recording', ${`test/${randomUUID()}.wav`}, 'wav', 1000, ${randomUUID()}) returning id`;

    const all = (await call(a, { method: 'GET', url: '/media' })).json() as { id: string }[];
    expect(all.map((m) => m.id)).toEqual(expect.arrayContaining([id, rec!.id]));
    const greetings = (await call(a, { method: 'GET', url: '/media?kind=greeting' })).json() as { kind: string }[];
    expect(greetings.every((m) => m.kind === 'greeting')).toBe(true);
    expect((await call(a, { method: 'GET', url: '/media?kind=bogus' })).statusCode).toBe(400);
    expect((await call(a, { method: 'GET', url: `/media/${id}` })).json()).toMatchObject({ id, kind: 'greeting' });

    const file = store.objects.get(mediaObjectKey(a.tenantId, 'greeting', id))!.body;
    const full = await call(a, { method: 'GET', url: `/media/${id}/audio` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('audio/wav');
    expect(full.headers['content-length']).toBe(String(file.length));
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.rawPayload.equals(file)).toBe(true);

    const part = await call(a, { method: 'GET', url: `/media/${id}/audio`, headers: { range: 'bytes=0-43' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-43/${file.length}`);
    expect(part.rawPayload.equals(file.subarray(0, 44))).toBe(true);

    const bad = await call(a, { method: 'GET', url: `/media/${id}/audio`, headers: { range: `bytes=${file.length + 10}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.json().error).toBe('range_not_satisfiable');
    // Multi-range is not supported: the whole file is sent instead.
    const multi = await call(a, { method: 'GET', url: `/media/${id}/audio`, headers: { range: 'bytes=0-1,4-5' } });
    expect(multi.statusCode).toBe(200);

    // The recording's row exists but its file doesn't.
    const missing = await call(a, { method: 'GET', url: `/media/${rec!.id}/audio` });
    expect(missing.statusCode).toBe(404);
  });

  it("hides other accounts' media", async () => {
    const id = await greeting(a);
    for (const [method, url] of [
      ['GET', `/media/${id}`],
      ['GET', `/media/${id}/audio`],
      ['DELETE', `/media/${id}`],
    ] as const) {
      expect((await call(b, { method, url })).statusCode, `${method} ${url}`).toBe(404);
    }
    const list = (await call(b, { method: 'GET', url: '/media' })).json() as { id: string }[];
    expect(list.map((m) => m.id)).not.toContain(id);
    // Nor can B use it as a greeting.
    const box = await call(b, { method: 'POST', url: '/mailboxes', payload: { name: 'B', greetingMediaId: id } });
    expect(box.statusCode).toBe(400);
    expect(box.json().error).toBe('invalid_reference');
  });

  it('refuses to delete a greeting in use, then deletes it and its file', async () => {
    const id = await greeting(a);
    const box = await call(a, { method: 'POST', url: '/mailboxes', payload: { name: 'Sales VM', greetingMediaId: id } });
    expect(box.statusCode).toBe(201);
    const menu = await call(a, {
      method: 'POST',
      url: '/ivr-menus',
      payload: { name: 'Main', greetingMediaId: id, config: { options: {} } },
    });
    expect(menu.statusCode).toBe(201);

    const refused = await call(a, { method: 'DELETE', url: `/media/${id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'in_use', message: expect.stringContaining('IVR menu "Main"') });
    expect(refused.json().message).toContain('mailbox "Sales VM"');

    await call(a, { method: 'DELETE', url: `/ivr-menus/${menu.json().id}` });
    await call(a, { method: 'PUT', url: `/mailboxes/${box.json().id}`, payload: { name: 'Sales VM', greetingMediaId: null } });
    const key = mediaObjectKey(a.tenantId, 'greeting', id);
    expect(store.objects.has(key)).toBe(true);
    expect((await call(a, { method: 'DELETE', url: `/media/${id}` })).statusCode).toBe(204);
    expect(store.objects.has(key)).toBe(false);
    expect((await call(a, { method: 'GET', url: `/media/${id}` })).statusCode).toBe(404);
  });

  it('answers 503 when the object store is down, and stores no row', async () => {
    const count = async () => (await sql<{ count: number }[]>`select count(*)::int from media where tenant_id = ${a.tenantId}`)[0]!.count;
    const before = await count();
    store.down = true;
    try {
      const res = await upload(a, toneWav(0.2));
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('unavailable');
      expect(res.headers['retry-after']).toBe('2');
    } finally {
      store.down = false;
    }
    expect(await count()).toBe(before);
  });
});
