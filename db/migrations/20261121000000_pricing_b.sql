-- migrate:up
-- Repricing (2026-11-17). Plan and item prices changed in services/api/src/billing/catalog.ts at
-- the same time: plan $3.50 with 20 included extensions (was $4.50 with 5), extra extension $0.25,
-- international calling and call recording add-ons $0.89, local number $1.95.
-- Costs: US vendor $0.006/min (Alaska $0.015, Hawaii $0.012), incoming toll-free $0.025/min, local
-- number $1.50 per period; extensions and add-ons have no direct cost.
-- The call_pricing_notify trigger makes the ARI apps and the API reload the row: no restart.

-- ---- Per-minute -----------------------------------------------------------------------------
-- US $0.009 (was $0.01); international = vendor rate x 1.3, at least $0.01 (was x 2.5, at least
-- $0.02). Incoming toll-free stays $0.03 (cost $0.025).
UPDATE call_pricing
   SET us_per_min = 0.009,
       intl_multiplier = 1.3,
       intl_min_per_min = 0.01;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.009,
  ALTER COLUMN intl_multiplier SET DEFAULT 1.3,
  ALTER COLUMN intl_min_per_min SET DEFAULT 0.01;

-- ---- Existing customers: lower (never raise) every renewing item to the new prices -------------
UPDATE account_items SET price_cents = 350 WHERE kind = 'plan'         AND removed_at IS NULL AND price_cents > 350;
UPDATE account_items SET price_cents = 25  WHERE kind = 'extension'    AND removed_at IS NULL AND price_cents > 25;
UPDATE account_items SET price_cents = 89  WHERE kind = 'intl_calling' AND removed_at IS NULL AND price_cents > 89;
UPDATE account_items SET price_cents = 89  WHERE kind = 'recording'    AND removed_at IS NULL AND price_cents > 89;
UPDATE account_items i SET price_cents = 195
  FROM phone_numbers n
 WHERE i.kind = 'number' AND i.removed_at IS NULL AND i.price_cents > 195
   AND n.id = i.phone_number_id AND n.kind = 'local';

-- ---- Existing customers: 20 included extensions -----------------------------------------------
-- The plan now includes 20 extensions (was 5). An account that bought extra extension slots no
-- longer pays for up to 15 of them: those slots stop renewing (still paid until their period
-- ends). Its extension limit (included + renewing slots) never goes down:
-- 20 + max(0, slots - 15) >= 5 + slots.
WITH ranked AS (
  SELECT id, tenant_id,
         row_number() OVER (PARTITION BY tenant_id ORDER BY started_at DESC, id) AS n,
         15 - greatest(0, (SELECT included_extensions FROM tenant_settings ts WHERE ts.tenant_id = a.tenant_id) - 5) AS freed
    FROM account_items a
   WHERE kind = 'extension' AND removed_at IS NULL
)
UPDATE account_items i SET removed_at = now()
  FROM ranked r
 WHERE i.id = r.id AND r.n <= r.freed;

UPDATE tenant_settings SET included_extensions = 20 WHERE included_extensions < 20;

-- extra_extensions = renewing extension slots (what services/api/src/billing/items.ts syncSettings
-- derives), recomputed for every account after the change above.
UPDATE tenant_settings ts
   SET extra_extensions = (SELECT count(*)::int FROM account_items a
                            WHERE a.tenant_id = ts.tenant_id AND a.kind = 'extension' AND a.removed_at IS NULL)
 WHERE extra_extensions IS DISTINCT FROM (SELECT count(*)::int FROM account_items a
                                           WHERE a.tenant_id = ts.tenant_id AND a.kind = 'extension' AND a.removed_at IS NULL);

-- migrate:down
-- Restores the per-minute prices. Lowered items, freed slots and included extensions stay as they
-- are (a down migration must never raise what a customer pays or take away what they have).
UPDATE call_pricing
   SET us_per_min = 0.01,
       intl_multiplier = 2.5,
       intl_min_per_min = 0.02;
ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.01,
  ALTER COLUMN intl_multiplier SET DEFAULT 2.5,
  ALTER COLUMN intl_min_per_min SET DEFAULT 0.02;
