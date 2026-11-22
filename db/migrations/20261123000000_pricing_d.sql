-- migrate:up
-- Repricing (2026-11-22). Sets the standard price list (services/api/src/billing/catalog.ts); the
-- API's billing scheduler may switch this row to the alternate list (applyCallPricing).
-- Standard: plan $2.89 with 70 extensions and 650 US minutes, extra extension $0.08, local number
-- $1.45, toll-free number $2.45, add-ons $0.55; US $0.0066/min, incoming toll-free $0.012/min,
-- international vendor rate x 1.1 (at least $0.01).
-- The call_pricing_notify trigger makes the ARI apps and the API reload the row: no restart.

-- ---- Per-minute -----------------------------------------------------------------------------
UPDATE call_pricing
   SET us_per_min = 0.0066,
       intl_multiplier = 1.1,
       toll_free_in_per_min = 0.012;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.0066,
  ALTER COLUMN intl_multiplier SET DEFAULT 1.1,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.012;

-- ---- Existing customers: plan allowances (raise, never lower) -----------------------------
UPDATE tenant_settings SET included_extensions = 70  WHERE included_extensions < 70;
UPDATE tenant_settings SET included_us_minutes = 650 WHERE included_us_minutes < 650;

-- Paid extension slots the bigger allowance makes unnecessary are cancelled, so nobody keeps paying
-- for extensions the plan now includes. Each account keeps max(0, extensions - included) slots (its
-- newest ones are cancelled first); a cancelled slot keeps working to paid_through and is not
-- renewed (same as DELETE /billing/items/:id).
WITH need AS (
  SELECT ts.tenant_id,
         greatest(0, (SELECT count(*) FROM extensions e WHERE e.tenant_id = ts.tenant_id)
                     - ts.included_extensions) AS keep
    FROM tenant_settings ts
), ranked AS (
  SELECT i.id, i.tenant_id,
         row_number() OVER (PARTITION BY i.tenant_id ORDER BY i.created_at, i.id) AS n
    FROM account_items i
   WHERE i.kind = 'extension' AND i.removed_at IS NULL
)
UPDATE account_items a
   SET removed_at = now()
  FROM ranked r JOIN need n ON n.tenant_id = r.tenant_id
 WHERE a.id = r.id AND r.n > n.keep;

UPDATE tenant_settings ts
   SET extra_extensions = (SELECT count(*)::int FROM account_items i
                            WHERE i.tenant_id = ts.tenant_id AND i.kind = 'extension' AND i.removed_at IS NULL)
 WHERE extra_extensions IS DISTINCT FROM (SELECT count(*)::int FROM account_items i
                            WHERE i.tenant_id = ts.tenant_id AND i.kind = 'extension' AND i.removed_at IS NULL);

-- ---- Existing customers: lower (never raise) every renewing item to the new prices -------------
UPDATE account_items SET price_cents = 289 WHERE kind = 'plan'         AND removed_at IS NULL AND price_cents > 289;
UPDATE account_items SET price_cents = 8   WHERE kind = 'extension'    AND removed_at IS NULL AND price_cents > 8;
UPDATE account_items SET price_cents = 55  WHERE kind = 'intl_calling' AND removed_at IS NULL AND price_cents > 55;
UPDATE account_items SET price_cents = 55  WHERE kind = 'recording'    AND removed_at IS NULL AND price_cents > 55;
UPDATE account_items i SET price_cents = 145
  FROM phone_numbers n
 WHERE i.kind = 'number' AND i.removed_at IS NULL AND i.price_cents > 145
   AND n.id = i.phone_number_id AND n.kind = 'local';
UPDATE account_items i SET price_cents = 245
  FROM phone_numbers n
 WHERE i.kind = 'number' AND i.removed_at IS NULL AND i.price_cents > 245
   AND n.id = i.phone_number_id AND n.kind = 'toll_free';

-- migrate:down
-- Restores the per-minute prices. Lowered items, raised allowances and cancelled slots stay as they
-- are (a down migration must never raise what a customer pays). Also deploy the previous API, or
-- its scheduler keeps switching the row between the two lists.
UPDATE call_pricing
   SET us_per_min = 0.007,
       intl_multiplier = 1.15,
       toll_free_in_per_min = 0.027;
ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.007,
  ALTER COLUMN intl_multiplier SET DEFAULT 1.15,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.027;
