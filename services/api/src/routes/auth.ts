import { withRetry, type Sql, type UserRole } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { clearAuthCookies, readRefreshToken, setAuthCookies, type AuthUser } from '../auth.js';
import { HttpError } from '../errors.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { parse } from '../validation.js';

// POST /auth/signup   create a business (tenant) + its owner, log them in      201
// POST /auth/login    email + password -> auth cookies                         200
// POST /auth/refresh  refresh cookie -> new access + refresh cookies           200
// POST /auth/logout   clear auth cookies                                       204
// Responses carry only { userId, tenantId, role }; profile data comes from GET /me (not built yet).

// Emails are stored lowercased: users.email is a plain case-sensitive UNIQUE column.
const email = z.string().trim().toLowerCase().email().max(254);
// Upper bound keeps argon2 work per request bounded.
const password = z.string().min(8, 'must be at least 8 characters').max(128);

const SignupBody = z.object({
  businessName: z.string().trim().min(1).max(100),
  email,
  password,
});

const LoginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});

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
            insert into tenants (name) values (${body.businessName}) returning id`;
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

  app.post('/auth/logout', async (_req, reply) => {
    clearAuthCookies(reply);
    return reply.status(204).send();
  });
};

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === '23505' && e.constraint_name === constraint;
}
