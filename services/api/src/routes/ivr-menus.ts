import { IvrConfigSchema, withRetry, type Db, type IvrConfig, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { assertGreeting, assertRingable, refuseIfUsed, usages } from '../references.js';
import { IdParams, assertOwned, ivrConfigRefs, tenantOf } from '../tenancy.js';
import { name, nullableId, parse } from '../validation.js';

// IVR menus: what a caller hears and which digit goes where (backend step 5). Owner-only.
//
// GET    /ivr-menus        200 [ivrMenu]     sorted by name
// GET    /ivr-menus/:id    200 ivrMenu       404
// POST   /ivr-menus        201 ivrMenu       400
// PUT    /ivr-menus/:id    200 ivrMenu       400, 404   (full replace: omitted fields reset)
// DELETE /ivr-menus/:id    204               404, 409 in_use (a phone number routes to it)
//
// ivrMenu = { id, name, greetingMediaId, timeoutSec, maxRetries, config }
// config  = { options: { "<digit>": { action, target } }, on_timeout?: { action, target } }
//   (IvrConfigSchema in services/shared, the same schema the ARI app reads it with; keys stay
//    snake_case because the ARI app reads this JSON as stored)
//   action: "ring_group" -> ring group id, "voicemail" -> mailbox id, "user" -> staff user id.
// The ARI app plays the greeting, waits timeoutSec for a digit, replays up to maxRetries times,
// then runs on_timeout (omitted = hang up).

const IvrMenuBody = z.object({
  name,
  greetingMediaId: nullableId,
  // Same bounds as the CHECK constraints on ivr_menus.
  timeoutSec: z.number().int().min(1).max(30).default(5),
  maxRetries: z.number().int().min(1).max(10).default(3),
  config: IvrConfigSchema.default({ options: {} }),
});
type IvrMenuBody = z.infer<typeof IvrMenuBody>;

interface IvrMenu {
  id: string;
  name: string;
  greetingMediaId: string | null;
  timeoutSec: number;
  maxRetries: number;
  config: IvrConfig;
}

const COLUMNS = 'id, name, greeting_media_id, timeout_sec, max_retries, config';
const notFound = () => new HttpError(404, 'not_found', 'No such IVR menu');

async function checkRefs(tx: Db, tenantId: string, body: IvrMenuBody): Promise<void> {
  const refs = ivrConfigRefs(body.config);
  await assertOwned(tx, tenantId, refs);
  await assertRingable(tx, tenantId, refs); // "user" targets must have a softphone
  await assertGreeting(tx, tenantId, body.greetingMediaId, 'greetingMediaId');
}

export const ivrMenuRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };
  const cols = sql.unsafe(COLUMNS); // fixed string, no user input

  app.get('/ivr-menus', ownerOnly, async (req) => {
    return withRetry(
      () => sql<IvrMenu[]>`
        select ${cols} from ivr_menus where tenant_id = ${tenantOf(req)} order by name, id`,
    );
  });

  app.get('/ivr-menus/:id', ownerOnly, async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(
      () => sql<IvrMenu[]>`select ${cols} from ivr_menus where id = ${id} and tenant_id = ${tenantOf(req)}`,
    );
    if (!row) throw notFound();
    return row;
  });

  app.post('/ivr-menus', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(IvrMenuBody, req.body);
    const row = await withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [created] = await tx<IvrMenu[]>`
          insert into ivr_menus (tenant_id, name, greeting_media_id, timeout_sec, max_retries, config)
          values (${tenantId}, ${body.name}, ${body.greetingMediaId}, ${body.timeoutSec}, ${body.maxRetries},
                  ${tx.json(body.config)})
          returning ${cols}`;
        return created!;
      }),
    );
    return reply.status(201).send(row);
  });

  app.put('/ivr-menus/:id', ownerOnly, async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(IvrMenuBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [updated] = await tx<IvrMenu[]>`
          update ivr_menus
             set name = ${body.name}, greeting_media_id = ${body.greetingMediaId},
                 timeout_sec = ${body.timeoutSec}, max_retries = ${body.maxRetries},
                 config = ${tx.json(body.config)}
           where id = ${id} and tenant_id = ${tenantId}
          returning ${cols}`;
        if (!updated) throw notFound();
        return updated;
      }),
    );
  });

  app.delete('/ivr-menus/:id', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [row] = await tx`select 1 from ivr_menus where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!row) throw notFound();
        // phone_numbers.ivr_menu_id would be set to NULL by the foreign key, and the ARI app
        // hangs up on calls to a number without a menu. Refuse; route the number elsewhere first.
        const numbers = await tx<{ did: string }[]>`
          select did from phone_numbers where tenant_id = ${tenantId} and ivr_menu_id = ${id} order by did`;
        refuseIfUsed(usages('phone number', numbers.map((n) => n.did)));
        await tx`delete from ivr_menus where id = ${id} and tenant_id = ${tenantId}`;
      }),
    );
    return reply.status(204).send();
  });
};
