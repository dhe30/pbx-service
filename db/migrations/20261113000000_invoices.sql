-- migrate:up
-- Weekly invoices (course spec §5; docs/billing-flows.md §4-§5). Written by the API's billing
-- scheduler (services/api/src/billing/scheduler.ts), read by GET /invoices.
--
-- "Within one hour after a period ends, invoice the new period's recurring charges plus the ended
-- period's usage itemized by call, and charge the card; retry failures." One invoice per account
-- per period:
--   period_start_at .. period_end_at   the NEW period whose recurring items are paid in advance;
--   usage_from .. usage_to             the ENDED period whose usage (cdrs.charge) is billed.
-- status: open (not charged yet), paid, failed (last attempt declined; retried at next_attempt_at).
-- due_at = end of the ended period + 24 h: unpaid after that, the account becomes past_due.

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  period_start       date NOT NULL,             -- local date the new period starts (account time zone)
  period_start_at    timestamptz NOT NULL,
  period_end_at      timestamptz NOT NULL,
  usage_from         timestamptz NOT NULL,
  usage_to           timestamptz NOT NULL,
  recurring_cents    integer NOT NULL CHECK (recurring_cents >= 0),
  -- The ended period's usage, summed THEN rounded once to cents (billing-flows §8.3).
  usage_cents        integer NOT NULL CHECK (usage_cents >= 0),
  total_cents        integer NOT NULL CHECK (total_cents >= 0),
  -- Plan US seconds used in the ended period (usage_periods.included_sec_used).
  included_sec_used  bigint NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'failed')),
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz,
  last_error         text,
  paid_at            timestamptz,
  due_at             timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, period_start DESC);
-- Charge / retry scan and past-due scan.
CREATE INDEX invoices_unpaid_idx ON invoices (next_attempt_at) WHERE status IN ('open', 'failed');

-- recurring: one per renewed item (amount = its price). usage: one per charged call leg.
CREATE TABLE invoice_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('recurring', 'usage')),
  description      text NOT NULL,
  account_item_id  uuid REFERENCES account_items (id) ON DELETE SET NULL,
  item_kind        text,
  cdr_id           uuid,
  call_id          uuid,
  started_at       timestamptz,
  billable_sec     integer,
  amount           numeric(12, 6) NOT NULL   -- USD
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id, kind, started_at);

-- Invoice charge attempts are payments rows too (purpose 'invoice').
ALTER TABLE payments ADD COLUMN invoice_id uuid REFERENCES invoices (id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE payments DROP COLUMN invoice_id;
DROP TABLE invoice_lines;
DROP TABLE invoices;
