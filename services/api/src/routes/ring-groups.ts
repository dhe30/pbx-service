import { withRetry, type Db, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { assertRingable, menusUsing, refuseIfUsed, usages } from '../references.js';
import { IdParams, assertOwned, tenantOf, type Ref } from '../tenancy.js';
import { name, nullableId, parse } from '../validation.js';

// Ring groups: who rings when an IVR digit routes to the group (backend step 5). Owner-only.
//
// GET    /ring-groups        200 [ringGroup]     sorted by name
// GET    /ring-groups/:id    200 ringGroup       404
// POST   /ring-groups        201 ringGroup       400
// PUT    /ring-groups/:id    200 ringGroup       400, 404   (full replace, including members)
// DELETE /ring-groups/:id    204                 404, 409 in_use (IVR menu)
//
// ringGroup = { id, name, strategy, ringTimeoutSec, fallbackMailboxId, memberIds }
// strategy 'all' rings every member at once (first answer wins); 'sequential' rings them in
// memberIds order, ringTimeoutSec each. No answer -> fallbackMailboxId (null = hang up).

const RingGroupBody = z.object({
  name,
  strategy: z.enum(['all', 'sequential']).default('all'),
  // Same bounds as the CHECK constraint on ring_groups.ring_timeout_sec.
  ringTimeoutSec: z.number().int().min(5).max(120).default(20),
  fallbackMailboxId: nullableId,
  memberIds: z
    .array(z.string().uuid())
    .max(50)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'must not contain duplicates'),
});
type RingGroupBody = z.infer<typeof RingGroupBody>;

interface RingGroup {
  id: string;
  name: string;
  strategy: 'all' | 'sequential';
  ringTimeoutSec: number;
  fallbackMailboxId: string | null;
  memberIds: string[];
}

const notFound = () => new HttpError(404, 'not_found', 'No such ring group');

/** Ring groups with their members in ring order. `id` null = all of the tenant's groups. */
function selectGroups(db: Db, tenantId: string, id: string | null) {
  return db<RingGroup[]>`
    select rg.id, rg.name, rg.strategy, rg.ring_timeout_sec, rg.fallback_mailbox_id,
           coalesce(array_agg(m.user_id order by m.position, m.user_id)
                      filter (where m.user_id is not null), '{}') as member_ids
      from ring_groups rg
      left join ring_group_members m on m.ring_group_id = rg.id
     where rg.tenant_id = ${tenantId} ${id ? db`and rg.id = ${id}` : db``}
     group by rg.id
     order by rg.name, rg.id`;
}

/** Checks every id the body stores (tenant, members have a softphone). Inside the write transaction. */
async function checkRefs(tx: Db, tenantId: string, body: RingGroupBody): Promise<void> {
  const refs: Ref[] = body.memberIds.map((id, i) => ({ table: 'users', id, field: `memberIds.${i}` }));
  if (body.fallbackMailboxId) {
    refs.push({ table: 'mailboxes', id: body.fallbackMailboxId, field: 'fallbackMailboxId' });
  }
  await assertOwned(tx, tenantId, refs);
  await assertRingable(tx, tenantId, refs);
}

async function replaceMembers(tx: Db, groupId: string, memberIds: readonly string[]): Promise<void> {
  await tx`delete from ring_group_members where ring_group_id = ${groupId}`;
  if (memberIds.length === 0) return;
  const rows = memberIds.map((userId, position) => ({ ringGroupId: groupId, userId, position }));
  await tx`insert into ring_group_members ${tx(rows, 'ringGroupId', 'userId', 'position')}`;
}

export const ringGroupRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/ring-groups', ownerOnly, async (req) => {
    return withRetry(() => selectGroups(sql, tenantOf(req), null));
  });

  app.get('/ring-groups/:id', ownerOnly, async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(() => selectGroups(sql, tenantOf(req), id));
    if (!row) throw notFound();
    return row;
  });

  app.post('/ring-groups', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(RingGroupBody, req.body);
    const row = await withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [created] = await tx<{ id: string }[]>`
          insert into ring_groups (tenant_id, name, strategy, ring_timeout_sec, fallback_mailbox_id)
          values (${tenantId}, ${body.name}, ${body.strategy}, ${body.ringTimeoutSec}, ${body.fallbackMailboxId})
          returning id`;
        await replaceMembers(tx, created!.id, body.memberIds);
        const [group] = await selectGroups(tx, tenantId, created!.id);
        return group!;
      }),
    );
    return reply.status(201).send(row);
  });

  app.put('/ring-groups/:id', ownerOnly, async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(RingGroupBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [updated] = await tx`
          update ring_groups
             set name = ${body.name}, strategy = ${body.strategy}, ring_timeout_sec = ${body.ringTimeoutSec},
                 fallback_mailbox_id = ${body.fallbackMailboxId}
           where id = ${id} and tenant_id = ${tenantId}
          returning id`;
        if (!updated) throw notFound();
        await replaceMembers(tx, id, body.memberIds);
        const [group] = await selectGroups(tx, tenantId, id);
        return group!;
      }),
    );
  });

  app.delete('/ring-groups/:id', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [row] = await tx`select 1 from ring_groups where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!row) throw notFound();
        refuseIfUsed(usages('IVR menu', await menusUsing(tx, tenantId, 'ring_group', id)));
        await tx`delete from ring_groups where id = ${id} and tenant_id = ${tenantId}`; // members cascade
      }),
    );
    return reply.status(204).send();
  });
};
