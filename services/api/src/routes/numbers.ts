import { DestinationSchema, withRetry, type Destination, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { IdParams, assertOwned, destinationRefs, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';

// Phone numbers (DIDs). Step 5 only routes an existing number. Listing and purchasing numbers
// (GET /numbers, GET /numbers/available, POST /numbers/purchase) are step 8; purchase flow:
// docs/billing-flows.md.
//
// PUT /numbers/:id/route { destination }   owner   200 number   400, 404
//   destination: where calls to the number go (course spec §3 "Number routing": an extension,
//   ring group, IVR menu, or business-hours schedule; voicemail / external work too). A
//   Destination, docs/telephony-contract.md §3. null = not routed (the ARI app hangs up).
//   Phase-1 body { ivrMenuId } is still accepted and means { destination: {type:"ivr_menu"} }.
//
// number = { id, did, status, kind, destination }

// One schema (not a union): a malformed `destination` must be a 400, never fall through to the
// legacy branch and silently unroute the number. Both omitted = unroute.
const RouteBody = z
  .object({
    destination: DestinationSchema.nullable().optional().describe('Where calls go; null = unroute (calls are hung up).'),
    ivrMenuId: z.string().uuid().nullable().optional().describe('Deprecated (phase 1): same as destination {type: "ivr_menu", id}. Ignored when destination is sent.'),
  })
  .transform(({ destination, ivrMenuId }) => ({
    destination:
      destination !== undefined
        ? destination
        : ivrMenuId
          ? ({ type: 'ivr_menu', id: ivrMenuId } as const)
          : null,
  }));

interface PhoneNumber {
  id: string;
  did: string;
  status: 'assigned' | 'released';
  kind: 'local' | 'toll_free';
  destination: Destination | null;
}

const NumberSchema = z
  .object({
    id: z.string().uuid().describe('Phone number id.'),
    did: z.string().describe('The number, E.164.'),
    status: z.enum(['assigned', 'released']).describe('released numbers keep working until their paid period ends.'),
    kind: z.enum(['local', 'toll_free']).describe('Number type.'),
    destination: DestinationSchema.nullable().describe('Where calls to the number go; null = not routed (hang up).'),
  })
  .describe("One of the account's phone numbers.");

const docs = {
  route: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Route a phone number',
    description:
      'Sets where calls to the number go: an extension, ring group, IVR menu or business hours schedule ' +
      '(voicemail, external and hangup work too). The phase-1 body `{ "ivrMenuId" }` is still accepted.',
    params: IdParams,
    body: RouteBody,
    responses: { 200: { description: 'The routed number', schema: NumberSchema } },
    errors: { 404: 'No such number in this account, or it was released (`not_found`).' },
  },
} satisfies Record<string, OperationDoc>;

export const numberRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  app.put('/numbers/:id/route', withDoc({ preHandler: [authenticate, requireRole('owner')] }, docs.route), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const { destination } = parse(RouteBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        // Locks the target FOR SHARE, so a concurrent delete of it sees this route.
        await assertOwned(tx, tenantId, destinationRefs(destination, 'destination'));
        // ivr_menu_id is the phase-1 column; kept in sync for anything still reading it.
        const ivrMenuId = destination?.type === 'ivr_menu' ? destination.id : null;
        // Released numbers no longer belong to the tenant: "not found" like any other id.
        const [row] = await tx<PhoneNumber[]>`
          update phone_numbers
             set destination = ${destination ? tx.json(destination) : null}, ivr_menu_id = ${ivrMenuId}
           where id = ${id} and tenant_id = ${tenantId} and status = 'assigned'
          returning id, did, status, kind, destination`;
        if (!row) throw new HttpError(404, 'not_found', 'No such phone number');
        return row;
      }),
    );
  });
};
