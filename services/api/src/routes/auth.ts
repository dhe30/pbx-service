import { withRetry, type Sql, type UserRole } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, clearAuthCookies, readRefreshToken, setAuthCookies, type AuthUser } from '../auth.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { email, name, parse, password, timeZone } from '../validation.js';
import { CardSetupSchema, cardSetupOrNull, createBusinessForUser, type CardSetupConfig } from './businesses.js';

// POST /auth/signup   create a user and log them in; with businessName +       201
//                     timezone it also creates their business (one step)
// POST /auth/login    email + password -> auth cookies                         200
// POST /auth/refresh  refresh cookie -> new access + refresh cookies           200
// POST /auth/logout   clear auth cookies                                       204
// GET  /me            the logged-in user and optional business                 200, 401
// Auth responses carry only { userId, tenantId, role }; profile data comes from GET /me.

// businessName + timezone are optional, but go together: with them signup is one step (account +
// business + card setup), as in the course spec's signup; without them the web's two-step flow
// (POST /businesses afterwards) is unchanged.
const SignupBody = z.object({
  email,
  password,
  businessName: name
    .optional()
    .describe('Business name, 1-100 characters. Send with timezone to create the business in the same call.'),
  timezone: timeZone
    .optional()
    .describe('IANA time zone of the business, e.g. America/New_York. Send with businessName.'),
}).strict();

const LoginBody = z.object({
  email,
  password: z.string().min(1).max(128).describe('Dashboard password.'),
});

const role = z.enum(['owner', 'staff', 'unassigned']).describe('owner: manages the business; staff: dashboard + softphone; unassigned: no business yet.');
const AuthUserSchema = z.object({
  userId: z.string().uuid().describe('Logged-in user.'),
  tenantId: z.string().uuid().nullable().describe('Business id, or null until the user joins or creates a business.'),
  role,
});
const SignupSchema = AuthUserSchema.extend({
  cardSetup: CardSetupSchema.optional().describe(
    'Only when the business was created in this call: card setup for Stripe.js, then POST /billing/card.',
  ),
});

const MeSchema = z.object({
  user: z
    .object({
      id: z.string().uuid().describe('User id.'),
      email: z.string().describe('Login email.'),
      role,
      createdAt: z.date().describe('When the user was created.'),
    })
    .describe('The logged-in user.'),
  tenant: z
    .object({
      id: z.string().uuid().describe('Account id.'),
      name: z.string().describe('Business name.'),
      timezone: z.string().describe('IANA time zone (fixed at signup).'),
      status: z
        .enum(['active', 'past_due'])
        .describe('past_due: an invoice is unpaid; outgoing calls are blocked until a new card pays it.'),
      createdAt: z.date().describe('Signup time.'),
    })
    .nullable()
    .describe("The user's business."),
});

const cookiesSet = { 'Set-Cookie': 'pbx_access (path /, 15 min) and pbx_refresh (path /auth, 7 days); httpOnly.' };
const docs = {
  signup: {
    tag: 'Auth',
    auth: 'public',
    summary: 'Create an account',
    description:
      'Creates an account and logs the user in. With businessName and timezone it also creates the business with ' +
      'this user as owner and starts card setup (save the card with Stripe.js, then POST /billing/card). Without ' +
      'them the account has no business yet: create one with POST /businesses.',
    body: SignupBody,
    responses: { 201: { description: 'Created and logged in', schema: SignupSchema, headers: cookiesSet } },
    errors: {
      400: 'Invalid body, or only one of businessName / timezone (`invalid_request`).',
      409: 'A user with this email already exists (`email_taken`).',
    },
  },
  login: {
    tag: 'Auth',
    auth: 'public',
    summary: 'Log in',
    body: LoginBody,
    responses: { 200: { description: 'Logged in', schema: AuthUserSchema, headers: cookiesSet } },
    errors: { 401: 'Wrong email or password (`invalid_credentials`; same answer for both).' },
  },
  refresh: {
    tag: 'Auth',
    auth: 'public',
    summary: 'Renew the session',
    description: 'Trades the refresh cookie for new access + refresh cookies. Call once after a 401, then retry.',
    responses: { 200: { description: 'New cookies set', schema: AuthUserSchema, headers: cookiesSet } },
    errors: { 401: 'No valid refresh cookie, or the user was deleted; log in again (`unauthorized`).' },
  },
  logout: {
    tag: 'Auth',
    auth: 'public',
    summary: 'Log out',
    description: 'Clears both auth cookies.',
    responses: { 204: { description: 'Logged out' } },
  },
  me: {
    tag: 'Auth',
    auth: 'user',
    summary: 'Current user and optional business',
    responses: { 200: { description: 'The user and their business', schema: MeSchema } },
  },
} satisfies Record<string, OperationDoc>;

