import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { hashPassword } from '../passwords.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { email, parse, password } from '../validation.js';

// Staff accounts (dashboard logins) and the softphone's SIP credentials (backend step 4, ported
// to the course spec: SIP accounts belong to EXTENSIONS now, see routes/extensions.ts).
//
// POST   /staff                 owner      create a staff user (login only)                 201
// GET    /staff                 owner      list the business's staff                         200
// DELETE /staff/:id             owner      delete a staff user                               204
// GET    /me/sip-credentials    any user   { wsUri, sipUri, username, password, extensionId,  200
//                                           extensionNumber } for SIP.js
//
// Course spec §4: "A logged-in user calls and answers as one of the account's extensions." The
// softphone lists GET /extensions (data-testid softphone-extension) and fetches the chosen one's
// credentials with ?extensionId=. Without it: the extension assigned to this user
// (extensions.user_id), else 404.

export interface StaffOptions {
  sql: Sql;
  /** SIP_WS_URI: where browsers open the SIP WebSocket (wss://<app domain>/ws via HAProxy). */
  sipWsUri: string;
  /** SIP_DOMAIN: must equal Ansible's `sip_domain` (subscriber rows, Kamailio alias). */
  sipDomain: string;
}

const CreateStaffBody = z.object({ email, password });
const CredentialsQuery = z.object({ extensionId: z.string().uuid().optional() });

interface StaffRow {
  id: string;
  email: string;
  role: 'staff';
  createdAt: Date;
}

export const staffRoutes: FastifyPluginAsync<StaffOptions> = async (app, { sql, sipWsUri, sipDomain }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.post('/staff', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(CreateStaffBody, req.body);
    const passwordHash = await hashPassword(body.password);
    try {
      const [staff] = await withRetry(
        () => sql<StaffRow[]>`
          insert into users (tenant_id, email, password_hash, role)
          values (${tenantId}, ${body.email}, ${passwordHash}, 'staff')
          returning id, email, role, created_at`,
      );
      req.log.info({ tenantId, userId: staff!.id }, 'staff created');
      return reply.status(201).send(staff);
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      }
      throw err;
    }
  });

  app.get('/staff', ownerOnly, async (req) => {
    return withRetry(
      () => sql<StaffRow[]>`
        select id, email, role, created_at
          from users
         where tenant_id = ${tenantOf(req)} and role = 'staff'
         order by created_at, id`,
    );
  });

  app.delete('/staff/:id', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    // Owners and other tenants' users are "not found": this route only manages staff.
    // Cascades: extensions.user_id and mailboxes.owner_user_id become NULL (the extension and its
    // phones keep working; only the default softphone assignment goes).
    const rows = await withRetry(
      () => sql`delete from users where id = ${id} and tenant_id = ${tenantId} and role = 'staff' returning id`,
    );
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'No such staff member');
    req.log.info({ tenantId, userId: id }, 'staff deleted');
    return reply.status(204).send();
  });

  app.get('/me/sip-credentials', { preHandler: [authenticate] }, async (req, reply) => {
    const tenantId = tenantOf(req);
    const { extensionId } = parse(CredentialsQuery, req.query);
    const [row] = await withRetry(
      () => sql<{ id: string; number: string; username: string; password: string }[]>`
        select e.id, e.number, s.username, s.password
          from extensions e
          join kamailio.subscriber s on s.username = e.sip_username and s.domain = ${sipDomain}
         where e.tenant_id = ${tenantId}
           and ${extensionId ? sql`e.id = ${extensionId}` : sql`e.user_id = ${req.auth!.userId}`}
         order by length(e.number), e.number
         limit 1`,
    );
    if (!row) {
      throw new HttpError(404, 'not_found', extensionId ? 'No such extension' : 'No extension is assigned to this user');
    }

    // A secret: never let a browser or proxy cache it.
    reply.header('cache-control', 'no-store');
    return {
      wsUri: sipWsUri,
      sipUri: `sip:${row.username}@${sipDomain}`,
      username: row.username,
      password: row.password,
      extensionId: row.id,
      extensionNumber: row.number,
    };
  });
};
