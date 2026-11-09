import { randomBytes } from 'node:crypto';
import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { hashPassword } from '../passwords.js';
import { menusUsing, refuseIfUsed, usages } from '../references.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { email, parse, password } from '../validation.js';

// Staff accounts and their SIP (softphone) credentials (backend step 4, CLAUDE.md §11).
//
// POST   /staff                 owner  create a staff user + Kamailio subscriber row     201
// GET    /staff                 owner  list the business's staff                          200
// DELETE /staff/:id             owner  delete a staff user + subscriber + registrations   204
// GET    /me/sip-credentials    staff  { wsUri, sipUri, username, password } for SIP.js    200
//
// A staff member has two separate credentials:
//  - dashboard login (users.email + users.password_hash, argon2), set by the owner at creation;
//  - SIP account (kamailio.subscriber), generated here. Kamailio authenticates REGISTERs against
//    it (auth_db calculate_ha1=yes reads the plaintext `password` column, CLAUDE.md §6), and the
//    browser fetches it from /me/sip-credentials after logging in. Staff never type it.
//
// Kamailio's tables live in the `kamailio` schema of the same database, so the users row and the
// subscriber row are written in ONE transaction: there is never a SIP account without a user, or
// a staff user whose softphone can't register.

export interface StaffOptions {
  sql: Sql;
  /** SIP_WS_URI: where browsers open the SIP WebSocket (wss://<app domain>/ws via HAProxy). */
  sipWsUri: string;
  /** SIP_DOMAIN: must equal Ansible's `sip_domain` (subscriber rows, Kamailio alias). */
  sipDomain: string;
}

const CreateStaffBody = z.object({ email, password });

interface StaffRow {
  id: string;
  email: string;
  role: 'staff';
  sipUsername: string;
  createdAt: Date;
}

/**
 * Generated SIP username: "s" + 16 hex chars. Globally unique (users.sip_username is UNIQUE and
 * Kamailio looks users up by username only, use_domain=0), so it can't be a per-tenant name.
 * Letters + digits only: it ends up in Asterisk dial strings (PJSIP/<username>@edge-a).
 */
const newSipUsername = () => `s${randomBytes(8).toString('hex')}`;
/** 24 chars of base64url (144 bits). Fits subscriber.password VARCHAR(64). */
const newSipPassword = () => randomBytes(18).toString('base64url');

export const staffRoutes: FastifyPluginAsync<StaffOptions> = async (app, { sql, sipWsUri, sipDomain }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.post('/staff', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const body = parse(CreateStaffBody, req.body);
    const passwordHash = await hashPassword(body.password);

    // A username collision (2^64 space) is practically impossible, but cheap to handle.
    for (let attempt = 1; ; attempt++) {
      const sipUsername = newSipUsername();
      try {
        const staff = await withRetry(() =>
          sql.begin(async (tx) => {
            const [user] = await tx<StaffRow[]>`
              insert into users (tenant_id, email, password_hash, role, sip_username)
              values (${tenantId}, ${body.email}, ${passwordHash}, 'staff', ${sipUsername})
              returning id, email, role, sip_username, created_at`;
            await tx`
              insert into kamailio.subscriber (username, domain, password)
              values (${sipUsername}, ${sipDomain}, ${newSipPassword()})`;
            return user!;
          }),
        );
        req.log.info({ tenantId, userId: staff.id, sipUsername }, 'staff created');
        return reply.status(201).send(staff);
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_key')) {
          throw new HttpError(409, 'email_taken', 'An account with this email already exists');
        }
        const usernameTaken =
          isUniqueViolation(err, 'users_sip_username_key') || isUniqueViolation(err, 'subscriber_account_idx');
        if (usernameTaken && attempt < 3) continue;
        throw err;
      }
    }
  });

  app.get('/staff', ownerOnly, async (req) => {
    return withRetry(
      () => sql<StaffRow[]>`
        select id, email, role, sip_username, created_at
          from users
         where tenant_id = ${tenantOf(req)} and role = 'staff'
         order by created_at, id`,
    );
  });

  app.delete('/staff/:id', ownerOnly, async (req, reply) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);

    await withRetry(() =>
      sql.begin(async (tx) => {
        // Lock the row so a concurrent IVR or ring group save can't start pointing at this user
        // meanwhile (those saves lock the users they reference FOR SHARE, via assertOwned).
        // Owners and other tenants' users are "not found": this route only manages staff.
        const [user] = await tx<{ sipUsername: string | null }[]>`
          select sip_username from users
           where id = ${id} and tenant_id = ${tenantId} and role = 'staff'
             for update`;
        if (!user) throw new HttpError(404, 'not_found', 'No such staff member');

        // IVR configs reference users inside JSON (no foreign key). A dangling "user" target makes
        // the ARI app hang up on callers who press that digit, so refuse instead.
        refuseIfUsed(usages('IVR menu', await menusUsing(tx, tenantId, 'user', id)));

        if (user.sipUsername) {
          // Registrations too (usrloc db_mode=3 reads the DB on every lookup), so calls stop
          // ringing this softphone immediately instead of when the registration expires.
          await tx`delete from kamailio.location_attrs where username = ${user.sipUsername}`;
          await tx`delete from kamailio.location where username = ${user.sipUsername}`;
          await tx`delete from kamailio.subscriber where username = ${user.sipUsername}`;
        }
        // Cascades: ring_group_members rows go; mailboxes.owner_user_id and
        // calls.answered_by_user_id become NULL (history is kept).
        await tx`delete from users where id = ${id} and tenant_id = ${tenantId}`;
      }),
    );

    req.log.info({ tenantId, userId: id }, 'staff deleted');
    return reply.status(204).send();
  });

  app.get('/me/sip-credentials', { preHandler: [authenticate, requireRole('staff')] }, async (req, reply) => {
    const [row] = await withRetry(
      () => sql<{ username: string; password: string }[]>`
        select s.username, s.password
          from users u
          join kamailio.subscriber s on s.username = u.sip_username and s.domain = ${sipDomain}
         where u.id = ${req.auth!.userId} and u.tenant_id = ${tenantOf(req)}`,
    );
    // Deleted since the token was issued, or created without a SIP account (seed data).
    if (!row) throw new HttpError(404, 'not_found', 'No SIP account for this user');

    // A secret: never let a browser or proxy cache it.
    reply.header('cache-control', 'no-store');
    return {
      wsUri: sipWsUri,
      sipUri: `sip:${row.username}@${sipDomain}`,
      username: row.username,
      password: row.password,
    };
  });
};
