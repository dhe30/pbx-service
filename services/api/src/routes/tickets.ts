import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { HttpError } from '../errors.js';
import { metrics } from '../metrics.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { requireOperator } from '../operator.js';
import { PageQuery, decodeCursor, page } from '../paging.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';

// Support tickets (course spec §3). Simulated customers open a ticket when something fails for
// them and close it when it works again, so this is graded behaviour.
//
// Account side, any logged-in user (owner or staff) of the account:
// POST /tickets {subject, description}       201 ticket          400
// GET  /tickets?status&limit&cursor          200 { items: [ticket], nextCursor }   newest first
// GET  /tickets/:id                          200 ticket          404
// POST /tickets/:id/close                    200 ticket          404   (idempotent)
//
// Provider side (us), operator token (src/operator.ts), across ALL accounts:
// GET  /operator/tickets?status&limit&cursor 200 { items: [operatorTicket], nextCursor }  newest first, default open
// GET  /operator/tickets/:id                 200 operatorTicket  404
//
// Tickets go open -> closed only; a problem that comes back gets a new ticket.

const STATUSES = ['open', 'closed'] as const;

const CreateBody = z
  .object({
    subject: z.string().trim().min(1).max(200).describe('Short summary of the problem, 1-200 characters (trimmed).'),
    description: z.string().trim().min(1).max(10_000).describe('What happened, 1-10000 characters (trimmed).'),
  })
  .strict()
  .describe('A new support ticket.');

const ListQuery = z.object({
  status: z.enum(STATUSES).optional().describe('Only tickets with this status. Omitted = both.'),
  ...PageQuery,
});

const OperatorListQuery = z.object({
  status: z
    .enum([...STATUSES, 'all'])
    .default('open')
    .describe('open (default): tickets still open, newest first. closed: closed ones. all: both.'),
  ...PageQuery,
});

const TicketSchema = z
  .object({
    id: z.string().uuid().describe('Ticket id.'),
    subject: z.string().describe('Short summary.'),
    description: z.string().describe('What happened.'),
    status: z.enum(STATUSES).describe('open, or closed (by a user of the account).'),
    createdAt: z.date().describe('When it was opened.'),
    createdBy: z.string().uuid().nullable().describe('User who opened it; null if that user was deleted.'),
    createdByEmail: z.string().nullable().describe("That user's login email; null if the user was deleted."),
    closedAt: z.date().nullable().describe('When it was closed; null while open.'),
    closedBy: z.string().uuid().nullable().describe('User who closed it; null while open or if that user was deleted.'),
  })
  .describe('A support ticket.');

const OperatorTicketSchema = TicketSchema.extend({
  tenantId: z.string().uuid().describe('Account the ticket belongs to.'),
  tenantName: z.string().describe("That account's business name."),
}).describe("A support ticket, with the account it came from (provider view).");

const pageSchema = (item: z.ZodTypeAny, what: string) =>
  z
    .object({
      items: z.array(item).describe('Tickets, newest first.'),
      nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page.'),
    })
    .describe(`A page of ${what}.`);

const NOT_FOUND_DOC = 'No such ticket in this account (`not_found`).';
const OPERATOR_401 = 'Missing or wrong operator token (`unauthorized`).';

const docs = {
  create: {
    tag: 'Support',
    auth: 'user',
    summary: 'Open a support ticket',
    description:
      'Tell the provider something is wrong. The ticket starts `open` and shows up in the provider\'s view of open ' +
      'tickets right away. Close it (POST /tickets/{id}/close) when the problem is solved.',
    body: CreateBody,
    responses: { 201: { description: 'The new ticket', schema: TicketSchema } },
  },
  list: {
    tag: 'Support',
    auth: 'user',
    summary: "List the account's support tickets",
    description: 'Every ticket of the account (opened by any of its users), newest first. Paged with `cursor` / `nextCursor`.',
    query: ListQuery,
    responses: { 200: { description: 'A page of tickets', schema: pageSchema(TicketSchema, 'support tickets') } },
  },
  get: {
    tag: 'Support',
    auth: 'user',
    summary: 'Get a support ticket',
    params: IdParams,
    responses: { 200: { description: 'The ticket', schema: TicketSchema } },
    errors: { 404: NOT_FOUND_DOC },
  },
  close: {
    tag: 'Support',
    auth: 'user',
    summary: 'Close a support ticket',
    description:
      'Marks the ticket closed (the problem is solved). Idempotent: closing a closed ticket returns it unchanged. ' +
      'Closed tickets are not reopened; open a new ticket if the problem comes back.',
    params: IdParams,
    responses: { 200: { description: 'The closed ticket', schema: TicketSchema } },
    errors: { 404: NOT_FOUND_DOC },
  },
  operatorList: {
    tag: 'Operator',
    auth: 'operator',
    summary: 'List support tickets of all accounts (provider)',
    description:
      'For the provider (PBX operator), not customers: tickets of every account, newest first, open ones by ' +
      'default. Poll the first page to see new tickets as they come in. Paged with `cursor` / `nextCursor`.',
    query: OperatorListQuery,
    responses: { 200: { description: 'A page of tickets', schema: pageSchema(OperatorTicketSchema, 'support tickets of all accounts') } },
    errors: { 401: OPERATOR_401 },
  },
  operatorGet: {
    tag: 'Operator',
    auth: 'operator',
    summary: 'Get any support ticket (provider)',
    params: IdParams,
    responses: { 200: { description: 'The ticket', schema: OperatorTicketSchema } },
    errors: { 401: OPERATOR_401, 404: 'No such ticket (`not_found`).' },
  },
} satisfies Record<string, OperationDoc>;

