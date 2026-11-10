import type { AnyZodObject } from 'zod';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { RangeNotSatisfiable, type MediaStore } from './object-store.js';
import type { Auth, OperationDoc } from './openapi/document.js';

// Streaming stored audio to the browser, shared by GET /media/:id/audio, /voicemails/:id/audio and
// /calls/:callId/recording. Each route does its own access check first, then calls sendAudio().
// No presigned URLs: the object store is on the private network (docs/backend-step6.md).

/** One `bytes=` range (what browsers send for <audio>). Anything else is ignored: full file. */
const SINGLE_RANGE = /^bytes=(\d+-\d*|-\d+)$/;

/** Streams a stored WAV (Range supported). 404 if the object is missing, 416 for a bad range. */
export async function sendAudio(
  req: FastifyRequest,
  reply: FastifyReply,
  store: MediaStore,
  media: { id: string; objectKey: string },
): Promise<FastifyReply> {
  const header = req.headers.range;
  const range = header && SINGLE_RANGE.test(header) ? header : undefined;
  let obj;
  try {
    obj = await store.get(media.objectKey, range);
  } catch (err) {
    if (err instanceof RangeNotSatisfiable) {
      throw new HttpError(416, 'range_not_satisfiable', `Range ${range} is outside the file`);
    }
    throw err;
  }
  if (!obj) {
    // The row exists but the file doesn't: lost data (or an upload still in flight). Log loudly.
    req.log.error({ mediaId: media.id, key: media.objectKey }, 'media object missing from the object store');
    throw new HttpError(404, 'not_found', 'The audio file is missing');
  }

  reply
    .header('content-type', 'audio/wav')
    .header('accept-ranges', 'bytes')
    // Media never changes (a new upload gets a new id), so the browser may keep it.
    .header('cache-control', 'private, max-age=86400, immutable')
    .header('content-disposition', `inline; filename="${media.id}.wav"`);
  if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
  if (range && obj.contentRange) reply.status(206).header('content-range', obj.contentRange);
  return reply.send(obj.body);
}

/** OpenAPI doc of an audio download route. */
export function audioDoc(o: {
  tag: string;
  auth: Auth;
  summary: string;
  description: string;
  params: AnyZodObject;
  notFound: string;
}): OperationDoc {
  return {
    tag: o.tag,
    auth: o.auth,
    summary: o.summary,
    description:
      `${o.description} 16-bit PCM, mono, 8 kHz WAV. Works as \`<audio src>\` in the dashboard (same origin, ` +
      'cookie sent). Supports a single `Range: bytes=...` for seeking.',
    params: o.params,
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
      404: `${o.notFound} Also when the file itself is missing (\`not_found\`).`,
      416: 'The range is outside the file (`range_not_satisfiable`).',
      503: 'Database or object store temporarily unavailable (`unavailable`). Retry after `Retry-After` seconds.',
    },
  };
}

/**
 * Deletes objects whose media rows were deleted (call after the commit). Failures leave an
 * unreferenced object behind: harmless, logged.
 */
export async function deleteObjects(store: MediaStore, keys: readonly string[], log: FastifyBaseLogger): Promise<void> {
  await Promise.all(
    keys.map((key) => store.delete(key).catch((err: unknown) => log.warn({ err, key }, 'could not delete media object'))),
  );
}
