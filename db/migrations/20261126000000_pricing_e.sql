-- migrate:up
-- Per-minute prices (2026-11-26), standard list: US $0.0067/min, incoming toll-free $0.025/min
-- (services/shared/src/billing.ts, CALL_PRICING.standard). International is unchanged. The API's
-- billing scheduler still switches this row to the alternate list during ALT_WINDOW.
-- The call_pricing_notify trigger makes the ARI apps and the API reload the row: no restart.
UPDATE call_pricing
   SET us_per_min = 0.0067,
       toll_free_in_per_min = 0.025;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.0067,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.025;

-- migrate:down
-- Restores the previous standard per-minute prices. Also deploy the previous API, or its scheduler
-- keeps switching the row to the values in its own code.
UPDATE call_pricing
   SET us_per_min = 0.0066,
       toll_free_in_per_min = 0.012;
ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.0066,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.012;
