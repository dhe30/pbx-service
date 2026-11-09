import { withRetry, type Db, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { assertGreeting, destinationUsages, refuseIfUsed } from '../references.js';
import { IdParams, assertOwned, tenantOf, type Ref } from '../tenancy.js';
import { name, nullableId, parse } from '../validation.js';

// Voicemail boxes (backend step 5). All routes are owner-only.
//
// GET    /mailboxes        200 [mailbox]        sorted by name
// GET    /mailboxes/:id    200 mailbox          404
// POST   /mailboxes        201 mailbox          400
// PUT    /mailboxes/:id    200 mailbox          400, 404   (full replace: omitted fields reset)
// DELETE /mailboxes/:id    204                  404, 409 in_use (a voicemail destination or an extension's mailbox)
//
// mailbox = { id, name, greetingMediaId, ownerUserId }
// ownerUserId: whose mailbox it is (display only). The call path uses extensions.mailbox_id as an
// extension's no-answer fallback and for *98. Deleting a mailbox deletes its voicemails (foreign
// key cascade).

const MailboxBody = z.object({
  name,
  greetingMediaId: nullableId,
  ownerUserId: nullableId,
});
type MailboxBody = z.infer<typeof MailboxBody>;

interface Mailbox {
  id: string;
  name: string;
  greetingMediaId: string | null;
  ownerUserId: string | null;
}

async function checkRefs(tx: Db, tenantId: string, body: MailboxBody): Promise<void> {
  const refs: Ref[] = body.ownerUserId ? [{ table: 'users', id: body.ownerUserId, field: 'ownerUserId' }] : [];
  await assertOwned(tx, tenantId, refs);
  await assertGreeting(tx, tenantId, body.greetingMediaId, 'greetingMediaId');
}

const notFound = () => new HttpError(404, 'not_found', 'No such mailbox');

export const mailboxRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/mailboxes', ownerOnly, async (req) => {
    return withRetry(
      () => sql<Mailbox[]>`
        select id, name, greeting_media_id, owner_user_id from mailboxes
         where tenant_id = ${tenantOf(req)}
         order by name, id`,
    );
  });

  app.get('/mailboxes/:id', ownerOnly, async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(
      () => sql<Mailbox[]>`
        select id, name, greeting_media_id, owner_user_id from mailboxes
         where id = ${id} and tenant_id = ${tenantOf(req)}`,
    );
    if (!row) throw notFound();
    return row;
  });

  app.post('/mailboxes', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(MailboxBody, req.body);
    const row = await withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [created] = await tx<Mailbox[]>`
          insert into mailboxes (tenant_id, name, greeting_media_id, owner_user_id)
          values (${tenantId}, ${body.name}, ${body.greetingMediaId}, ${body.ownerUserId})
          returning id, name, greeting_media_id, owner_user_id`;
        return created!;
      }),
    );
    return reply.status(201).send(row);
  });

  app.put('/mailboxes/:id', ownerOnly, async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(MailboxBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [updated] = await tx<Mailbox[]>`
          update mailboxes
             set name = ${body.name}, greeting_media_id = ${body.greetingMediaId},
                 owner_user_id = ${body.ownerUserId}
           where id = ${id} and tenant_id = ${tenantId}
          returning id, name, greeting_media_id, owner_user_id`;
        if (!updated) throw notFound();
        return updated;
      }),
    );
  });

  app.delete('/mailboxes/:id', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [row] = await tx`select 1 from mailboxes where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!row) throw notFound();
        // Voicemail destinations (IVR, ring group no-answer, numbers, business hours) and
        // extensions.mailbox_id (an extension's no-answer fallback; the foreign key would set it to
        // NULL) would silently turn "go to voicemail" into "hang up". Refuse instead.
        refuseIfUsed(await destinationUsages(tx, tenantId, 'voicemail', id));
        await tx`delete from mailboxes where id = ${id} and tenant_id = ${tenantId}`;
      }),
    );
    return reply.status(204).send();
  });
};
