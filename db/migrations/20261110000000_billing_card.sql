-- migrate:up
-- Saved card, first plan charge and the extension limit (course spec §1, §2, §5; API side of
-- docs/billing-flows.md §1). Written and read by the API only; telephony doesn't use these.

-- Extension limit: "The API must refuse to create more than the plan includes plus the
-- extensions bought" (billing-flows §3). included_extensions is set from the plan at signup;
-- extra_extensions by the extension purchase flow (not built yet).
ALTER TABLE tenant_settings
  ADD COLUMN included_extensions integer NOT NULL DEFAULT 0 CHECK (included_extensions >= 0),
  ADD COLUMN extra_extensions integer NOT NULL DEFAULT 0 CHECK (extra_extensions >= 0);
COMMENT ON COLUMN tenant_settings.included_extensions IS 'Extensions included in the plan';
COMMENT ON COLUMN tenant_settings.extra_extensions IS 'Additional extensions bought';

-- The account's Stripe customer and saved card. Card numbers never reach us: the browser saves
-- the card with Stripe.js (SetupIntent); we keep only Stripe's ids and the brand/last 4 to show.
CREATE TABLE billing_accounts (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  payment_method_id  text,                 -- default card (verified SetupIntent result)
  card_brand         text,
  card_last4         text,
  -- End of the period the plan is paid for. NULL until the first (prorated) plan charge
  -- succeeded; the account can't add extensions until then.
  plan_paid_through  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Every charge attempt we made, successful or not. idempotency_key is also the Stripe
-- Idempotency-Key, so a retried request can never charge twice.
CREATE TABLE payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  purpose                  text NOT NULL,          -- 'plan' (first prorated period); invoices later
  period_start             date,                   -- billing period the charge is for (local date)
  idempotency_key          text NOT NULL UNIQUE,
  amount_cents             integer NOT NULL CHECK (amount_cents >= 0),
  stripe_payment_intent_id text,
  status                   text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  failure_message          text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_tenant_idx ON payments (tenant_id, created_at);

-- migrate:down
DROP TABLE payments;
DROP TABLE billing_accounts;
ALTER TABLE tenant_settings DROP COLUMN extra_extensions, DROP COLUMN included_extensions;
