import {
  DestinationSchema,
  WeeklyScheduleSchema,
  isOpen,
  withRetry,
  type Db,
  type Destination,
  type Sql,
  type WeeklySchedule,
} from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { destinationUsages, refuseIfUsed } from '../references.js';
import { IdParams, assertOwned, destinationRefs, tenantOf } from '../tenancy.js';
import { name, parse } from '../validation.js';
import { IN_USE, crudDocs, withDoc } from '../openapi/document.js';

// Business hours (course spec §3: "Weekly schedule in the account's time zone; open and closed
// destinations"). A phone number, IVR digit, ring group no-answer, ... can route to one with
// {"type":"business_hours","id"}; the ARI app then picks openDestination or closedDestination.
// Owner-only.
//
// GET    /business-hours        200 [businessHours]   sorted by name
// GET    /business-hours/:id    200 businessHours     404
// POST   /business-hours        201 businessHours     400
// PUT    /business-hours/:id    200 businessHours     400, 404   (full replace)
// DELETE /business-hours/:id    204                   404, 409 in_use (anything routing to it)
//
// businessHours = { id, name, schedule, openDestination, closedDestination, openNow }
// schedule = { intervals: [{ day: 0-6 (0 = Sunday), start: "HH:MM", end: "HH:MM" }] } in the
//   account's time zone (tenants.timezone); end <= start runs past midnight; "24:00" allowed.
//   Same rules as the ARI app: WeeklyScheduleSchema / isOpen() in services/shared.
// openNow: read-only preview, isOpen(schedule, account time zone, now). Ignored on input.

const BusinessHoursBody = z.object({
  name,
  schedule: WeeklyScheduleSchema.refine((s) => s.intervals.length <= 70, 'at most 70 intervals').describe("Weekly opening hours in the account's time zone (at most 70 intervals)."),
  openDestination: DestinationSchema.describe('Where calls go while open.'),
  closedDestination: DestinationSchema.describe('Where calls go while closed.'),
});
type BusinessHoursBody = z.infer<typeof BusinessHoursBody>;

interface BusinessHoursRow {
  id: string;
  name: string;
  schedule: WeeklySchedule;
  openDestination: Destination;
  closedDestination: Destination;
  timezone: string;
}

const notFound = () => new HttpError(404, 'not_found', 'No such business hours schedule');

/** Schedules with the account's time zone (for openNow). `id` null = all of the tenant's. */
function selectHours(db: Db, tenantId: string, id: string | null) {
  return db<BusinessHoursRow[]>`
    select bh.id, bh.name, bh.schedule, bh.open_destination, bh.closed_destination, t.timezone
      from business_hours bh
      join tenants t on t.id = bh.tenant_id
     where bh.tenant_id = ${tenantId} ${id ? db`and bh.id = ${id}` : db``}
     order by bh.name, bh.id`;
}

function present({ timezone, ...row }: BusinessHoursRow, now = new Date()) {
  return { ...row, openNow: isOpen(row.schedule, timezone, now) };
}

async function checkRefs(tx: Db, tenantId: string, body: BusinessHoursBody): Promise<void> {
  await assertOwned(tx, tenantId, [
    ...destinationRefs(body.openDestination, 'openDestination'),
    ...destinationRefs(body.closedDestination, 'closedDestination'),
  ]);
}

const BusinessHoursSchema = z
  .object({
    id: z.string().uuid().describe('Schedule id.'),
    name: z.string().describe('Display name.'),
    schedule: WeeklyScheduleSchema.describe('Weekly opening hours.'),
    openDestination: DestinationSchema.describe('Where calls go while open.'),
    closedDestination: DestinationSchema.describe('Where calls go while closed.'),
    openNow: z.boolean().describe("Whether the schedule is open right now in the account's time zone (read-only)."),
  })
  .describe('A business hours schedule.');

const docs = crudDocs({
  tag: 'Business hours',
  noun: 'business hours schedule',
  plural: 'business hours schedules',
  schema: BusinessHoursSchema,
  body: BusinessHoursBody,
  params: IdParams,
  listOrder: 'sorted by name',
  deleteErrors: { 409: `${IN_USE} (numbers, IVR digits, ring groups, other schedules).` },
});

export const businessHoursRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/business-hours', withDoc(ownerOnly, docs.list), async (req) => {
    const rows = await withRetry(() => selectHours(sql, tenantOf(req), null));
    return rows.map((r) => present(r));
  });

  app.get('/business-hours/:id', withDoc(ownerOnly, docs.get), async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(() => selectHours(sql, tenantOf(req), id));
    if (!row) throw notFound();
    return present(row);
  });

  app.post('/business-hours', withDoc(ownerOnly, docs.create), async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(BusinessHoursBody, req.body);
    const row = await withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [created] = await tx<{ id: string }[]>`
          insert into business_hours (tenant_id, name, schedule, open_destination, closed_destination)
          values (${tenantId}, ${body.name}, ${tx.json(body.schedule)}, ${tx.json(body.openDestination)},
                  ${tx.json(body.closedDestination)})
          returning id`;
        const [hours] = await selectHours(tx, tenantId, created!.id);
        return hours!;
      }),
    );
    return reply.status(201).send(present(row));
  });

  app.put('/business-hours/:id', withDoc(ownerOnly, docs.replace), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(BusinessHoursBody, req.body);
    const row = await withRetry(() =>
      sql.begin(async (tx) => {
        await checkRefs(tx, tenantId, body);
        const [updated] = await tx`
          update business_hours
             set name = ${body.name}, schedule = ${tx.json(body.schedule)},
                 open_destination = ${tx.json(body.openDestination)},
                 closed_destination = ${tx.json(body.closedDestination)}
           where id = ${id} and tenant_id = ${tenantId}
          returning id`;
        if (!updated) throw notFound();
        const [hours] = await selectHours(tx, tenantId, id);
        return hours!;
      }),
    );
    return present(row);
  });

  app.delete('/business-hours/:id', withDoc(ownerOnly, docs.remove), async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    await withRetry(() =>
      sql.begin(async (tx) => {
        const [row] = await tx`select 1 from business_hours where id = ${id} and tenant_id = ${tenantId} for update`;
        if (!row) throw notFound();
        // Numbers, IVR digits, ring groups or other schedules may route here; the ARI app would
        // hang up on those callers. Refuse; route them elsewhere first.
        refuseIfUsed(await destinationUsages(tx, tenantId, 'business_hours', id));
        await tx`delete from business_hours where id = ${id} and tenant_id = ${tenantId}`;
      }),
    );
    return reply.status(204).send();
  });
};