interface TicketRow {
  id: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  description: string;
  status: (typeof STATUSES)[number];
  createdAt: Date;
  createdBy: string | null;
  createdByEmail: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  cursorTs: string;
}

const view = ({ tenantId: _t, tenantName: _n, cursorTs: _c, ...t }: TicketRow) => t;
const operatorView = ({ cursorTs: _c, ...t }: TicketRow) => t;

const notFound = () => new HttpError(404, 'not_found', 'No such ticket');

export const ticketRoutes: FastifyPluginAsync<{ sql: Sql; operatorToken: string | undefined }> = async (app, { sql, operatorToken }) => {
  const anyUser = { preHandler: [authenticate] };
  const operatorOnly = { preHandler: [requireOperator(operatorToken)] };

  const columns = sql`
    t.id, t.tenant_id, tn.name as tenant_name, t.subject, t.description, t.status, t.created_at,
    t.created_by, u.email as created_by_email, t.closed_at, t.closed_by,
    to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts`;
  const from = sql`
    support_tickets t
    join tenants tn on tn.id = t.tenant_id
    left join users u on u.id = t.created_by`;

  /** One ticket; tenantId null = any account (operator). */
  async function getOne(id: string, tenantId: string | null): Promise<TicketRow> {
    const [row] = await withRetry(
      () => sql<TicketRow[]>`
        select ${columns} from ${from}
         where t.id = ${id} ${tenantId ? sql`and t.tenant_id = ${tenantId}` : sql``}`,
    );
    if (!row) throw notFound();
    return row;
  }

  async function list(q: { status?: string; limit: number; cursor?: string }, tenantId: string | null) {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await withRetry(
      () => sql<TicketRow[]>`
        select ${columns} from ${from}
         where true
           ${tenantId ? sql`and t.tenant_id = ${tenantId}` : sql``}
           ${q.status ? sql`and t.status = ${q.status}` : sql``}
           ${cursor ? sql`and (t.created_at, t.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : sql``}
         order by t.created_at desc, t.id desc
         limit ${q.limit + 1}`,
    );
    return page(rows, q.limit);
  }

  app.post('/tickets', withDoc(anyUser, docs.create), async (req, reply) => {
    const tenantId = tenantOf(req);
    const { subject, description } = parse(CreateBody, req.body);
    // created_by through a tenant-scoped subquery: a user deleted since their token was issued
    // (it stays valid up to 15 min) gives NULL instead of a foreign-key error.
    const [created] = await withRetry(
      () => sql<{ id: string }[]>`
        insert into support_tickets (tenant_id, created_by, subject, description)
        values (${tenantId}, (select id from users where id = ${req.auth!.userId} and tenant_id = ${tenantId}),
                ${subject}, ${description})
        returning id`,
    );
    metrics.supportTicketsOpened.inc();
    req.log.info({ ticketId: created!.id, tenantId }, 'support ticket opened');
    return reply.status(201).send(view(await getOne(created!.id, tenantId)));
  });

  app.get('/tickets', withDoc(anyUser, docs.list), async (req) => {
    const { rows, nextCursor } = await list(parse(ListQuery, req.query), tenantOf(req));
    return { items: rows.map(view), nextCursor };
  });

  app.get('/tickets/:id', withDoc(anyUser, docs.get), async (req) => {
    const { id } = parse(IdParams, req.params);
    return view(await getOne(id, tenantOf(req)));
  });

  app.post('/tickets/:id/close', withDoc(anyUser, docs.close), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    // Only an open ticket changes; an already closed one keeps its closed_at / closed_by.
    const closed = await withRetry(
      () => sql`
        update support_tickets
           set status = 'closed', closed_at = now(),
               closed_by = (select id from users where id = ${req.auth!.userId} and tenant_id = ${tenantId})
         where id = ${id} and tenant_id = ${tenantId} and status = 'open'
        returning id`,
    );
    if (closed.length > 0) {
      metrics.supportTicketsClosed.inc();
      req.log.info({ ticketId: id, tenantId }, 'support ticket closed');
    }
    return view(await getOne(id, tenantId)); // 404 if it isn't this account's ticket
  });

  app.get('/operator/tickets', withDoc(operatorOnly, docs.operatorList), async (req) => {
    const q = parse(OperatorListQuery, req.query);
    const { rows, nextCursor } = await list({ ...q, status: q.status === 'all' ? undefined : q.status }, null);
    return { items: rows.map(operatorView), nextCursor };
  });

  app.get('/operator/tickets/:id', withDoc(operatorOnly, docs.operatorGet), async (req) => {
    const { id } = parse(IdParams, req.params);
    return operatorView(await getOne(id, null));
  });
};
