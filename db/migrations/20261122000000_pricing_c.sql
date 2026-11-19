-- migrate:up
-- Repricing (2026-11-18), closer to cost. Item prices changed in services/api/src/billing/catalog.ts
-- at the same time: extra extension $0.10 (was $0.25), international calling and call recording
-- add-ons $0.59 (were $0.89; below $0.50 a prorated purchase would never reach the card), local
-- number $1.65 (was $1.95). Plan $3.50 with 20 extensions and toll-free number $3.50 stay.
-- Costs: US vendor $0.006/min (Alaska $0.015, Hawaii $0.012), incoming toll-free $0.025/min, local
-- number $1.50 per period, toll-free number $3.00 per period; extensions and add-ons have none.
-- The call_pricing_notify trigger makes the ARI apps and the API reload the row: no restart.

-- ---- Per-minute -----------------------------------------------------------------------------
-- US $0.007 (was $0.009); international = vendor rate x 1.15, at least $0.01 (was x 1.3);
-- incoming toll-free $0.027 (was $0.03).
UPDATE call_pricing
   SET us_per_min = 0.007,
       intl_multiplier = 1.15,
       toll_free_in_per_min = 0.027;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.007,
  ALTER COLUMN intl_multiplier SET DEFAULT 1.15,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.027;

-- ---- Existing customers: lower (never raise) every renewing item to the new prices -------------
UPDATE account_items SET price_cents = 10 WHERE kind = 'extension'    AND removed_at IS NULL AND price_cents > 10;
UPDATE account_items SET price_cents = 59 WHERE kind = 'intl_calling' AND removed_at IS NULL AND price_cents > 59;
UPDATE account_items SET price_cents = 59 WHERE kind = 'recording'    AND removed_at IS NULL AND price_cents > 59;
UPDATE account_items i SET price_cents = 165
  FROM phone_numbers n
 WHERE i.kind = 'number' AND i.removed_at IS NULL AND i.price_cents > 165
   AND n.id = i.phone_number_id AND n.kind = 'local';

-- migrate:down
-- Restores the per-minute prices. Lowered items stay lowered (a down migration must never raise
-- what a customer pays).
UPDATE call_pricing
   SET us_per_min = 0.009,
       intl_multiplier = 1.3,
       toll_free_in_per_min = 0.03;
ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.009,
  ALTER COLUMN intl_multiplier SET DEFAULT 1.3,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.03;
