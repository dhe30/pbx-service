import multipart from '@fastify/multipart';
import { mediaObjectKey, withRetry, type Db, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AudioConverter } from '../audio.js';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { RangeNotSatisfiable, type MediaStore } from '../object-store.js';
import { IN_USE, withDoc } from '../openapi/document.js';
import { refuseIfUsed, usages, type Usage } from '../references.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';

// Media (backend step 6): greeting upload, listing, audio download, delete. Owner-only.
//
// POST   /media              201 media     400 invalid_audio, 413 too large, 415 wrong content type
// GET    /media?kind=        200 [media]   newest first
// GET    /media/:id          200 media     404
// GET    /media/:id/audio    200|206 WAV   404, 416       (streams from the object store; Range supported)
// DELETE /media/:id          204           404, 409 in_use (a greeting used by an IVR menu or mailbox)
//
// media = { id, kind, format, durationMs, callId, createdAt, audioUrl }
//
// Uploads are converted to 16-bit PCM mono 8 kHz WAV (what Asterisk plays, docs/telephony-contract.md
// §5) and stored at tenants/<tenant>/greeting/<id>.wav. Media is immutable: to change a greeting,
// upload a new one and point the menu/mailbox at it (the ARI app caches files by media id).
// Recordings and voicemails are written by the ARI app; they are listed and served here too.
//
// Audio is streamed through the API instead of handing out presigned URLs: the object store is
// on the private network, so its URLs don't open in a browser, and the API checks the tenant.

/** Upload size limit (a few minutes of CD-quality WAV). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Longest greeting accepted, after conversion. */
export const MAX_GREETING_SEC = 300;

const MEDIA_KINDS = ['greeting', 'recording', 'voicemail'] as const;

const MediaSchema = z
  .object({
    id: z.string().uuid().describe('Media id. Use it as greetingMediaId of an IVR menu or mailbox (kind greeting only).'),
    kind: z.enum(MEDIA_KINDS).describe('greeting: uploaded via POST /media. recording / voicemail: recorded by the phone system.'),
    format: z.string().describe('Always "wav": 16-bit PCM, mono, 8 kHz.'),
    durationMs: z.number().int().nullable().describe('Length in milliseconds; null if unknown.'),
    callId: z.string().uuid().nullable().describe('For recordings and voicemails: the call (cdrs.callId) it belongs to. null for greetings.'),
    createdAt: z.string().datetime().describe('When it was stored (ISO 8601).'),
    audioUrl: z.string().describe('Relative URL of the audio (GET /media/{id}/audio), usable as <audio src>.'),
  })
  .describe('An audio file.');

const ListQuery = z.object({
  kind: z.enum(MEDIA_KINDS).optional().describe('Only media of this kind. Omitted = all kinds.'),
});

interface MediaRow {
  id: string;
  kind: (typeof MEDIA_KINDS)[number];
  format: string;
  durationMs: number | null;
  callId: string | null;
  createdAt: Date;
}

const view = (m: MediaRow) => ({
  id: m.id,
  kind: m.kind,
  format: m.format,
  durationMs: m.durationMs,
  callId: m.callId,
  createdAt: m.createdAt,
  audioUrl: `/media/${m.id}/audio`,
});

const notFound = () => new HttpError(404, 'not_found', 'No such media');

/** One `bytes=` range (what browsers send for <audio>). Anything else is ignored: full file. */
const SINGLE_RANGE = /^bytes=(\d+-\d*|-\d+)$/;

/** IVR menus and mailboxes that play this greeting. */
async function greetingUsages(db: Db, tenantId: string, mediaId: string): Promise<Usage[]> {
  const [menus, boxes] = await Promise.all([
    db<{ name: string }[]>`
      select name from ivr_menus where tenant_id = ${tenantId} and greeting_media_id = ${mediaId} order by name, id`,
    db<{ name: string }[]>`
      select name from mailboxes where tenant_id = ${tenantId} and greeting_media_id = ${mediaId} order by name, id`,
  ]);
  return [...usages('IVR menu', menus.map((r) => r.name)), ...usages('mailbox', boxes.map((r) => r.name))];
}

