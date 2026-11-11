-- migrate:up
-- Recurring account items (docs/billing-flows.md §2-§4, §7 "Account items ... each with
-- started_at / removed_at / paid_through. These drive proration, renewal and non-renewal").
--
-- One row per thing the customer pays for every billing period:
--   plan           the base plan (one per account)
--   extension      one additional extension slot (beyond the plan's included ones)
--   number         a phone number (phone_number_id); mirrors phone_numbers.paid_until / status
--   intl_calling   international calling add-on
--   recording      call recording add-on
--
-- price_cents is the price per 7-day period when bought (renewals charge the same price).
-- paid_through is the end of the last period paid for. removed_at set = cancelled: the item keeps
-- working until paid_through and is not renewed. An item is "active" while
-- removed_at IS NULL OR paid_through > now().
--
-- Written by the API only. The call path keeps reading tenant_settings (intl_calling, record_calls)
-- and phone_numbers, which the API keeps in sync with these rows.

CREATE TABLE account_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('plan', 'extension', 'number', 'intl_calling', 'recording')),
  phone_number_id  uuid REFERENCES phone_numbers (id) ON DELETE SET NULL,
  price_cents      integer NOT NULL CHECK (price_cents >= 0),
  started_at       timestamptz NOT NULL DEFAULT now(),
  paid_through     timestamptz NOT NULL,
  removed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Only number items point at a number (it may become NULL if the number row is ever deleted).
  CHECK (kind = 'number' OR phone_number_id IS NULL)
);
CREATE INDEX account_items_tenant_idx ON account_items (tenant_id, kind);
-- Renewal scan (billing scheduler): items that renew.
CREATE INDEX account_items_renewing_idx ON account_items (paid_through) WHERE removed_at IS NULL;
-- At most one renewing plan / add-on of each kind per account, and one renewing item per number.
CREATE UNIQUE INDEX account_items_one_addon_idx ON account_items (tenant_id, kind)
  WHERE removed_at IS NULL AND kind IN ('plan', 'intl_calling', 'recording');
CREATE UNIQUE INDEX account_items_one_number_idx ON account_items (phone_number_id)
  WHERE removed_at IS NULL AND phone_number_id IS NOT NULL;

-- Item purchases reuse the idempotent purchase_requests flow of number purchases
-- (kind 'item'; request = {"kind": ...}).
ALTER TABLE purchase_requests
  ADD COLUMN account_item_id uuid REFERENCES account_items (id) ON DELETE SET NULL;

-- Backfill what accounts already have. Prices: services/api/src/billing/catalog.ts at the time
-- of this migration (plan 1900, local number 275, toll-free 300).
INSERT INTO account_items (tenant_id, kind, price_cents, started_at, paid_through)
SELECT ba.tenant_id, 'plan', 1900, ba.created_at, ba.plan_paid_through
  FROM billing_accounts ba
 WHERE ba.plan_paid_through IS NOT NULL;

INSERT INTO account_items (tenant_id, kind, phone_number_id, price_cents, started_at, paid_through, removed_at)
SELECT n.tenant_id, 'number', n.id, CASE n.kind WHEN 'toll_free' THEN 300 ELSE 275 END, n.purchased_at,
       coalesce(n.paid_until, now()), CASE WHEN n.status = 'released' THEN now() END
  FROM phone_numbers n
 WHERE n.tenant_id IS NOT NULL AND (n.status = 'assigned' OR n.paid_until > now());

-- migrate:down
ALTER TABLE purchase_requests DROP COLUMN account_item_id;
DROP TABLE account_items;
