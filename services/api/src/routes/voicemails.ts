import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audioDoc, deleteObjects, sendAudio } from '../audio-response.js';
import { authenticate } from '../auth.js';
import { HttpError } from '../errors.js';
import type { MediaStore } from '../object-store.js';
import { withDoc } from '../openapi/document.js';
import { PageQuery, decodeCursor, page } from '../paging.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';
import { visibleMailboxes } from '../visibility.js';

// Voicemail inbox (backend step 7). The ARI app files messages (voicemails + media rows,
// docs/telephony-contract.md §5); the web and *98 share the state:
//   heard=false is "new", heard=true is "saved"; delete removes the message.
// Any logged-in user; staff see only their mailboxes (src/visibility.ts).
//
// GET    /voicemails?mailboxId&heard&limit&cursor   200 { items: [voicemail], nextCursor }
// GET    /voicemails/:id                            200 voicemail    404
// PATCH  /voicemails/:id { heard }                  200 voicemail    400, 404
// DELETE /voicemails/:id                            204              404
// GET    /voicemails/:id/audio                      200|206 WAV      404, 416

const ListQuery = z.object({
  mailboxId: z.string().uuid().optional().describe('Only this mailbox.'),
  heard: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
    .describe('false = new messages only, true = saved (heard) only. Omitted = both.'),
  ...PageQuery,
});

const PatchBody = z
  .object({ heard: z.boolean().describe('true = mark heard ("saved"), false = mark new again.') })
  .strict()
  .describe('Change a message\'s state.');

const VoicemailSchema = z
  .object({
    id: z.string().uuid().describe('Voicemail id.'),
    mailboxId: z.string().uuid().describe('Mailbox it was left in.'),
    mailboxName: z.string().describe('Name of that mailbox.'),
    callerNumber: z.string().nullable().describe('Who left it (E.164 or extension number); null if unknown.'),
    callId: z.string().uuid().nullable().describe('The call it was left on (GET /calls/{callId}); the call may appear a moment later.'),
    heard: z.boolean().describe('false = new, true = saved (heard). Shared with *98 voicemail access by phone.'),
    durationMs: z.number().int().nullable().describe('Length in milliseconds; null if unknown.'),
    createdAt: z.string().datetime().describe('When it was left (ISO 8601).'),
    audioUrl: z.string().describe('Relative URL of the audio (GET /voicemails/{id}/audio), usable as <audio src>.'),
  })
  .describe('A voicemail message.');

const PageSchema = z
  .object({
    items: z.array(VoicemailSchema).describe('Messages, newest first.'),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page.'),
  })
  .describe('A page of voicemails.');

interface VoicemailRow {
  id: string;
  mailboxId: string;
  mailboxName: string;
  callerNumber: string | null;
  callId: string | null;
  heard: boolean;
  durationMs: number | null;
  createdAt: Date;
  cursorTs: string;
}

const view = ({ cursorTs: _c, ...v }: VoicemailRow) => ({ ...v, audioUrl: `/voicemails/${v.id}/audio` });

const notFound = () => new HttpError(404, 'not_found', 'No such voicemail');
const NOT_FOUND_DOC = 'No such voicemail in this account, or not in one of your mailboxes (`not_found`).';

