-- migrate:up
-- Competitive per-minute prices (2026-11-13). The course market compares public price lists
-- before signing up; at the old prices no simulated customer signed up. Plan and item prices
-- changed in services/api/src/billing/catalog.ts at the same time.
-- Costs: US vendor $0.006/min (Hawaii $0.012, Alaska $0.015), international vendor ~$0.01/min
-- for UK/Canada, incoming toll-free $0.025/min. Ceilings (spec §2) are the CHECK constraints.
-- The call_pricing_notify trigger makes the ARI apps and the API reload the row: no restart.
UPDATE call_pricing
   SET us_per_min = 0.025,
       toll_free_in_per_min = 0.04,
       intl_multiplier = 2.5,
       intl_min_per_min = 0.02;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.025,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.04,
  ALTER COLUMN intl_multiplier SET DEFAULT 2.5,
  ALTER COLUMN intl_min_per_min SET DEFAULT 0.02;

-- migrate:down
UPDATE call_pricing
   SET us_per_min = 0.05,
       toll_free_in_per_min = 0.055,
       intl_multiplier = 5,
       intl_min_per_min = 0.06;

ALTER TABLE call_pricing
  ALTER COLUMN us_per_min SET DEFAULT 0.05,
  ALTER COLUMN toll_free_in_per_min SET DEFAULT 0.055,
  ALTER COLUMN intl_multiplier SET DEFAULT 5,
  ALTER COLUMN intl_min_per_min SET DEFAULT 0.06;
