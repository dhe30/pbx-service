-- migrate:up
-- Number purchase remembers what the DID provider charges us per answered incoming minute (DIDWW:
-- metered toll-free numbers), so the resumed purchase can store it on phone_numbers
-- (incoming_cost_per_min, read by the ARI app for the cost of incoming toll-free legs;
-- docs/telephony-contract.md §4). NULL = unknown: call_pricing.toll_free_in_cost_per_min applies.
ALTER TABLE purchase_requests ADD COLUMN incoming_cost_per_min numeric(12, 6);

-- migrate:down
ALTER TABLE purchase_requests DROP COLUMN incoming_cost_per_min;
