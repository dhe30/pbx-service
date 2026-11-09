import { withRetry, type Sql, type UserRole } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, clearAuthCookies, readRefreshToken, setAuthCookies, type AuthUser } from '../auth.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { email, parse, password, timeZone } from '../validation.js';

// POST /auth/signup   create a business (tenant) + its owner, log them in      201
// POST /auth/login    email + password -> auth cookies                         200
// POST /auth/refresh  refresh cookie -> new access + refresh cookies           200
// POST /auth/logout   clear auth cookies                                       204
// GET  /me            the logged-in user and their business                    200, 401
// Auth responses carry only { userId, tenantId, role }; profile data comes from GET /me.
//
// timezone (course spec §1): IANA name, fixed after signup. It governs billing periods and
// business hours (tenants.timezone, read by the ARI app). There is deliberately no route that
// changes it.

const SignupBody = z.object({
  businessName: z.string().trim().min(1).max(100),
  timezone: timeZone,
  email,
  password,
});

const LoginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});

interface MeRow {
  id: string;
  email: string;
  role: UserRole;
  createdAt: Date;
  tenantId: string;
  tenantName: string;
  timezone: string;
  status: 'active' | 'past_due';
  tenantCreatedAt: Date;
}

export const authRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  app.post('/auth/signup', async (req, reply) => {
    const body = parse(SignupBody, req.body);
    const passwordHash = await hashPassword(body.password);

    let user: AuthUser;
    try {
      // One transaction: never leave a tenant without an owner or settings. Safe to retry on a
      // failover error because a failed transaction is rolled back entirely.
      user = await withRetry(() =>
        sql.begin(async (tx) => {
          const [tenant] = await tx<{ id: string }[]>`
            insert into tenants (name, timezone) values (${body.businessName}, ${body.timezone}) returning id`;
          await tx`insert into tenant_settings (tenant_id) values (${tenant!.id})`;
          const [owner] = await tx<{ id: string }[]>`
            insert into users (tenant_id, email, password_hash, role)
            values (${tenant!.id}, ${body.email}, ${passwordHash}, 'owner')
            returning id`;
          return { userId: owner!.id, tenantId: tenant!.id, role: 'owner' as const };
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      }
      throw err;
    }

    req.log.info({ userId: user.userId, tenantId: user.tenantId }, 'tenant signed up');
    setAuthCookies(reply, user);
    return reply.status(201).send(user);
  });

  app.post('/auth/login', async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const [row] = await withRetry(
      () => sql<{ id: string; tenantId: string; role: UserRole; passwordHash: string }[]>`
        select id, tenant_id, role, password_hash from users where email = ${body.email}`,
    );

    // Same answer and roughly the same time whether the email is unknown or the password wrong.
    const ok = await verifyPassword(row?.passwordHash ?? null, body.password);
    if (!row || !ok) {
      req.log.info({ email: body.email }, 'login failed');
      throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
    }

    const user: AuthUser = { userId: row.id, tenantId: row.tenantId, role: row.role };
    setAuthCookies(reply, user);
    return reply.send(user);
  });

  app.post('/auth/refresh', async (req, reply) => {
    const token = readRefreshToken(req);
    if (!token) {
      clearAuthCookies(reply);
      throw new HttpError(401, 'unauthorized', 'Session expired, please log in again');
    }

    // Re-read the user: picks up role changes and rejects deleted users.
    const [row] = await withRetry(
      () => sql<{ id: string; tenantId: string; role: UserRole }[]>`
        select id, tenant_id, role from users where id = ${token.userId}`,
    );
    if (!row) {
      clearAuthCookies(reply);
      throw new HttpError(401, 'unauthorized', 'Session expired, please log in again');
    }

    const user: AuthUser = { userId: row.id, tenantId: row.tenantId, role: row.role };
    setAuthCookies(reply, user);
    return reply.send(user);
  });

  app.get('/me', { preHandler: [authenticate] }, async (req) => {
    const { userId, tenantId } = req.auth!;
    const [row] = await withRetry(
      () => sql<MeRow[]>`
        select u.id, u.email, u.role, u.created_at,
               t.id as tenant_id, t.name as tenant_name, t.timezone, t.status, t.created_at as tenant_created_at
          from users u
          join tenants t on t.id = u.tenant_id
         where u.id = ${userId} and u.tenant_id = ${tenantId}`,
    );
    // Deleted since the token was issued: same answer as an expired session.
    if (!row) throw new HttpError(401, 'unauthorized', 'Not logged in or session expired');
    return {
      user: { id: row.id, email: row.email, role: row.role, createdAt: row.createdAt },
      tenant: {
        id: row.tenantId,
        name: row.tenantName,
        timezone: row.timezone,
        status: row.status,
        createdAt: row.tenantCreatedAt,
      },
    };
  });

  app.post('/auth/logout', async (_req, reply) => {
    clearAuthCookies(reply);
    return reply.status(204).send();
  });
};