export const mediaRoutes: FastifyPluginAsync<{ sql: Sql; store: MediaStore; audio: AudioConverter }> = async (
  app,
  { sql, store, audio },
) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  // Upload bodies: raw audio bytes, or multipart/form-data (an HTML form / FormData). Both parsers
  // are registered in this plugin only, so every other route still accepts JSON only.
  const raw = { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES } as const;
  const keep = (_req: unknown, body: string | Buffer, done: (err: null, body: Buffer) => void) => done(null, body as Buffer);
  app.addContentTypeParser(/^audio\//, raw, keep);
  app.addContentTypeParser('application/octet-stream', raw, keep);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 } });

  async function readUpload(req: FastifyRequest): Promise<Buffer> {
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, 'invalid_request', 'file: the multipart body has no file');
      return file.toBuffer(); // 413 FST_REQ_FILE_TOO_LARGE above MAX_UPLOAD_BYTES
    }
    if (!Buffer.isBuffer(req.body)) {
      throw new HttpError(
        400,
        'invalid_request',
        'Send the audio file as the body (Content-Type audio/* or application/octet-stream) or as multipart/form-data field "file"',
      );
    }
    return req.body;
  }

  app.post(
    '/media',
    withDoc(
      // Auth runs on onRequest (before the body is read), so anonymous clients can't make us buffer uploads.
      { onRequest: [authenticate, requireRole('owner')], bodyLimit: MAX_UPLOAD_BYTES },
      {
        tag: 'Media',
        auth: 'owner',
        summary: 'Upload a greeting',
        description:
          `Uploads an audio file (WAV, MP3, Ogg/Opus, FLAC, M4A/MP4, WebM, AAC, AIFF; up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, ` +
          `${MAX_GREETING_SEC} seconds) and stores it as a greeting, converted to 8 kHz mono WAV. Use the returned id as ` +
          '`greetingMediaId` of an IVR menu or mailbox. Media can\'t be changed: upload a new file and switch the menu ' +
          'or mailbox to it.',
        upload: {
          description: 'The audio file.',
          contentTypes: ['audio/*', 'application/octet-stream'],
          multipartField: 'file',
        },
        responses: { 201: { description: 'The stored greeting', schema: MediaSchema } },
        errors: {
          400: 'Not an audio file, empty, or too long (`invalid_audio`), or no file in the body (`invalid_request`).',
          413: 'The file is larger than the upload limit (Fastify code, e.g. `FST_ERR_CTP_BODY_TOO_LARGE`).',
          415: 'Content-Type is not audio/*, application/octet-stream or multipart/form-data (`FST_ERR_CTP_INVALID_MEDIA_TYPE`). JSON and text/plain bodies get 400 `invalid_request`.',
          503: 'Database or object store temporarily unavailable (`unavailable`). Retry after `Retry-After` seconds.',
        },
      },
    ),
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const input = await readUpload(req);
      const { wav, durationMs } = await audio.toPhoneWav(input, MAX_GREETING_SEC);

      // Object first, then the row: a media row never points at a missing file. If the insert
      // fails, the object is removed again (best effort; an orphaned object is harmless).
      const id = randomUUID();
      const key = mediaObjectKey(tenantId, 'greeting', id);
      await store.put(key, wav, 'audio/wav');
      try {
        const [row] = await withRetry(
          () => sql<MediaRow[]>`
            insert into media (id, tenant_id, kind, object_key, format, duration_ms)
            values (${id}, ${tenantId}, 'greeting', ${key}, 'wav', ${durationMs})
            returning id, kind, format, duration_ms, call_id, created_at`,
        );
        return reply.status(201).send(view(row!));
      } catch (err) {
        await store.delete(key).catch((e: unknown) => req.log.warn({ err: e, key }, 'could not remove orphaned media object'));
        throw err;
      }
    },
  );

  app.get(
    '/media',
    withDoc(ownerOnly, {
      tag: 'Media',
      auth: 'owner',
      summary: 'List media',
      description: 'Greetings, recordings and voicemail audio of the account, newest first.',
      query: ListQuery,
      responses: { 200: { description: 'The media', schema: z.array(MediaSchema).describe('The media.') } },
    }),
    async (req) => {
      const { kind } = parse(ListQuery, req.query);
      const rows = await withRetry(
        () => sql<MediaRow[]>`
          select id, kind, format, duration_ms, call_id, created_at from media
           where tenant_id = ${tenantOf(req)} ${kind ? sql`and kind = ${kind}` : sql``}
           order by created_at desc, id`,
      );
      return rows.map(view);
    },
  );

  app.get(
    '/media/:id',
    withDoc(ownerOnly, {
      tag: 'Media',
      auth: 'owner',
      summary: 'Get media details',
      params: IdParams,
      responses: { 200: { description: 'The media', schema: MediaSchema } },
      errors: { 404: 'No such media in this account (`not_found`).' },
    }),
    async (req) => {
      const { id } = parse(IdParams, req.params);
      const [row] = await withRetry(
        () => sql<MediaRow[]>`
          select id, kind, format, duration_ms, call_id, created_at from media
           where id = ${id} and tenant_id = ${tenantOf(req)}`,
      );
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.get(
    '/media/:id/audio',
    withDoc(ownerOnly, {
      tag: 'Media',
      auth: 'owner',
      summary: 'Download the audio',
      description:
        'The WAV file (16-bit PCM, mono, 8 kHz). Works as `<audio src>` in the dashboard (same origin, cookie sent). ' +
        'Supports a single `Range: bytes=...` for seeking.',
      params: IdParams,
      headers: { Range: { description: 'Optional single byte range, e.g. `bytes=0-1023`. Other forms are ignored.' } },
      responses: {
        200: {
          description: 'The whole file',
          binary: 'audio/wav',
          headers: { 'Content-Length': 'File size in bytes.', 'Accept-Ranges': 'Always `bytes`.' },
        },
        206: {
          description: 'The requested range',
          binary: 'audio/wav',
          headers: { 'Content-Range': '`bytes <first>-<last>/<total>`.' },
        },
      },
      errors: {
        404: 'No such media in this account, or its file is missing (`not_found`).',
        416: 'The range is outside the file (`range_not_satisfiable`).',
        503: 'Database or object store temporarily unavailable (`unavailable`). Retry after `Retry-After` seconds.',
      },
    }),
    async (req, reply) => {
      const { id } = parse(IdParams, req.params);
      const [row] = await withRetry(
        () => sql<{ objectKey: string }[]>`
          select object_key from media where id = ${id} and tenant_id = ${tenantOf(req)}`,
      );
      if (!row) throw notFound();

      const header = req.headers.range;
      const range = header && SINGLE_RANGE.test(header) ? header : undefined;
      let obj;
      try {
        obj = await store.get(row.objectKey, range);
      } catch (err) {
        if (err instanceof RangeNotSatisfiable) {
          throw new HttpError(416, 'range_not_satisfiable', `Range ${range} is outside the file`);
        }
        throw err;
      }
      if (!obj) {
        // The row exists but the file doesn't: lost data (or an upload still in flight). Log loudly.
        req.log.error({ mediaId: id, key: row.objectKey }, 'media object missing from the object store');
        throw new HttpError(404, 'not_found', 'The audio file is missing');
      }

      reply
        .header('content-type', 'audio/wav')
        .header('accept-ranges', 'bytes')
        // Media never changes (a new upload gets a new id), so the browser may keep it.
        .header('cache-control', 'private, max-age=86400, immutable')
        .header('content-disposition', `inline; filename="${id}.wav"`);
      if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
      if (range && obj.contentRange) reply.status(206).header('content-range', obj.contentRange);
      return reply.send(obj.body);
    },
  );

  app.delete(
    '/media/:id',
    withDoc(ownerOnly, {
      tag: 'Media',
      auth: 'owner',
      summary: 'Delete media',
      description:
        'Deletes the file. A greeting still used by an IVR menu or mailbox is refused. Deleting a voicemail\'s ' +
        'audio deletes that voicemail; deleting a recording removes it from call history.',
      params: IdParams,
      responses: { 204: { description: 'Deleted' } },
      errors: {
        404: 'No such media in this account (`not_found`).',
        409: `${IN_USE} (IVR menus and mailboxes playing this greeting).`,
      },
    }),
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { id } = parse(IdParams, req.params);
      const key = await withRetry(() =>
        sql.begin(async (tx) => {
          // FOR UPDATE + the FOR SHARE in assertGreeting(): a menu/mailbox save racing this delete
          // either sees the row gone or is seen here (src/references.ts).
          const [row] = await tx<{ kind: MediaRow['kind']; objectKey: string }[]>`
            select kind, object_key from media where id = ${id} and tenant_id = ${tenantId} for update`;
          if (!row) throw notFound();
          // The foreign keys would set greeting_media_id to NULL: the menu would silently switch
          // to the default prompt. Refuse instead, like other deletes call routing depends on.
          if (row.kind === 'greeting') refuseIfUsed(await greetingUsages(tx, tenantId, id));
          await tx`delete from media where id = ${id} and tenant_id = ${tenantId}`;
          return row.objectKey;
        }),
      );
      // After the commit. If this fails the file stays behind unreferenced: harmless, logged.
      await store.delete(key).catch((err: unknown) => req.log.warn({ err, key }, 'could not delete media object'));
      return reply.status(204).send();
    },
  );
};
