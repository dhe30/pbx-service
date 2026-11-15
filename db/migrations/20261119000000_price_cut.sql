-- migrate:up
-- Price cut (2026-11-15). Plan and item prices changed in services/api/src/billing/catalog.ts at
-- the same time.
-- Costs: US vendor $0.006/min (Alaska $0.015), incoming toll-free $0.025/min.
-- The call_pricing_notify trigger makes the ARI apps and the API reload the row: no restart.
UPDATE call_pricing
   SET us_per_min = 0.01,
       toll_free_in_per_min = 0.03;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.01,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.03;

-- Existing customers renew at each item's stored price_cents, so the new prices would only reach
-- new customers. Lower (never raise) the stored price of every item still renewing to the new
-- price list, so invoices never charge more than the published prices.
UPDATE account_items SET price_cents = 450 WHERE kind = 'plan'         AND removed_at IS NULL AND price_cents > 450;
UPDATE account_items SET price_cents = 49  WHERE kind = 'extension'    AND removed_at IS NULL AND price_cents > 49;
UPDATE account_items SET price_cents = 150 WHERE kind = 'intl_calling' AND removed_at IS NULL AND price_cents > 150;
UPDATE account_items SET price_cents = 150 WHERE kind = 'recording'    AND removed_at IS NULL AND price_cents > 150;
UPDATE account_items i SET price_cents = 215
  FROM phone_numbers n
 WHERE i.kind = 'number' AND i.removed_at IS NULL AND i.price_cents > 215
   AND n.id = i.phone_number_id AND n.kind = 'local';

-- migrate:down
-- Restores the per-minute prices. Items lowered above keep their lower price (a down migration
-- must never raise what a customer pays).
UPDATE call_pricing
   SET us_per_min = 0.025,
       toll_free_in_per_min = 0.04;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.025,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.04;