interface MeRow {
  id: string;
  email: string;
  role: UserRole;
  createdAt: Date;
  tenantId: string | null;
  tenantName: string | null;
  timezone: string | null;
  status: 'active' | 'past_due' | null;
  tenantCreatedAt: Date | null;
}

export interface AuthRouteOptions extends CardSetupConfig {
  sql: Sql;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, { sql, ...cardCfg }) => {
  app.post('/auth/signup', withDoc({}, docs.signup), async (req, reply) => {
    const body = parse(SignupBody, req.body);
    if ((body.businessName === undefined) !== (body.timezone === undefined)) {
      throw new HttpError(400, 'invalid_request', 'businessName and timezone must be sent together');
    }
    const business =
      body.businessName !== undefined ? { name: body.businessName, timezone: body.timezone! } : null;
    const passwordHash = await hashPassword(body.password);

    // User and business in one transaction: a failed business never leaves a half-made account.
    let created: { userId: string; tenantId: string | null };
    try {
      created = await withRetry(() =>
        sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into users (tenant_id, email, password_hash, role)
            values (null, ${body.email}, ${passwordHash}, 'unassigned')
            returning id`;
          const tenantId = business
            ? await createBusinessForUser(tx, row!.id, business.name, business.timezone)
            : null;
          return { userId: row!.id, tenantId };
        }),
      );
    } catch (err) {
      if (isUniqueViolation(err, 'users_email_key')) {
        throw new HttpError(409, 'email_taken', 'A user with this email already exists');
      }
      throw err;
    }

    const { userId, tenantId } = created;
    if (!tenantId) {
      const user: AuthUser = { userId, tenantId: null, role: 'unassigned' };
      req.log.info({ userId }, 'user signed up');
      setAuthCookies(reply, user);
      return reply.status(201).send(user);
    }

    const user: AuthUser = { userId, tenantId, role: 'owner' };
    setAuthCookies(reply, user);
    const cardSetup = await cardSetupOrNull(sql, cardCfg, tenantId, req.log);
    req.log.info({ userId, tenantId }, 'user signed up with a business');
    return reply.status(201).send({ ...user, cardSetup });
  });

  app.post('/auth/login', withDoc({}, docs.login), async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const [row] = await withRetry(
      () => sql<{ id: string; tenantId: string | null; role: UserRole; passwordHash: string }[]>`
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

  app.post('/auth/refresh', withDoc({}, docs.refresh), async (req, reply) => {
    const token = readRefreshToken(req);
    if (!token) {
      clearAuthCookies(reply);
      throw new HttpError(401, 'unauthorized', 'Session expired, please log in again');
    }

    // Re-read the user: picks up role changes and rejects deleted users.
    const [row] = await withRetry(
      () => sql<{ id: string; tenantId: string | null; role: UserRole }[]>`
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

  app.get('/me', withDoc({ preHandler: [authenticate] }, docs.me), async (req, reply) => {
    const { userId } = req.auth!;
    const [row] = await withRetry(
      () => sql<MeRow[]>`
        select u.id, u.email, u.role, u.created_at,
               t.id as tenant_id, t.name as tenant_name, t.timezone, t.status, t.created_at as tenant_created_at
          from users u
          left join tenants t on t.id = u.tenant_id
         where u.id = ${userId}`,
    );
    // Deleted since the token was issued: same answer as an expired session.
    if (!row) throw new HttpError(401, 'unauthorized', 'Not logged in or session expired');
    const currentAuth: AuthUser = { userId: row.id, tenantId: row.tenantId, role: row.role };
    if (req.auth!.tenantId !== currentAuth.tenantId || req.auth!.role !== currentAuth.role) {
      setAuthCookies(reply, currentAuth);
    }
    return {
      user: { id: row.id, email: row.email, role: row.role, createdAt: row.createdAt },
      tenant: row.tenantId
        ? {
            id: row.tenantId,
            name: row.tenantName!,
            timezone: row.timezone!,
            status: row.status!,
            createdAt: row.tenantCreatedAt!,
          }
        : null,
    };
  });

  app.post('/auth/logout', withDoc({}, docs.logout), async (_req, reply) => {
    clearAuthCookies(reply);
    return reply.status(204).send();
  });
};

