-- migrate:up
-- Prepaid usage. Usage is sold in advance: every account keeps a credit balance, topped up
-- automatically on its saved card, and each charged call leg is deducted from it as the call
-- ends. Recurring items stay on the weekly invoice. The model applies to every account.
--
--   tenants.prepaid_since   usage of calls started at or after this time is prepaid (deducted
--                           from credit); earlier usage is invoiced the old way. Existing accounts
--                           switch at migration time, new accounts at signup (column default).
--   credit_balances         one row per account: the balance in USD (6 decimals, like cdrs.charge).
--                           May go below zero between a call and the next top-up: calls are never
--                           refused for lack of credit while the card works.
--   billing_accounts.topup_*  top-up attempt state (Stripe idempotency key + retry backoff).
--   payments.purpose 'topup'  every top-up charge (succeeded or failed).
--   invoices.credit_charged_cents / usage_deducted_cents  shown on the weekly invoice, not charged.
--
-- The deduction is a trigger on cdrs, so it commits together with the call record (no call-app
-- change, no double deduction: ON CONFLICT DO NOTHING inserts fire no trigger).

ALTER TABLE tenants ADD COLUMN prepaid_since timestamptz;
UPDATE tenants SET prepaid_since = now();
ALTER TABLE tenants ALTER COLUMN prepaid_since SET DEFAULT now();

CREATE TABLE credit_balances (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  credit      numeric(14, 6) NOT NULL DEFAULT 0,   -- USD
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE billing_accounts
  ADD COLUMN topup_seq        integer NOT NULL DEFAULT 0,   -- successful top-ups so far
  ADD COLUMN topup_attempts   integer NOT NULL DEFAULT 0,   -- failed attempts of the next one
  ADD COLUMN topup_retry_at   timestamptz;                  -- after a decline: not before this

ALTER TABLE invoices
  ADD COLUMN credit_charged_cents  integer NOT NULL DEFAULT 0,
  ADD COLUMN usage_deducted_cents  integer NOT NULL DEFAULT 0;

CREATE INDEX payments_topup_idx ON payments (tenant_id, created_at) WHERE purpose = 'topup';

CREATE FUNCTION pbx_deduct_prepaid_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.charge > 0 AND EXISTS (
       SELECT 1 FROM tenants t
        WHERE t.id = NEW.tenant_id AND t.prepaid_since IS NOT NULL AND NEW.started_at >= t.prepaid_since) THEN
    INSERT INTO credit_balances (tenant_id, credit) VALUES (NEW.tenant_id, -NEW.charge)
    ON CONFLICT (tenant_id) DO UPDATE
      SET credit = credit_balances.credit - NEW.charge, updated_at = now();
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER cdrs_deduct_prepaid AFTER INSERT ON cdrs
  FOR EACH ROW EXECUTE FUNCTION pbx_deduct_prepaid_usage();

-- migrate:down
DROP TRIGGER cdrs_deduct_prepaid ON cdrs;
DROP FUNCTION pbx_deduct_prepaid_usage();
DROP INDEX payments_topup_idx;
ALTER TABLE invoices DROP COLUMN usage_deducted_cents, DROP COLUMN credit_charged_cents;
ALTER TABLE billing_accounts DROP COLUMN topup_retry_at, DROP COLUMN topup_attempts, DROP COLUMN topup_seq;
DROP TABLE credit_balances;
ALTER TABLE tenants DROP COLUMN prepaid_since;
