import { DestinationSchema, withRetry, type Db, type Destination, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { destinationUsages, refuseIfUsed } from '../references.js';
import { IdParams, assertOwned, destinationRefs, tenantOf, type Ref } from '../tenancy.js';
import { name, parse } from '../validation.js';
import { IN_USE, crudDocs, withDoc } from '../openapi/document.js';

// Ring groups: extensions rung together or in order (backend step 5, ported to the course spec
// data model in docs/spec-transition.md). Owner-only.
//
// GET    /ring-groups        200 [ringGroup]     sorted by name
// GET    /ring-groups/:id    200 ringGroup       404
// POST   /ring-groups        201 ringGroup       400
// PUT    /ring-groups/:id    200 ringGroup       400, 404   (full replace, including members)
// DELETE /ring-groups/:id    204                 404, 409 in_use (anything routing to it)
//
// ringGroup = { id, name, strategy, ringTimeoutSec, totalTimeoutSec, noAnswerDestination, memberIds }
// memberIds: EXTENSION ids, in ring order. Each member rings all of its devices and its external
// numbers. strategy 'all' rings every member at once (first answer wins; ringTimeoutSec is the
// total ring time); 'sequential' rings them in memberIds order, ringTimeoutSec each. totalTimeoutSec
// (optional) caps the whole group: the spec's "each for a set time; timeout".
// No answer -> noAnswerDestination (a Destination, docs/telephony-contract.md §3; null = hang up).

const RING_TIMEOUT = 'Seconds each member rings (sequential), or the whole group rings (all). 5-120, default 20.';
const TOTAL_TIMEOUT =
  'Overall timeout of the group in seconds (5-600): once it runs out, ringing stops (a sequential group cuts the ' +
  'current member short and skips the rest) and the call goes to noAnswerDestination. null = no overall timeout: a ' +
  'sequential group rings every member for ringTimeoutSec. For strategy all the group rings min(ringTimeoutSec, totalTimeoutSec).';

const RingGroupBody = z.object({
  name,
  strategy: z.enum(['all', 'sequential']).default('all').describe('all: ring every member at once (first answer wins); sequential: in memberIds order.'),
  // Same bounds as the CHECK constraint on ring_groups.ring_timeout_sec.
  ringTimeoutSec: z.number().int().min(5).max(120).default(20).describe(RING_TIMEOUT),
  // Same bounds as the CHECK constraint on ring_groups.total_timeout_sec.
  totalTimeoutSec: z.number().int().min(5).max(600).nullable().default(null).describe(TOTAL_TIMEOUT),
  noAnswerDestination: DestinationSchema.nullable().default(null).describe('Where the call goes when nobody answers. null = hang up.'),
  memberIds: z
    .array(z.string().uuid().describe('Extension id.'))
    .max(50)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'must not contain duplicates')
    .describe('Member extensions in ring order (no duplicates). Each rings its phones and external numbers.'),
});
type RingGroupBody = z.infer<typeof RingGroupBody>;

interface RingGroup {
  id: string;
  name: string;
  strategy: 'all' | 'sequential';
  ringTimeoutSec: number;
  totalTimeoutSec: number | null;
  noAnswerDestination: Destination | null;
  memberIds: string[];
}

const notFound = () => new HttpError(404, 'not_found', 'No such ring group');

/** Ring groups with their members in ring order. `id` null = all of the tenant's groups. */
function selectGroups(db: Db, tenantId: string, id: string | null) {
  return db<RingGroup[]>`
    select rg.id, rg.name, rg.strategy, rg.ring_timeout_sec, rg.total_timeout_sec, rg.no_answer_destination,
           coalesce(array_agg(m.extension_id order by m.position, m.extension_id)
                      filter (where m.extension_id is not null), '{}') as member_ids
      from ring_groups rg
      left join ring_group_members m on m.ring_group_id = rg.id
     where rg.tenant_id = ${tenantId} ${id ? db`and rg.id = ${id}` : db``}
     group by rg.id
     order by rg.name, rg.id`;
}

