import { IvrConfigSchema, withRetry, type Db, type IvrConfig, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { assertGreeting, destinationUsages, refuseIfUsed } from '../references.js';
import { IdParams, assertOwned, ivrConfigRefs, tenantOf } from '../tenancy.js';
import { name, nullableId, parse } from '../validation.js';
import { IN_USE, crudDocs, withDoc } from '../openapi/document.js';

// IVR menus: what a caller hears and which digit goes where (backend step 5). Owner-only.
//
// GET    /ivr-menus        200 [ivrMenu]     sorted by name
// GET    /ivr-menus/:id    200 ivrMenu       404
// POST   /ivr-menus        201 ivrMenu       400
// PUT    /ivr-menus/:id    200 ivrMenu       400, 404   (full replace: omitted fields reset)
// DELETE /ivr-menus/:id    204               404, 409 in_use (anything routing to it)
//
// ivrMenu = { id, name, greetingMediaId, timeoutSec, maxRetries, config }
// config  = { options: { "<digit>": Destination }, timeout?: Destination, invalid?: Destination,
//             repeat_digit?: "<digit>" }
//   (IvrConfigSchema in services/shared, the same schema the ARI app reads it with; keys stay
//    snake_case because the ARI app reads this JSON as stored)
//   Destination = {"type": extension|ring_group|ivr_menu|voicemail|business_hours, "id"}
//               | {"type":"external","number":"+E.164"} | {"type":"hangup"}
// Semantics (timeout, invalid input, repeat): docs/telephony-contract.md §3. The phase-1 format
// ({action, target}, on_timeout) is still accepted on input and stored in the new format.

/**
 * Phase-1 `{action: "user", target}` pointed at a user, and users no longer ring (extensions do).
 * The shared parser maps it to `{type: "hangup"}` (right for old rows the ARI app reads), but
 * storing that silently would change what the owner asked for, so new input gets a 400.
 */
function rejectLegacyUserTargets(config: unknown, ctx: z.RefinementCtx): void {
  if (typeof config !== 'object' || config === null) return;
  const c = config as Record<string, unknown>;
  const check = (value: unknown, path: (string | number)[]) => {
    if (typeof value === 'object' && value !== null && (value as { action?: unknown }).action === 'user') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: 'phase-1 {"action":"user"} is no longer supported; use {"type":"extension","id":"<extension id>"}',
      });
    }
  };
  if (typeof c.options === 'object' && c.options !== null) {
    for (const [digit, v] of Object.entries(c.options)) check(v, ['options', digit]);
  }
  for (const key of ['timeout', 'invalid', 'on_timeout']) check(c[key], [key]);
}

const IvrConfigInput = z
  .unknown()
  .transform((v) => v ?? { options: {} })
  .superRefine(rejectLegacyUserTargets)
  .pipe(IvrConfigSchema);

const IvrMenuBody = z.object({
  name,
  greetingMediaId: nullableId.describe('Greeting played before waiting for a key (media of kind greeting). null = none.'),
  // Same bounds as the CHECK constraints on ivr_menus.
  timeoutSec: z.number().int().min(1).max(30).default(5).describe('Seconds to wait for a key after the greeting.'),
  maxRetries: z.number().int().min(1).max(10).default(3).describe('Plays without a valid key before going to config.timeout.'),
  config: IvrConfigInput.describe('What each key does. Omitted: no keys.'),
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
  await assertGreeting(tx, tenantId, body.greetingMediaId, 'greetingMediaId');
}

const IvrMenuSchema = z
  .object({
    id: z.string().uuid().describe('IVR menu id.'),
    name: z.string().describe('Display name.'),
    greetingMediaId: z.string().uuid().nullable().describe('Greeting played before waiting for a key; null = none.'),
    timeoutSec: z.number().int().describe('Seconds to wait for a key after the greeting.'),
    maxRetries: z.number().int().describe('Plays without a valid key before the timeout destination.'),
    config: IvrConfigInput.describe('What each key does.'),
  })
  .describe('An IVR (auto-attendant) menu.');

const docs = crudDocs({
  tag: 'IVR menus',
  noun: 'IVR menu',
  plural: 'IVR menus',
  schema: IvrMenuSchema,
  body: IvrMenuBody,
  params: IdParams,
  listOrder: 'sorted by name',
  deleteErrors: { 409: `${IN_USE} (numbers, other menus, ring groups, business hours).` },
});

export const ivrMenuRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };
  const cols = sql.unsafe(COLUMNS); // fixed string, no user input

  app.get('/ivr-menus', withDoc(ownerOnly, docs.list), async (req) => {
    return withRetry(
      () => sql<IvrMenu[]>`
        select ${cols} from ivr_menus where tenant_id = ${tenantOf(req)} order by name, id`,
    );
  });

  app.get('/ivr-menus/:id', withDoc(ownerOnly, docs.get), async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(
      () => sql<IvrMenu[]>`select ${cols} from ivr_menus where id = ${id} and tenant_id = ${tenantOf(req)}`,
    );
    if (!row) throw notFound();
    return row;
  });

  app.post('/ivr-menus', withDoc(ownerOnly, docs.create), async (req, reply) => {
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

  app.put('/ivr-menus/:id', withDoc(ownerOnly, docs.replace), async (req) => {
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

  app.delete('/ivr-menus/:id', withDoc(ownerOnly, docs.remove), async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [row] = await tx`select 1 from ivr_menus where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!row) throw notFound();
        // Numbers, other menus (sub-menus), ring groups or business hours may route here; the ARI
        // app hangs up on calls whose destination is gone. Refuse; route them elsewhere first.
        refuseIfUsed(await destinationUsages(tx, tenantId, 'ivr_menu', id));
        await tx`delete from ivr_menus where id = ${id} and tenant_id = ${tenantId}`;
      }),
    );
    return reply.status(204).send();
  });
};
