-- migrate:up
-- Number purchase (backend step 8, docs/backend-step8.md): a resumable, idempotent purchase.
--
-- purchase_requests is keyed by the client's Idempotency-Key (scoped per tenant by the API: the
-- stored key is "<tenant_id>:<client key>"). Each step records its result here, so a retry with
-- the same key continues where the last attempt stopped instead of ordering or charging twice:
--   pending -> ordered (provider_order_id, provider_did_id, did) -> completed (phone_number_id)
--   any step -> failed (error_code, error_message; replayed to retries)
ALTER TABLE purchase_requests
  ADD COLUMN kind              text NOT NULL DEFAULT 'number',
  -- What was asked for; a retry with the same key but a different request is refused.
  ADD COLUMN request           jsonb,
  ADD COLUMN provider_order_id text,
  ADD COLUMN provider_did_id   text,
  ADD COLUMN did               text,
  ADD COLUMN number_kind       number_kind,
  ADD COLUMN amount_cents      integer,
  ADD COLUMN error_code        text,
  ADD COLUMN error_message     text,
  -- Doubles as a lease: an attempt refreshes it; a 'pending'/'ordered' row untouched for a while
  -- belongs to a crashed attempt and may be resumed.
  ADD COLUMN updated_at        timestamptz NOT NULL DEFAULT now();
ALTER TABLE purchase_requests
  ADD CONSTRAINT purchase_requests_status_check
  CHECK (status IN ('pending', 'ordered', 'completed', 'failed'));
CREATE INDEX purchase_requests_tenant_idx ON purchase_requests (tenant_id, created_at DESC);

COMMENT ON COLUMN phone_numbers.provider_ref IS 'DID provider (DIDWW) DID id';

-- migrate:down
DROP INDEX IF EXISTS purchase_requests_tenant_idx;
ALTER TABLE purchase_requests DROP CONSTRAINT IF EXISTS purchase_requests_status_check;
ALTER TABLE purchase_requests
  DROP COLUMN kind, DROP COLUMN request, DROP COLUMN provider_order_id, DROP COLUMN provider_did_id,
  DROP COLUMN did, DROP COLUMN number_kind, DROP COLUMN amount_cents, DROP COLUMN error_code,
  DROP COLUMN error_message, DROP COLUMN updated_at;
COMMENT ON COLUMN phone_numbers.provider_ref IS NULL;