/** Checks every id the body stores belongs to the tenant. Inside the write transaction. */
async function checkRefs(tx: Db, tenantId: string, body: RingGroupBody): Promise<void> {
  const refs: Ref[] = body.memberIds.map((id, i) => ({ table: 'extensions', id, field: `memberIds.${i}` }));
  refs.push(...destinationRefs(body.noAnswerDestination, 'noAnswerDestination'));
  await assertOwned(tx, tenantId, refs);
}

async function replaceMembers(tx: Db, groupId: string, memberIds: readonly string[]): Promise<void> {
  await tx`delete from ring_group_members where ring_group_id = ${groupId}`;
  if (memberIds.length === 0) return;
  const rows = memberIds.map((extensionId, position) => ({ ringGroupId: groupId, extensionId, position }));
  await tx`insert into ring_group_members ${tx(rows, 'ringGroupId', 'extensionId', 'position')}`;
}

const destJson = (tx: Db, d: Destination | null) => (d ? tx.json(d) : null);

const RingGroupSchema = z
  .object({
    id: z.string().uuid().describe('Ring group id.'),
    name: z.string().describe('Display name.'),
    strategy: z.enum(['all', 'sequential']).describe('all: ring every member at once; sequential: one after another.'),
    ringTimeoutSec: z.number().int().describe(RING_TIMEOUT),
    totalTimeoutSec: z.number().int().nullable().describe(TOTAL_TIMEOUT),
    noAnswerDestination: DestinationSchema.nullable().describe('Where the call goes when nobody answers; null = hang up.'),
    memberIds: z.array(z.string().uuid().describe('Extension id.')).describe('Member extensions in ring order.'),
  })
  .describe('A ring group.');

const docs = crudDocs({
  tag: 'Ring groups',
  noun: 'ring group',
  plural: 'ring groups',
  schema: RingGroupSchema,
  body: RingGroupBody,
  params: IdParams,
  listOrder: 'sorted by name',
  deleteErrors: { 409: `${IN_USE} (numbers, IVR digits, business hours, other ring groups).` },
});

export const ringGroupRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/ring-groups', withDoc(ownerOnly, docs.list), async (req) => {
    return withRetry(() => selectGroups(sql, tenantOf(req), null));
  });

  app.get('/ring-groups/:id', withDoc(ownerOnly, docs.get), async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(() => selectGroups(sql, tenantOf(req), id));
    if (!row) throw notFound();
    return row;
  });

  app.post('/ring-groups', withDoc(ownerOnly, docs.create), async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(RingGroupBody, req.body);
    const row = await withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [created] = await tx<{ id: string }[]>`
          insert into ring_groups (tenant_id, name, strategy, ring_timeout_sec, total_timeout_sec, no_answer_destination)
          values (${tenantId}, ${body.name}, ${body.strategy}, ${body.ringTimeoutSec}, ${body.totalTimeoutSec},
                  ${destJson(tx, body.noAnswerDestination)})
          returning id`;
        await replaceMembers(tx, created!.id, body.memberIds);
        const [group] = await selectGroups(tx, tenantId, created!.id);
        return group!;
      }),
    );
    return reply.status(201).send(row);
  });

  app.put('/ring-groups/:id', withDoc(ownerOnly, docs.replace), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(RingGroupBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [updated] = await tx`
          update ring_groups
             set name = ${body.name}, strategy = ${body.strategy}, ring_timeout_sec = ${body.ringTimeoutSec},
                 total_timeout_sec = ${body.totalTimeoutSec},
                 no_answer_destination = ${destJson(tx, body.noAnswerDestination)}, fallback_mailbox_id = null
           where id = ${id} and tenant_id = ${tenantId}
          returning id`;
        if (!updated) throw notFound();
        await replaceMembers(tx, id, body.memberIds);
        const [group] = await selectGroups(tx, tenantId, id);
        return group!;
      }),
    );
  });

  app.delete('/ring-groups/:id', withDoc(ownerOnly, docs.remove), async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [row] = await tx`select 1 from ring_groups where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!row) throw notFound();
        refuseIfUsed(await destinationUsages(tx, tenantId, 'ring_group', id));
        await tx`delete from ring_groups where id = ${id} and tenant_id = ${tenantId}`; // members cascade
      }),
    );
    return reply.status(204).send();
  });
};
