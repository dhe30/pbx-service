import { withRetry, type Sql, type UserRole } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { hashPassword } from '../passwords.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { email, parse, password } from '../validation.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';

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

const CreateStaffBody = z.object({ email, password: password.optional() });
const CredentialsQuery = z.object({
  extensionId: z.string().uuid().optional().describe('Extension to use (GET /extensions). Default: the one assigned to this user.'),
});

interface StaffRow {
  id: string;
  email: string;
  role: 'staff';
  createdAt: Date;
}

const StaffSchema = z
  .object({
    id: z.string().uuid().describe('User id.'),
    email: z.string().describe('Login email.'),
    role: z.literal('staff').describe('Always "staff".'),
    createdAt: z.date().describe('When the login was created.'),
  })
  .describe('A staff login.');

const CredentialsSchema = z
  .object({
    wsUri: z.string().describe('SIP over WebSocket server for the softphone (SIP.js transport).'),
    sipUri: z.string().describe('Address of record to register, sip:<username>@<SIP domain>.'),
    username: z.string().describe('SIP digest username.'),
    password: z.string().describe('SIP digest password. Keep in memory only.'),
    extensionId: z.string().uuid().describe('Extension these credentials belong to.'),
    extensionNumber: z.string().describe('Its extension number.'),
  })
  .describe('SIP credentials for the softphone.');

const docs = {
  create: {
    tag: 'Staff',
    auth: 'owner',
    summary: 'Create or attach a staff login',
    description:
      'A dashboard login for an employee. Supply only an email to attach an existing unassigned user; include a password to create a new login. Phones and the softphone use extensions (POST /extensions).',
    body: CreateStaffBody,
    responses: { 201: { description: 'The staff login', schema: StaffSchema } },
    errors: {
      400: 'A password is required when the email does not belong to an existing unassigned user (`invalid_request`).',
      409: 'The email already belongs to a user who cannot be attached (`email_taken`).',
    },
  },
  list: {
    tag: 'Staff',
    auth: 'owner',
    summary: 'List staff logins',
    description: 'Oldest first.',
    responses: { 200: { description: 'Staff logins', schema: z.array(StaffSchema).describe('Staff logins.') } },
  },
  remove: {
    tag: 'Staff',
    auth: 'owner',
    summary: 'Delete a staff login',
    description: 'An extension assigned to the user stays, unassigned.',
    params: IdParams,
    responses: { 204: { description: 'Deleted' } },
    errors: { 404: 'No such staff member (`not_found`).' },
  },
  credentials: {
    tag: 'Staff',
    auth: 'user',
    summary: 'SIP credentials for the softphone',
    description:
      "Credentials of one of the account's extensions, to register the browser softphone. Without " +
      'extensionId: the extension assigned to the logged-in user. Sent with Cache-Control: no-store.',
    query: CredentialsQuery,
    responses: { 200: { description: 'Credentials for SIP.js', schema: CredentialsSchema } },
    errors: { 404: 'No such extension, or none is assigned to this user (`not_found`).' },
  },
} satisfies Record<string, OperationDoc>;

export const staffRoutes: FastifyPluginAsync<StaffOptions> = async (app, { sql, sipWsUri, sipDomain }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.post('/staff', withDoc(ownerOnly, docs.create), async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(CreateStaffBody, req.body);
    try {
      const staff = await withRetry(() =>
        sql.begin(async (tx) => {
          const [existing] = await tx<{ id: string; tenantId: string | null; role: UserRole }[]>`
            select id, tenant_id, role from users where email = ${body.email} for update`;
          if (existing) {
            if (existing.tenantId !== null || existing.role !== 'unassigned') {
              throw new HttpError(409, 'email_taken', 'This email already belongs to a business user');
            }
            const [attached] = await tx<StaffRow[]>`
              update users set tenant_id = ${tenantId}, role = 'staff'
               where id = ${existing.id} and tenant_id is null and role = 'unassigned'
               returning id, email, role, created_at`;
            if (!attached) throw new HttpError(409, 'email_taken', 'This user can no longer be attached');
            return attached;
          }

          if (!body.password) {
            throw new HttpError(400, 'invalid_request', 'password: Required when creating a new staff login');
          }
          const passwordHash = await hashPassword(body.password);
          const [created] = await tx<StaffRow[]>`
            insert into users (tenant_id, email, password_hash, role)
            values (${tenantId}, ${body.email}, ${passwordHash}, 'staff')
            returning id, email, role, created_at`;
          return created!;
        }),
      );
      req.log.info({ tenantId, userId: staff.id }, 'staff created or attached');
      return reply.status(201).send(staff);
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      }
      throw err;
    }
  });

  app.get('/staff', withDoc(ownerOnly, docs.list), async (req) => {
    return withRetry(
      () => sql<StaffRow[]>`
        select id, email, role, created_at
          from users
         where tenant_id = ${tenantOf(req)} and role = 'staff'
         order by created_at, id`,
    );
  });

  app.delete('/staff/:id', withDoc(ownerOnly, docs.remove), async (req, reply) => {
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

  app.get('/me/sip-credentials', withDoc({ preHandler: [authenticate] }, docs.credentials), async (req, reply) => {
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
