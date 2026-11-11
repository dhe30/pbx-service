import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { HttpError } from '../errors.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';

// Invoices (course spec §5: "Customers see all invoices on the web and through the API").
// Written by the billing scheduler (src/billing/scheduler.ts), one per account per weekly period.
//
// GET /invoices       owner  200 [invoice]                 newest first
// GET /invoices/:id   owner  200 invoice + lines           404

const STATUSES = ['open', 'paid', 'failed'] as const;

const InvoiceSchema = z
  .object({
    id: z.string().uuid().describe('Invoice id.'),
    periodStart: z.date().describe('Start of the billing period whose recurring charges this invoice pays in advance.'),
    periodEnd: z.date().describe('End of that period.'),
    usageFrom: z.date().describe('Start of the ended period whose call usage is billed.'),
    usageTo: z.date().describe('End of the ended period.'),
    recurringCents: z.number().int().describe('Plan, additional extensions, numbers and add-ons for the new period, US cents.'),
    usageCents: z.number().int().describe('Call charges of the ended period (summed, then rounded once), US cents.'),
    totalCents: z.number().int().describe('Amount charged to the card, US cents.'),
    includedMinutesUsed: z.number().describe("Plan US minutes used in the ended period (shared by the account)."),
    status: z.enum(STATUSES).describe('open: not charged yet. paid. failed: the last charge was declined; retried automatically.'),
    pastDue: z.boolean().describe('Unpaid more than 24 h after the ended period: outgoing calls are blocked until it is paid (add a card).'),
    attempts: z.number().int().describe('Charge attempts so far.'),
    lastError: z.string().nullable().describe('Why the last charge failed; null if none failed.'),
    nextAttemptAt: z.date().nullable().describe('When the next charge attempt runs; null when paid.'),
    paidAt: z.date().nullable().describe('When it was paid.'),
    createdAt: z.date().describe('When it was issued.'),
  })
  .describe('A weekly invoice.');

const LineSchema = z
  .object({
    kind: z.enum(['recurring', 'usage']).describe('recurring: an item for the new period. usage: one charged call leg.'),
    description: z.string().describe('What it is, e.g. "Phone number +12015550100" or "Call to +4420..., 66 s billed".'),
    itemKind: z.string().nullable().describe('For recurring lines: plan, extension, number, intl_calling or recording.'),
    callId: z.string().uuid().nullable().describe('For usage lines: the call (GET /calls/{callId}).'),
    startedAt: z.date().nullable().describe('For usage lines: when the call started.'),
    billableSec: z.number().int().nullable().describe('For usage lines: billed seconds (30/6 increments).'),
    amount: z.number().describe('USD. Usage lines keep fractions of a cent; the invoice total rounds their sum once.'),
  })
  .describe('An invoice line.');

const InvoiceDetailSchema = InvoiceSchema.extend({
  lines: z.array(LineSchema).describe('Recurring lines first, then one usage line per charged call leg, oldest first.'),
}).describe('A weekly invoice with its lines.');

const docs = {
  list: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'List invoices',
    description:
      'Every invoice of the account, newest first. Issued within an hour after each 7-day billing period ends: the new ' +
      "period's recurring charges plus the ended period's call usage, charged to the saved card (failures are retried).",
    responses: { 200: { description: 'Invoices', schema: z.array(InvoiceSchema).describe('Invoices, newest first.') } },
  },
  get: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Get an invoice with its lines',
    params: IdParams,
    responses: { 200: { description: 'The invoice', schema: InvoiceDetailSchema } },
    errors: { 404: 'No such invoice in this account (`not_found`).' },
  },
} satisfies Record<string, OperationDoc>;

interface InvoiceRow {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  usageFrom: Date;
  usageTo: Date;
  recurringCents: number;
  usageCents: number;
  totalCents: number;
  includedSecUsed: string; // bigint
  status: (typeof STATUSES)[number];
  pastDue: boolean;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

const view = ({ includedSecUsed, ...r }: InvoiceRow) => ({ ...r, includedMinutesUsed: Math.round((Number(includedSecUsed) / 60) * 100) / 100 });

export const invoiceRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };
  const columns = sql`
    id, period_start_at as period_start, period_end_at as period_end, usage_from, usage_to, recurring_cents,
    usage_cents, total_cents, included_sec_used, status, status <> 'paid' and due_at <= now() as past_due,
    attempts, last_error, next_attempt_at, paid_at, created_at`;

  app.get('/invoices', withDoc(ownerOnly, docs.list), async (req) => {
    const rows = await withRetry(
      () => sql<InvoiceRow[]>`select ${columns} from invoices where tenant_id = ${tenantOf(req)} order by period_start desc`,
    );
    return rows.map(view);
  });

  app.get('/invoices/:id', withDoc(ownerOnly, docs.get), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(() => sql<InvoiceRow[]>`select ${columns} from invoices where id = ${id} and tenant_id = ${tenantId}`);
    if (!row) throw new HttpError(404, 'not_found', 'No such invoice');
    const lines = await withRetry(
      () => sql<{ kind: 'recurring' | 'usage'; description: string; itemKind: string | null; callId: string | null; startedAt: Date | null; billableSec: number | null; amount: string }[]>`
        select kind, description, item_kind, call_id, started_at, billable_sec, amount
          from invoice_lines where invoice_id = ${id}
         order by kind = 'usage', array_position(array['plan', 'extension', 'number', 'intl_calling', 'recording'], item_kind),
                  started_at, description, id`,
    );
    return { ...view(row), lines: lines.map((l) => ({ ...l, amount: Number(l.amount) })) };
  });
};
