import { withRetry, type Sql, type TransactionSql } from '@pbx/shared';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole, setAuthCookies, type AuthUser } from '../auth.js';
import { startCardSetup, type CardSetup } from '../billing/account.js';
import { PLAN } from '../billing/catalog.js';
import type { StripeClient } from '../billing/stripe.js';
import { HttpError } from '../errors.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { timeZone, name, parse } from '../validation.js';

const CreateBusinessBody = z.object({ name, timezone: timeZone }).strict();
export const CardSetupSchema = z
  .object({
    setupIntentId: z.string().describe('SetupIntent id for POST /billing/card.'),
    clientSecret: z.string().describe('SetupIntent client secret for Stripe.js card confirmation.'),
    publishableKey: z.string().describe('Stripe publishable key.'),
    stripeJsUrl: z.string().describe('URL to load Stripe.js from.'),
  })
  .nullable()
  .describe('Card setup details, or null if the payment gateway was unavailable.');
const CreateBusinessSchema = z.object({
  userId: z.string().uuid().describe('The newly assigned owner.'),
  tenantId: z.string().uuid().describe('The created business.'),
  role: z.literal('owner').describe('The user becomes the business owner.'),
  cardSetup: CardSetupSchema.describe('The card setup response.'),
});

const docs = {
  create: {
    tag: 'Businesses',
    auth: 'user',
    summary: 'Create a business',
    description:
      'Creates a business for the logged-in user, assigns them as owner, and starts card setup. If card setup is unavailable, call POST /billing/setup-intent. Save the card with Stripe.js and POST /billing/card.',
    body: CreateBusinessBody,
    responses: { 201: { description: 'Business created and user assigned as owner', schema: CreateBusinessSchema } },
    errors: {
      403: 'Only a user without a business can create one (`forbidden`).',
      409: 'The user already belongs to a business (`business_exists`).',
    },
  },
} satisfies Record<string, OperationDoc>;

export interface BusinessOptions {
  sql: Sql;
  stripe: StripeClient;
  publishableKey: string;
  stripeJsUrl: string;
}

export const businessRoutes: FastifyPluginAsync<BusinessOptions> = async (
  app,
  { sql, stripe, publishableKey, stripeJsUrl },
) => {
  app.post(
    '/businesses',
    withDoc({ preHandler: [authenticate, requireRole('unassigned')] }, docs.create),
    async (req, reply) => {
      const body = parse(CreateBusinessBody, req.body);
      const userId = req.auth!.userId;

      const tenantId = await withRetry(() =>
        sql.begin((tx) => createBusinessForUser(tx, userId, body.name, body.timezone)),
      );

      const user: AuthUser = { userId, tenantId, role: 'owner' };
      setAuthCookies(reply, user);
      const cardSetup = await cardSetupOrNull(sql, { stripe, publishableKey, stripeJsUrl }, tenantId, req.log);

      req.log.info({ userId, tenantId }, 'business created');
      return reply.status(201).send({ ...user, cardSetup });
    },
  );
};

/**
 * Creates a business with `userId` (an unassigned user) as its owner, inside the caller's
 * transaction. Shared by POST /businesses and the one-step POST /auth/signup.
 * Returns the new tenant id; 409 business_exists if the user already has a business.
 */
export async function createBusinessForUser(
  tx: TransactionSql,
  userId: string,
  businessName: string,
  timezone: string,
): Promise<string> {
  const [user] = await tx<{ id: string }[]>`
    select id from users
     where id = ${userId} and tenant_id is null and role = 'unassigned'
     for update`;
  if (!user) throw new HttpError(409, 'business_exists', 'This user already belongs to a business');

  const [created] = await tx<{ id: string }[]>`
    insert into tenants (name, timezone) values (${businessName}, ${timezone}) returning id`;
  await tx`
    insert into tenant_settings (tenant_id, included_extensions, included_us_minutes)
    values (${created!.id}, ${PLAN.includedExtensions}, ${PLAN.includedUsMinutes})`;
  const [owner] = await tx<{ id: string }[]>`
    update users set tenant_id = ${created!.id}, role = 'owner'
     where id = ${userId} and tenant_id is null and role = 'unassigned'
     returning id`;
  if (!owner) throw new HttpError(409, 'business_exists', 'This user already belongs to a business');
  return created!.id;
}

export interface CardSetupConfig {
  stripe: StripeClient;
  publishableKey: string;
  stripeJsUrl: string;
}

/** Starts card setup for a new business; null (logged) if the payment gateway is unavailable. */
export async function cardSetupOrNull(
  sql: Sql,
  cfg: CardSetupConfig,
  tenantId: string,
  log: FastifyBaseLogger,
): Promise<(CardSetup & { publishableKey: string; stripeJsUrl: string }) | null> {
  try {
    const setup = await startCardSetup(sql, cfg.stripe, tenantId);
    return { ...setup, publishableKey: cfg.publishableKey, stripeJsUrl: cfg.stripeJsUrl };
  } catch (err) {
    log.warn({ err, tenantId }, 'card setup failed after business creation');
    return null;
  }
}
