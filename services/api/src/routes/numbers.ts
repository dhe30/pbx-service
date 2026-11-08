import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { IdParams, assertOwned, tenantOf } from '../tenancy.js';
import { nullableId, parse } from '../validation.js';

// Phone numbers (DIDs). Step 5 only routes an existing number to an IVR menu. Listing and
// purchasing numbers (GET /numbers, GET /numbers/available, POST /numbers/purchase) are step 8.
//
// PUT /numbers/:id/route { ivrMenuId }   owner   200 number   400, 404
//
// number = { id, did, status, ivrMenuId }
// ivrMenuId null = the number isn't routed; the ARI app then hangs up on its calls.

const RouteBody = z.object({ ivrMenuId: nullableId });

interface PhoneNumber {
  id: string;
  did: string;
  status: 'assigned' | 'released';
  ivrMenuId: string | null;
}

export const numberRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  app.put('/numbers/:id/route', { preHandler: [authenticate, requireRole('owner')] }, async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(RouteBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        // Locks the menu FOR SHARE, so a concurrent DELETE /ivr-menus/:id sees this route.
        if (body.ivrMenuId) {
          await assertOwned(tx, tenantId, [{ table: 'ivr_menus', id: body.ivrMenuId, field: 'ivrMenuId' }]);
        }
        // Released numbers no longer belong to the tenant: "not found" like any other id.
        const [row] = await tx<PhoneNumber[]>`
          update phone_numbers set ivr_menu_id = ${body.ivrMenuId}
           where id = ${id} and tenant_id = ${tenantId} and status = 'assigned'
          returning id, did, status, ivr_menu_id`;
        if (!row) throw new HttpError(404, 'not_found', 'No such phone number');
        return row;
      }),
    );
  });
};
