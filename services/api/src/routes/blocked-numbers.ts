import { normalizeDialed, withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';

// Caller blocklist (course spec §3). Calls from a listed number to any of the account's numbers
// are rejected (SIP 403) and logged with CDR outcome `blocked`. Owner-only.
//
// GET    /blocked-numbers            200 [blockedNumber]   newest first
// POST   /blocked-numbers {number}   201 blockedNumber     (200 if it was already blocked) 400
// DELETE /blocked-numbers/:number    204                   404
//
// blockedNumber = { number, createdAt }   number: E.164 ("+12015550123")
// Input formats (same as dialing): +E.164, 10-digit US, 1 + 10 digits, 011 + international;
// spaces, dashes, dots and parentheses are ignored. Stored and returned as E.164, which is how the
// ARI app normalizes caller numbers before comparing. In the DELETE URL, encode "+" as %2B (any
// accepted format works there too).

const phoneNumber = z
  .string()
  .max(40)
  .transform((s, ctx) => {
    const e164 = normalizeDialed(s);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a phone number, e.g. +12015550123 or 2015550123' });
      return z.NEVER;
    }
    return e164;
  });

const BlockBody = z.object({
  number: phoneNumber.describe('Caller number: +E.164, 10-digit US, 1 + 10 digits or 011 + international; separators ignored.'),
});
const NumberParams = z.object({
  number: phoneNumber.describe('The blocked number in any accepted format (encode "+" as %2B).'),
});

interface BlockedNumber {
  number: string;
  createdAt: Date;
}

const BlockedSchema = z
  .object({
    number: z.string().describe('Blocked caller number, E.164.'),
    createdAt: z.date().describe('When it was blocked.'),
  })
  .describe('A blocked caller.');

const docs = {
  list: {
    tag: 'Blocklist',
    auth: 'owner',
    summary: 'List blocked numbers',
    description: 'Newest first.',
    responses: { 200: { description: 'Blocked numbers', schema: z.array(BlockedSchema).describe('Blocked numbers.') } },
  },
  block: {
    tag: 'Blocklist',
    auth: 'owner',
    summary: 'Block a caller',
    description: 'Calls from this number are rejected. Idempotent: blocking a blocked number returns it with 200.',
    body: BlockBody,
    responses: {
      201: { description: 'Newly blocked', schema: BlockedSchema },
      200: { description: 'Was already blocked', schema: BlockedSchema },
    },
  },
  unblock: {
    tag: 'Blocklist',
    auth: 'owner',
    summary: 'Unblock a caller',
    params: NumberParams,
    responses: { 204: { description: 'Unblocked' } },
    errors: { 404: 'The number is not blocked (`not_found`).' },
  },
} satisfies Record<string, OperationDoc>;

export const blockedNumberRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/blocked-numbers', withDoc(ownerOnly, docs.list), async (req) => {
    return withRetry(
      () => sql<BlockedNumber[]>`
        select number, created_at from blocked_numbers
         where tenant_id = ${tenantOf(req)}
         order by created_at desc, number`,
    );
  });

  app.post('/blocked-numbers', withDoc(ownerOnly, docs.block), async (req, reply) => {
    const tenantId = tenantOf(req);
    const { number } = parse(BlockBody, req.body);
    // Idempotent: blocking a number twice is not an error (safe for client retries). The no-op
    // update makes RETURNING give the existing row; xmax = 0 only for a freshly inserted row.
    const [row] = await withRetry(
      () => sql<(BlockedNumber & { inserted: boolean })[]>`
        insert into blocked_numbers (tenant_id, number) values (${tenantId}, ${number})
        on conflict (tenant_id, number) do update set number = excluded.number
        returning number, created_at, (xmax = 0) as inserted`,
    );
    const { inserted, ...blocked } = row!;
    return reply.status(inserted ? 201 : 200).send(blocked);
  });

  app.delete('/blocked-numbers/:number', withDoc(ownerOnly, docs.unblock), async (req, reply) => {
    const { number } = parse(NumberParams, req.params);
    const rows = await withRetry(
      () => sql`
        delete from blocked_numbers where tenant_id = ${tenantOf(req)} and number = ${number} returning number`,
    );
    if (rows.length === 0) throw new HttpError(404, 'not_found', 'This number is not blocked');
    return reply.status(204).send();
  });
};
