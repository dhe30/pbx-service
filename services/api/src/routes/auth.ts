import { withRetry, type Sql, type UserRole } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, clearAuthCookies, readRefreshToken, setAuthCookies, type AuthUser } from '../auth.js';
import { startCardSetup, type CardSetup } from '../billing/account.js';
import { PLAN } from '../billing/catalog.js';
import type { StripeClient } from '../billing/stripe.js';
import { HttpError, isUniqueViolation } from '../errors.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
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
  businessName: z.string().trim().min(1).max(100).describe('Business name, 1-100 characters.'),
  timezone: timeZone,
  email,
  password,
});

const LoginBody = z.object({
  email,
  password: z.string().min(1).max(128).describe('Dashboard password.'),
});

const role = z.enum(['owner', 'staff']).describe('owner: manages the account. staff: dashboard + softphone only.');
const AuthUserSchema = z.object({
  userId: z.string().uuid().describe('Logged-in user.'),
  tenantId: z.string().uuid().describe('The business (account) the user belongs to.'),
  role,
});
const SignupSchema = AuthUserSchema.extend({
  cardSetup: z
    .object({
      setupIntentId: z.string().describe('Stripe SetupIntent id; send it to POST /billing/card after confirming.'),
      clientSecret: z
        .string()
        .describe('The SetupIntent client_secret: pass it to Stripe.js stripe.confirmCardSetup() to save the card.'),
      publishableKey: z.string().describe('Stripe publishable key for Stripe(publishableKey).'),
      stripeJsUrl: z.string().describe('Load Stripe.js from this URL (the course payment gateway).'),
    })
    .nullable()
    .describe('Card setup for the new account. null if the payment gateway failed: call POST /billing/setup-intent.'),
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
    .describe("The user's business."),
});

const cookiesSet = { 'Set-Cookie': 'pbx_access (path /, 15 min) and pbx_refresh (path /auth, 7 days); httpOnly.' };
const docs = {
  signup: {
    tag: 'Auth',
    auth: 'public',
    summary: 'Sign up a business',
    description:
      'Creates the business and its owner, and logs the owner in. Then save the card: in the browser, load Stripe.js ' +
      'from cardSetup.stripeJsUrl, call stripe.confirmCardSetup(cardSetup.clientSecret, { payment_method: { card } }) ' +
      'and send the SetupIntent id to POST /billing/card, which charges the plan prorated to the end of the first ' +
      'period. Card numbers never go to this API. See GET /billing/prices for the plan price.',
    body: SignupBody,
    responses: { 201: { description: 'Created and logged in', schema: SignupSchema, headers: cookiesSet } },
    errors: { 409: 'An account with this email already exists (`email_taken`).' },
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
    summary: 'Current user and business',
    responses: { 200: { description: 'The user and their business', schema: MeSchema } },
  },
} satisfies Record<string, OperationDoc>;

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

export interface AuthRouteOptions {
  sql: Sql;
  stripe: StripeClient;
  publishableKey: string;
  stripeJsUrl: string;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, { sql, stripe, publishableKey, stripeJsUrl }) => {
  app.post('/auth/signup', withDoc({}, docs.signup), async (req, reply) => {
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
          await tx`
            insert into tenant_settings (tenant_id, included_extensions, included_us_minutes)
            values (${tenant!.id}, ${PLAN.includedExtensions}, ${PLAN.includedUsMinutes})`;
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
    // Card setup happens after the account exists (the Stripe customer carries its id). If the
    // gateway fails, signup still succeeds; the client then calls POST /billing/setup-intent.
    let cardSetup: (CardSetup & { publishableKey: string; stripeJsUrl: string }) | null = null;
    try {
      cardSetup = { ...(await startCardSetup(sql, stripe, user.tenantId)), publishableKey, stripeJsUrl };
    } catch (err) {
      req.log.warn({ err, tenantId: user.tenantId }, 'card setup failed at signup');
    }

    setAuthCookies(reply, user);
    return reply.status(201).send({ ...user, cardSetup });
  });

  app.post('/auth/login', withDoc({}, docs.login), async (req, reply) => {
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

  app.post('/auth/refresh', withDoc({}, docs.refresh), async (req, reply) => {
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

  app.get('/me', withDoc({ preHandler: [authenticate] }, docs.me), async (req) => {
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

  app.post('/auth/logout', withDoc({}, docs.logout), async (_req, reply) => {
    clearAuthCookies(reply);
    return reply.status(204).send();
  });
};