export const voicemailRoutes: FastifyPluginAsync<{ sql: Sql; store: MediaStore }> = async (app, { sql, store }) => {
  const anyUser = { preHandler: [authenticate] };

  const columns = sql`
    v.id, v.mailbox_id, mb.name as mailbox_name, v.caller_number, v.call_id, v.heard,
    m.duration_ms, v.created_at,
    to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts`;
  const from = sql`
    voicemails v
    join mailboxes mb on mb.id = v.mailbox_id
    join media m on m.id = v.media_id`;
  const scope = (boxes: string[] | null) => (boxes ? sql`and v.mailbox_id = any(${boxes}::uuid[])` : sql``);

  async function getOne(tenantId: string, id: string, boxes: string[] | null): Promise<VoicemailRow> {
    const [row] = await withRetry(
      () => sql<VoicemailRow[]>`
        select ${columns} from ${from} where v.id = ${id} and v.tenant_id = ${tenantId} ${scope(boxes)}`,
    );
    if (!row) throw notFound();
    return row;
  }

  app.get(
    '/voicemails',
    withDoc(anyUser, {
      tag: 'Voicemail',
      auth: 'user',
      summary: 'List voicemails',
      description:
        'Voicemail messages, newest first. The owner sees every mailbox; staff see mailboxes they own and their ' +
        "extensions' mailboxes. Paged with `cursor` / `nextCursor`.",
      query: ListQuery,
      responses: { 200: { description: 'A page of voicemails', schema: PageSchema } },
    }),
    async (req) => {
      const tenantId = tenantOf(req);
      const q = parse(ListQuery, req.query);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const boxes = await visibleMailboxes(sql, req.auth!);
      const rows = await withRetry(
        () => sql<VoicemailRow[]>`
          select ${columns} from ${from}
           where v.tenant_id = ${tenantId} ${scope(boxes)}
             ${q.mailboxId ? sql`and v.mailbox_id = ${q.mailboxId}` : sql``}
             ${q.heard !== undefined ? sql`and v.heard = ${q.heard}` : sql``}
             ${cursor ? sql`and (v.created_at, v.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : sql``}
           order by v.created_at desc, v.id desc
           limit ${q.limit + 1}`,
      );
      const { rows: items, nextCursor } = page(rows, q.limit);
      return { items: items.map(view), nextCursor };
    },
  );

  app.get(
    '/voicemails/:id',
    withDoc(anyUser, {
      tag: 'Voicemail',
      auth: 'user',
      summary: 'Get a voicemail',
      params: IdParams,
      responses: { 200: { description: 'The voicemail', schema: VoicemailSchema } },
      errors: { 404: NOT_FOUND_DOC },
    }),
    async (req) => {
      const { id } = parse(IdParams, req.params);
      return view(await getOne(tenantOf(req), id, await visibleMailboxes(sql, req.auth!)));
    },
  );

  app.patch(
    '/voicemails/:id',
    withDoc(anyUser, {
      tag: 'Voicemail',
      auth: 'user',
      summary: 'Mark a voicemail heard or new',
      description: 'heard=true is "saved" in the phone menu (*98), heard=false is "new". Both see the change at once.',
      params: IdParams,
      body: PatchBody,
      responses: { 200: { description: 'The updated voicemail', schema: VoicemailSchema } },
      errors: { 404: NOT_FOUND_DOC },
    }),
    async (req) => {
      const tenantId = tenantOf(req);
      const { id } = parse(IdParams, req.params);
      const { heard } = parse(PatchBody, req.body);
      const boxes = await visibleMailboxes(sql, req.auth!);
      const updated = await withRetry(
        () => sql`
          update voicemails v set heard = ${heard}
           where v.id = ${id} and v.tenant_id = ${tenantId} ${scope(boxes)}
          returning v.id`,
      );
      if (updated.length === 0) throw notFound();
      return view(await getOne(tenantId, id, boxes));
    },
  );

  app.delete(
    '/voicemails/:id',
    withDoc(anyUser, {
      tag: 'Voicemail',
      auth: 'user',
      summary: 'Delete a voicemail',
      description: 'Deletes the message and its audio, like key 3 in the phone menu (*98).',
      params: IdParams,
      responses: { 204: { description: 'Deleted' } },
      errors: { 404: NOT_FOUND_DOC },
    }),
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { id } = parse(IdParams, req.params);
      const boxes = await visibleMailboxes(sql, req.auth!);
      // Deleting the media row cascades to the voicemail (voicemails.media_id ON DELETE CASCADE),
      // so message and audio go in one statement. The object goes after the commit.
      const deleted = await withRetry(
        () => sql<{ objectKey: string }[]>`
          delete from media m
           using voicemails v
           where v.id = ${id} and v.tenant_id = ${tenantId} ${scope(boxes)}
             and m.id = v.media_id and m.tenant_id = ${tenantId}
          returning m.object_key`,
      );
      if (deleted.length === 0) throw notFound();
      await deleteObjects(store, deleted.map((d) => d.objectKey), req.log);
      return reply.status(204).send();
    },
  );

  app.get(
    '/voicemails/:id/audio',
    withDoc(
      anyUser,
      audioDoc({
        tag: 'Voicemail',
        auth: 'user',
        summary: 'Play a voicemail',
        description: 'The message audio. Playing it does not mark it heard; use PATCH.',
        params: IdParams,
        notFound: 'No such voicemail in this account, or not in one of your mailboxes.',
      }),
    ),
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { id } = parse(IdParams, req.params);
      const boxes = await visibleMailboxes(sql, req.auth!);
      const [row] = await withRetry(
        () => sql<{ id: string; objectKey: string }[]>`
          select m.id, m.object_key from voicemails v join media m on m.id = v.media_id
           where v.id = ${id} and v.tenant_id = ${tenantId} ${scope(boxes)}`,
      );
      if (!row) throw notFound();
      return sendAudio(req, reply, store, row);
    },
  );
};
