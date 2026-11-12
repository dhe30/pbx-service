import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audioDoc, sendAudio } from '../audio-response.js';
import { authenticate } from '../auth.js';
import { HttpError } from '../errors.js';
import type { MediaStore } from '../object-store.js';
import { withDoc } from '../openapi/document.js';
import { PageQuery, decodeCursor, page } from '../paging.js';
import { tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';
import { visibleExtensions } from '../visibility.js';

// Call history (backend step 7): search over the CDRs the ARI app writes, one row per leg
// (docs/telephony-contract.md §6). Any logged-in user; staff see only calls of their extensions
// (src/visibility.ts).
//
// GET /calls?from&to&direction&outcome&extension&number&limit&cursor   200 { items: [leg], nextCursor }
// GET /calls/:callId                                                   200 { callId, legs: [leg], recordingUrl }   404
// GET /calls/:callId/recording                                         200|206 WAV                                404, 416
//
// The search query follows the contract's shape exactly, so the indexes in the course-spec
// migration serve it (tenant + started_at keyset, direction / outcome / extension indexes,
// trigram index on the numbers expression).

const DIRECTIONS = ['incoming', 'outgoing', 'internal'] as const;
const OUTCOMES = ['answered', 'busy', 'no_answer', 'failed', 'blocked'] as const;

const SearchQuery = z
  .object({
    from: z.string().datetime({ offset: true }).optional().describe('Only legs that started at or after this time (ISO 8601).'),
    to: z.string().datetime({ offset: true }).optional().describe('Only legs that started before this time (ISO 8601).'),
    direction: z.enum(DIRECTIONS).optional().describe('incoming (PSTN to our number), outgoing (to the PSTN) or internal.'),
    outcome: z.enum(OUTCOMES).optional().describe('Only legs with this outcome.'),
    extension: z
      .string()
      .regex(/^[0-9]{1,8}$/, 'must be an extension number')
      .optional()
      .describe('Only legs from or to this extension number.'),
    number: z
      .string()
      .max(32)
      .transform((s) => s.replace(/[^0-9]/g, ''))
      .refine((s) => s.length > 0, 'must contain digits')
      .optional()
      .describe(
        'Digits appearing anywhere in the calling number, called number or our number (partial match; ' +
          'separators such as "+", "-", "(" are ignored). E.g. "5550123" or "(201) 555".',
      ),
    ...PageQuery,
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to', path: ['from'] });

const CallIdParams = z.object({ callId: z.string().uuid().describe('Call id (`callId` of a leg).') });

const money = (what: string) => z.number().describe(what);
const LegSchema = z
  .object({
    id: z.string().uuid().describe('Leg id.'),
    callId: z.string().uuid().describe('The call this leg belongs to; every leg of one call has the same callId.'),
    parentId: z.string().uuid().nullable().describe('null for the main leg; else the main leg of the call (an extra leg we placed to an external number).'),
    direction: z.enum(DIRECTIONS).describe('incoming, outgoing or internal.'),
    fromNumber: z.string().nullable().describe('Calling number (E.164 for the PSTN, extension number for internal calls).'),
    toNumber: z.string().nullable().describe('Called number, normalized.'),
    did: z.string().nullable().describe('The account number involved: the dialed number for incoming calls, the caller ID used for outgoing.'),
    fromExtension: z
      .string()
      .nullable()
      .describe('Extension NUMBER (e.g. "101", not the extension id) that placed the call; null if none.'),
    toExtension: z
      .string()
      .nullable()
      .describe('Extension NUMBER (e.g. "102", not the extension id) that answered or was rung; null if none.'),
    startedAt: z.string().datetime().describe('When the leg started (ISO 8601).'),
    answeredAt: z.string().datetime().nullable().describe('When it was answered; null if never.'),
    endedAt: z.string().datetime().describe('When it ended.'),
    billableSec: z.number().int().describe('Billed seconds (30 s minimum, then 6 s increments); 0 if not answered.'),
    outcome: z.enum(OUTCOMES).describe('Whether a person answered: answered, busy, no_answer, failed or blocked.'),
    voicemail: z.boolean().describe('The caller reached voicemail (outcome is then no_answer).'),
    vendor: z.enum(['us', 'intl']).nullable().describe('PSTN carrier used for an outgoing leg.'),
    cost: money(
      'What we pay for this leg, in USD: the PSTN vendor (outgoing legs, its rate deck) or the DID provider ' +
        '(incoming toll-free); 0 for internal and other incoming legs.',
    ),
    charge: money('What this leg costs the customer, in USD (0 for free legs and legs covered by included minutes).'),
    includedSec: z.number().int().describe('Included plan US seconds this leg used.'),
    recordingUrl: z
      .string()
      .nullable()
      .describe(
        'Relative URL of the call recording (GET /calls/{callId}/recording). null if the call was not recorded, or ' +
          'its recording is not stored yet: it appears (and is playable) only once uploaded, normally seconds after the call ends.',
      ),
  })
  .describe('One leg of a call (call detail record).');

const SearchResult = z
  .object({
    items: z.array(LegSchema).describe('Legs, newest first.'),
    nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page.'),
  })
  .describe('A page of call history.');

const CallSchema = z
  .object({
    callId: z.string().uuid().describe('Call id.'),
    legs: z.array(LegSchema).describe('The main leg first, then extra legs by start time.'),
    recordingUrl: z
      .string()
      .nullable()
      .describe('Relative URL of the recording; null if not recorded or not stored yet (appears seconds after the call ends).'),
  })
  .describe('One call with all its legs.');

interface LegRow {
  id: string;
  callId: string;
  parentId: string | null;
  direction: (typeof DIRECTIONS)[number];
  fromNumber: string | null;
  toNumber: string | null;
  did: string | null;
  fromExtension: string | null;
  toExtension: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date;
  billableSec: number;
  outcome: (typeof OUTCOMES)[number];
  voicemail: boolean;
  vendor: 'us' | 'intl' | null;
  cost: string; // numeric(12,6) comes back as text
  charge: string;
  includedSec: number;
  hasRecording: boolean;
  cursorTs: string;
}

const recordingUrl = (callId: string) => `/calls/${callId}/recording`;

const view = (r: LegRow) => ({
  id: r.id,
  callId: r.callId,
  parentId: r.parentId,
  direction: r.direction,
  fromNumber: r.fromNumber,
  toNumber: r.toNumber,
  did: r.did,
  fromExtension: r.fromExtension,
  toExtension: r.toExtension,
  startedAt: r.startedAt,
  answeredAt: r.answeredAt,
  endedAt: r.endedAt,
  billableSec: r.billableSec,
  outcome: r.outcome,
  voicemail: r.voicemail,
  vendor: r.vendor,
  cost: Number(r.cost),
  charge: Number(r.charge),
  includedSec: r.includedSec,
  recordingUrl: r.hasRecording ? recordingUrl(r.callId) : null,
});

const notFound = () => new HttpError(404, 'not_found', 'No such call');

export const callRoutes: FastifyPluginAsync<{ sql: Sql; store: MediaStore }> = async (app, { sql, store }) => {
  const anyUser = { preHandler: [authenticate] };

  // Columns of a leg + whether the call has a recording + the keyset cursor timestamp.
  const legColumns = sql`
    id, call_id, parent_id, direction, from_number, to_number, did, from_extension, to_extension,
    started_at, answered_at, ended_at, billable_sec, outcome, voicemail, vendor, cost, charge, included_sec,
    exists (select 1 from media m
             where m.tenant_id = cdrs.tenant_id and m.call_id = cdrs.call_id and m.kind = 'recording') as has_recording,
    to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts`;

  /** Staff: may they see this call? (one of their extensions on any leg) */
  async function canSeeCall(tenantId: string, callId: string, exts: string[] | null): Promise<boolean> {
    const rows = await withRetry(
      () => sql`
        select 1 from cdrs
         where tenant_id = ${tenantId} and call_id = ${callId}
           ${exts ? sql`and (from_extension = any(${exts}::text[]) or to_extension = any(${exts}::text[]))` : sql``}
         limit 1`,
    );
    return rows.length > 0;
  }

  app.get(
    '/calls',
    withDoc(anyUser, {
      tag: 'Calls',
      auth: 'user',
      summary: 'Search call history',
      description:
        'Call legs, newest first, filtered by any combination of time range, direction, outcome, extension and ' +
        'partial number. One row per leg: a call that also rang or was forwarded to external numbers has extra ' +
        'legs with the same `callId` and `parentId` set. Staff see only calls of their own extensions. Paged with ' +
        '`cursor` / `nextCursor`.',
      query: SearchQuery.innerType(),
      responses: { 200: { description: 'A page of legs', schema: SearchResult } },
    }),
    async (req) => {
      const tenantId = tenantOf(req);
      const q = parse(SearchQuery, req.query);
      const cursor = q.cursor ? decodeCursor(q.cursor) : null;
      const exts = await visibleExtensions(sql, req.auth!);
      if (exts && exts.length === 0) return { items: [], nextCursor: null };

      // Same shape as docs/telephony-contract.md §6; the numbers expression must stay exactly as
      // written there, or the trigram index isn't used.
      const rows = await withRetry(
        () => sql<LegRow[]>`
          select ${legColumns} from cdrs
           where tenant_id = ${tenantId}
             ${q.from ? sql`and started_at >= ${q.from}::timestamptz` : sql``}
             ${q.to ? sql`and started_at < ${q.to}::timestamptz` : sql``}
             ${q.direction ? sql`and direction = ${q.direction}` : sql``}
             ${q.outcome ? sql`and outcome = ${q.outcome}` : sql``}
             ${q.extension ? sql`and (from_extension = ${q.extension} or to_extension = ${q.extension})` : sql``}
             ${exts ? sql`and (from_extension = any(${exts}::text[]) or to_extension = any(${exts}::text[]))` : sql``}
             ${
               q.number
                 ? sql`and (coalesce(from_number, '') || ' ' || coalesce(to_number, '') || ' ' || coalesce(did, ''))
                           like '%' || ${q.number} || '%'`
                 : sql``
             }
             ${cursor ? sql`and (started_at, id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : sql``}
           order by started_at desc, id desc
           limit ${q.limit + 1}`,
      );
      const { rows: items, nextCursor } = page(rows, q.limit);
      return { items: items.map(view), nextCursor };
    },
  );

  app.get(
    '/calls/:callId',
    withDoc(anyUser, {
      tag: 'Calls',
      auth: 'user',
      summary: 'Get one call',
      description: 'Every leg of the call and its recording. Staff: only calls of their own extensions.',
      params: CallIdParams,
      responses: { 200: { description: 'The call', schema: CallSchema } },
      errors: { 404: 'No such call in this account, or not one of your extensions\' calls (`not_found`).' },
    }),
    async (req) => {
      const tenantId = tenantOf(req);
      const { callId } = parse(CallIdParams, req.params);
      const exts = await visibleExtensions(sql, req.auth!);
      if (exts && !(await canSeeCall(tenantId, callId, exts))) throw notFound();
      const rows = await withRetry(
        () => sql<LegRow[]>`
          select ${legColumns} from cdrs
           where tenant_id = ${tenantId} and call_id = ${callId}
           order by parent_id nulls first, started_at, id`,
      );
      if (rows.length === 0) throw notFound();
      return {
        callId,
        legs: rows.map(view),
        recordingUrl: rows[0]!.hasRecording ? recordingUrl(callId) : null,
      };
    },
  );

  app.get(
    '/calls/:callId/recording',
    withDoc(
      anyUser,
      audioDoc({
        tag: 'Calls',
        auth: 'user',
        summary: 'Play a call recording',
        description: 'The recording of the call (call recording add-on). Staff: only calls of their own extensions.',
        params: CallIdParams,
        notFound: 'No such call, no recording, or not one of your extensions\' calls.',
      }),
    ),
    async (req, reply) => {
      const tenantId = tenantOf(req);
      const { callId } = parse(CallIdParams, req.params);
      const exts = await visibleExtensions(sql, req.auth!);
      if (exts && !(await canSeeCall(tenantId, callId, exts))) throw notFound();
      // One WAV per conversation; if there were ever several, play the first.
      const [rec] = await withRetry(
        () => sql<{ id: string; objectKey: string }[]>`
          select id, object_key from media
           where tenant_id = ${tenantId} and call_id = ${callId} and kind = 'recording'
           order by created_at, id limit 1`,
      );
      if (!rec) throw new HttpError(404, 'not_found', 'This call has no recording');
      return sendAudio(req, reply, store, rec);
    },
  );
};
