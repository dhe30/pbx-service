-- migrate:up
-- Telephony data model for the course spec (2026-11-09). What changed and why:
-- docs/telephony-contract.md (contract for the API/web teams) and docs/spec-transition.md.
--
-- Summary:
--   * Extensions replace "staff users with a SIP account": number per account, SIP creds
--     (kamailio.subscriber), mailbox, forwarding, external numbers to ring.
--   * Destinations (jsonb, zod-validated in services/shared/src/ivr-config.ts) for number routing,
--     IVR options, ring group no-answer, business hours.
--   * Per-leg CDRs (cdrs) replace `calls`. Insert-only, written by the ARI app at hangup.
--   * Rate decks, call pricing, per-period included-minute usage.
--   * NOTIFY triggers so the ARI app's in-memory config cache stays fresh (B6).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE account_status AS ENUM ('active', 'past_due');
CREATE TYPE number_kind AS ENUM ('local', 'toll_free');
CREATE TYPE cdr_direction AS ENUM ('incoming', 'outgoing', 'internal');
CREATE TYPE cdr_outcome AS ENUM ('answered', 'busy', 'no_answer', 'failed', 'blocked');
CREATE TYPE pstn_vendor AS ENUM ('us', 'intl');

-- ---- Accounts --------------------------------------------------------------------------------
-- timezone: fixed after signup; governs billing periods and business hours.
-- status:   written by billing. past_due blocks outgoing calls (unblock within 1 min of payment:
--           the ARI app's cache is invalidated by NOTIFY and never older than 30 s).
ALTER TABLE tenants
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN status account_status NOT NULL DEFAULT 'active';

-- Add-ons and plan values the call path needs. Billing/API owns writing them.
ALTER TABLE tenant_settings
  ADD COLUMN intl_calling boolean NOT NULL DEFAULT false,
  ADD COLUMN included_us_minutes integer NOT NULL DEFAULT 0 CHECK (included_us_minutes >= 0);
COMMENT ON COLUMN tenant_settings.record_calls IS 'Call recording add-on active';
COMMENT ON COLUMN tenant_settings.intl_calling IS 'International calling add-on active';
COMMENT ON COLUMN tenant_settings.included_us_minutes IS 'US minutes included per billing period (plan, shared by the account)';

-- ---- Extensions ------------------------------------------------------------------------------
CREATE TABLE extensions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number             text NOT NULL CHECK (number ~ '^[0-9]{1,8}$'),
  name               text NOT NULL,
  -- Globally unique (one SIP domain for every account). Same value as kamailio.subscriber.username.
  sip_username       text NOT NULL UNIQUE,
  mailbox_id         uuid REFERENCES mailboxes (id) ON DELETE SET NULL,
  -- Seconds to ring the extension's devices before forward_no_answer / voicemail.
  ring_timeout_sec   integer NOT NULL DEFAULT 20 CHECK (ring_timeout_sec BETWEEN 5 AND 120),
  -- Forwarding, each {"type":"extension","id":...} or {"type":"external","number":"+1..."} or null.
  forward_always     jsonb,
  forward_busy       jsonb,
  forward_no_answer  jsonb,
  -- External numbers (E.164) rung together with the devices; each is a charged outgoing leg.
  external_numbers   text[] NOT NULL DEFAULT '{}',
  -- Caller ID for outgoing calls; must be one of the account's numbers (else the first one is used).
  caller_id_number   text,
  -- Web user whose softphone uses this extension by default (optional).
  user_id            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX extensions_tenant_idx ON extensions (tenant_id);

-- ---- Ring groups: members are extensions now --------------------------------------------------
DROP TABLE ring_group_members;
CREATE TABLE ring_group_members (
  ring_group_id  uuid NOT NULL REFERENCES ring_groups (id) ON DELETE CASCADE,
  extension_id   uuid NOT NULL REFERENCES extensions (id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ring_group_id, extension_id)
);
CREATE INDEX ring_group_members_ext_idx ON ring_group_members (extension_id);
-- 'all': ring_timeout_sec is the total ring time. 'sequential': each member rings that long.
ALTER TABLE ring_groups ADD COLUMN no_answer_destination jsonb;
UPDATE ring_groups SET no_answer_destination = jsonb_build_object('type', 'voicemail', 'id', fallback_mailbox_id)
 WHERE fallback_mailbox_id IS NOT NULL;
COMMENT ON COLUMN ring_groups.fallback_mailbox_id IS 'DEPRECATED: use no_answer_destination';

-- ---- Business hours --------------------------------------------------------------------------
CREATE TABLE business_hours (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                text NOT NULL,
  -- {"intervals":[{"day":1,"start":"09:00","end":"17:00"}, ...]}  day 0 = Sunday, account TZ.
  schedule            jsonb NOT NULL DEFAULT '{"intervals": []}',
  open_destination    jsonb NOT NULL DEFAULT '{"type": "hangup"}',
  closed_destination  jsonb NOT NULL DEFAULT '{"type": "hangup"}'
);
CREATE INDEX business_hours_tenant_idx ON business_hours (tenant_id);

-- ---- Numbers ---------------------------------------------------------------------------------
-- destination: where calls to the number go (extension | ring_group | ivr_menu | business_hours
-- | voicemail | external). NULL falls back to ivr_menu_id (phase-1 rows).
ALTER TABLE phone_numbers
  ADD COLUMN destination jsonb,
  ADD COLUMN kind number_kind NOT NULL DEFAULT 'local',
  -- What DIDWW charges us per answered incoming minute on this number (toll-free); NULL = default.
  ADD COLUMN incoming_cost_per_min numeric(12, 6),
  -- Paid period end; a released number keeps working until then (spec §2).
  ADD COLUMN paid_until timestamptz;
CREATE INDEX phone_numbers_tenant_idx ON phone_numbers (tenant_id);

-- Read by Kamailio (sqlops, read-only connection) to keep each account's calls on one pbx node.
-- Granted to the kamailio role by the db_schema Ansible role after migrations.
CREATE VIEW kamailio_did_tenant AS
  SELECT ltrim(did, '+') AS did_digits, tenant_id
    FROM phone_numbers
   WHERE tenant_id IS NOT NULL AND (status = 'assigned' OR paid_until > now());

-- ---- Caller blocklist ------------------------------------------------------------------------
CREATE TABLE blocked_numbers (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number      text NOT NULL CHECK (number ~ '^\+[1-9][0-9]{6,14}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, number)
);

-- ---- Voicemail -------------------------------------------------------------------------------
-- heard=false: "new" message; heard=true: "saved" (Cisco Unity terms used by *98). Delete = DELETE.
ALTER TABLE voicemails ADD COLUMN caller_number text;
-- call_id now refers to cdrs.call_id (no FK: CDRs are written after the voicemail may be filed).
ALTER TABLE voicemails DROP CONSTRAINT IF EXISTS voicemails_call_id_fkey;
CREATE INDEX voicemails_mailbox_heard_idx ON voicemails (mailbox_id, heard, created_at);

-- Recordings point at their call (cdrs.call_id); cdrs stay insert-only.
ALTER TABLE media ADD COLUMN call_id uuid;
CREATE INDEX media_call_idx ON media (call_id) WHERE call_id IS NOT NULL;

-- ---- CDRs (replace `calls`) ------------------------------------------------------------------
-- One row per leg. The main row of a call has parent_id NULL; every extra leg we place to an
-- external number (forwarded, simultaneous ring, transferred) is its own charged row with
-- parent_id = the main row and the same call_id. Written once, at hangup (insert-only).
DROP TABLE calls;
DROP TYPE call_disposition;

CREATE TABLE cdrs (
  id              uuid PRIMARY KEY,
  call_id         uuid NOT NULL,
  parent_id       uuid,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  direction       cdr_direction NOT NULL,
  from_number     text,          -- calling number (E.164 for PSTN, extension number for internal)
  to_number       text,          -- called number (as dialed, normalized)
  did             text,          -- the account's number involved (incoming DID / outgoing caller ID)
  from_extension  text,
  to_extension    text,          -- extension that answered (or was rung)
  started_at      timestamptz NOT NULL,
  answered_at     timestamptz,
  ended_at        timestamptz NOT NULL,
  billable_sec    integer NOT NULL DEFAULT 0,   -- 30/6 rounded answered time
  outcome         cdr_outcome NOT NULL,
  vendor          pstn_vendor,
  rate_prefix     text,
  cost            numeric(12, 6) NOT NULL DEFAULT 0,  -- what we pay
  charge          numeric(12, 6) NOT NULL DEFAULT 0,  -- what we bill
  included_sec    integer NOT NULL DEFAULT 0,         -- included US seconds consumed
  voicemail       boolean NOT NULL DEFAULT false,     -- caller reached voicemail
  hangup_cause    integer,
  pbx_node        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Search (spec §4): newest first, paged, by number (partial), time range, direction, extension,
-- outcome; fast with millions of rows. Keyset paging on (started_at, id).
CREATE INDEX cdrs_tenant_started_idx ON cdrs (tenant_id, started_at DESC, id DESC);
CREATE INDEX cdrs_tenant_dir_idx ON cdrs (tenant_id, direction, started_at DESC);
CREATE INDEX cdrs_tenant_outcome_idx ON cdrs (tenant_id, outcome, started_at DESC);
CREATE INDEX cdrs_from_ext_idx ON cdrs (tenant_id, from_extension, started_at DESC) WHERE from_extension IS NOT NULL;
CREATE INDEX cdrs_to_ext_idx ON cdrs (tenant_id, to_extension, started_at DESC) WHERE to_extension IS NOT NULL;
CREATE INDEX cdrs_numbers_trgm_idx ON cdrs USING gin (
  (coalesce(from_number, '') || ' ' || coalesce(to_number, '') || ' ' || coalesce(did, '')) gin_trgm_ops);
CREATE INDEX cdrs_call_idx ON cdrs (call_id);

-- ---- Rating ----------------------------------------------------------------------------------
-- Vendor rate decks (Course Services tab CSVs; import with `npm run rates:import -w @pbx/ari-app`).
CREATE TABLE rate_decks (
  vendor       pstn_vendor NOT NULL,
  prefix       text NOT NULL CHECK (prefix ~ '^[0-9]+$'),
  destination  text NOT NULL,
  per_min      numeric(12, 6) NOT NULL CHECK (per_min >= 0),
  PRIMARY KEY (vendor, prefix)
);

-- Our per-minute prices (one row). Defaults are under the course ceilings (spec §2).
CREATE TABLE call_pricing (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  us_per_min                numeric(12, 6) NOT NULL DEFAULT 0.05  CHECK (us_per_min <= 0.06),
  toll_free_in_per_min      numeric(12, 6) NOT NULL DEFAULT 0.055 CHECK (toll_free_in_per_min <= 0.06),
  intl_multiplier           numeric(8, 4)  NOT NULL DEFAULT 5     CHECK (intl_multiplier <= 6),
  intl_min_per_min          numeric(12, 6) NOT NULL DEFAULT 0.06  CHECK (intl_min_per_min <= 0.06),
  toll_free_in_cost_per_min numeric(12, 6) NOT NULL DEFAULT 0.025
);
INSERT INTO call_pricing DEFAULT VALUES;

-- Included US minutes consumed per account per billing period (period_start = local date).
CREATE TABLE usage_periods (
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  period_start       date NOT NULL,
  included_sec_used  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period_start)
);

-- ---- Config change notifications (ARI app cache, bottleneck B6) -------------------------------
CREATE FUNCTION pbx_notify_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    t := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'ring_group_members' THEN
    SELECT tenant_id INTO t FROM ring_groups WHERE id = COALESCE(NEW.ring_group_id, OLD.ring_group_id);
  ELSE
    t := COALESCE(NEW.tenant_id, OLD.tenant_id);
  END IF;
  IF t IS NOT NULL THEN PERFORM pg_notify('pbx_config', t::text); END IF;
  -- A number moving between accounts must invalidate the old one too. (Nested IFs: plpgsql does
  -- not short-circuit AND, and other tables have no tenant_id column on OLD.)
  IF TG_TABLE_NAME = 'phone_numbers' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id AND OLD.tenant_id IS NOT NULL THEN
        PERFORM pg_notify('pbx_config', OLD.tenant_id::text);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tenants', 'tenant_settings', 'phone_numbers', 'extensions', 'ring_groups',
                             'ring_group_members', 'ivr_menus', 'mailboxes', 'business_hours', 'blocked_numbers']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION pbx_notify_tenant()', tbl || '_notify', tbl);
  END LOOP;
END $$;

CREATE FUNCTION pbx_notify_rates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('pbx_rates', '');
  RETURN NULL;
END $$;
CREATE TRIGGER rate_decks_notify AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON rate_decks
  FOR EACH STATEMENT EXECUTE FUNCTION pbx_notify_rates();
CREATE TRIGGER call_pricing_notify AFTER INSERT OR UPDATE OR DELETE ON call_pricing
  FOR EACH STATEMENT EXECUTE FUNCTION pbx_notify_rates();

-- migrate:down
DROP TRIGGER IF EXISTS call_pricing_notify ON call_pricing;
DROP TRIGGER IF EXISTS rate_decks_notify ON rate_decks;
DROP FUNCTION IF EXISTS pbx_notify_rates() CASCADE;
DROP FUNCTION IF EXISTS pbx_notify_tenant() CASCADE;
DROP TABLE usage_periods, call_pricing, rate_decks, cdrs, blocked_numbers, business_hours;
DROP VIEW kamailio_did_tenant;
DROP INDEX IF EXISTS media_call_idx;
ALTER TABLE media DROP COLUMN call_id;
DROP INDEX IF EXISTS voicemails_mailbox_heard_idx;
ALTER TABLE voicemails DROP COLUMN caller_number;
ALTER TABLE phone_numbers DROP COLUMN destination, DROP COLUMN kind, DROP COLUMN incoming_cost_per_min, DROP COLUMN paid_until;
DROP INDEX IF EXISTS phone_numbers_tenant_idx;
ALTER TABLE ring_groups DROP COLUMN no_answer_destination;
DROP TABLE ring_group_members;
CREATE TABLE ring_group_members (
  ring_group_id  uuid NOT NULL REFERENCES ring_groups (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ring_group_id, user_id)
);
DROP TABLE extensions;
ALTER TABLE tenant_settings DROP COLUMN intl_calling, DROP COLUMN included_us_minutes;
ALTER TABLE tenants DROP COLUMN timezone, DROP COLUMN status;
CREATE TYPE call_disposition AS ENUM ('answered', 'voicemail', 'abandoned', 'failed');
CREATE TABLE calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  phone_number_id      uuid REFERENCES phone_numbers (id) ON DELETE SET NULL,
  caller_number        text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  answered_at          timestamptz,
  ended_at             timestamptz,
  disposition          call_disposition,
  answered_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  pbx_node             text NOT NULL,
  recording_media_id   uuid REFERENCES media (id) ON DELETE SET NULL
);
CREATE INDEX calls_tenant_started_idx ON calls (tenant_id, started_at DESC);
DROP TYPE pstn_vendor, cdr_outcome, cdr_direction, number_kind, account_status;
