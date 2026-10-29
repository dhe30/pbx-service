-- migrate:up
-- App schema (CLAUDE.md §6). Kamailio-owned tables (subscriber, location, version) live in the
-- `kamailio` schema and are created from db/kamailio/*.sql, not here.

CREATE TYPE user_role AS ENUM ('owner', 'staff');
CREATE TYPE number_status AS ENUM ('assigned', 'released');
CREATE TYPE ring_strategy AS ENUM ('all', 'sequential');
CREATE TYPE media_kind AS ENUM ('greeting', 'recording', 'voicemail');
CREATE TYPE call_disposition AS ENUM ('answered', 'voicemail', 'abandoned', 'failed');

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           user_role NOT NULL,
  -- Globally unique: Kamailio looks staff up by username only (usrloc use_domain=0).
  sip_username   text UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind         media_kind NOT NULL,
  object_key   text NOT NULL UNIQUE,
  format       text NOT NULL,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_tenant_idx ON media (tenant_id);

CREATE TABLE mailboxes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name               text NOT NULL,
  greeting_media_id  uuid REFERENCES media (id) ON DELETE SET NULL,
  owner_user_id      uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX mailboxes_tenant_idx ON mailboxes (tenant_id);
CREATE INDEX mailboxes_owner_idx ON mailboxes (owner_user_id);

CREATE TABLE ring_groups (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                 text NOT NULL,
  strategy             ring_strategy NOT NULL DEFAULT 'all',
  ring_timeout_sec     integer NOT NULL DEFAULT 20 CHECK (ring_timeout_sec BETWEEN 5 AND 120),
  fallback_mailbox_id  uuid REFERENCES mailboxes (id) ON DELETE SET NULL
);
CREATE INDEX ring_groups_tenant_idx ON ring_groups (tenant_id);

CREATE TABLE ring_group_members (
  ring_group_id  uuid NOT NULL REFERENCES ring_groups (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ring_group_id, user_id)
);

CREATE TABLE ivr_menus (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name               text NOT NULL,
  greeting_media_id  uuid REFERENCES media (id) ON DELETE SET NULL,
  timeout_sec        integer NOT NULL DEFAULT 5 CHECK (timeout_sec BETWEEN 1 AND 30),
  max_retries        integer NOT NULL DEFAULT 3 CHECK (max_retries BETWEEN 1 AND 10),
  -- Validated by IvrConfigSchema in services/shared.
  config             jsonb NOT NULL DEFAULT '{"options": {}}'
);
CREATE INDEX ivr_menus_tenant_idx ON ivr_menus (tenant_id);

CREATE TABLE phone_numbers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  did           text NOT NULL UNIQUE CHECK (did ~ '^\+[1-9][0-9]{1,14}$'),  -- E.164
  tenant_id     uuid REFERENCES tenants (id) ON DELETE SET NULL,
  ivr_menu_id   uuid REFERENCES ivr_menus (id) ON DELETE SET NULL,
  status        number_status NOT NULL DEFAULT 'assigned',
  provider_ref  text,
  purchased_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_requests (
  idempotency_key  text PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  phone_number_id  uuid REFERENCES phone_numbers (id) ON DELETE SET NULL,
  status           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  phone_number_id      uuid REFERENCES phone_numbers (id) ON DELETE SET NULL,
  caller_number        text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  answered_at          timestamptz,
  ended_at             timestamptz,
  disposition          call_disposition,  -- NULL while the call is in progress
  answered_by_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  pbx_node             text NOT NULL,
  recording_media_id   uuid REFERENCES media (id) ON DELETE SET NULL
);
CREATE INDEX calls_tenant_started_idx ON calls (tenant_id, started_at DESC);

CREATE TABLE voicemails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  mailbox_id  uuid NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  call_id     uuid REFERENCES calls (id) ON DELETE SET NULL,
  -- UNIQUE makes the ARI app's uploader idempotent (retries after a crash can't double-insert).
  media_id    uuid NOT NULL UNIQUE REFERENCES media (id) ON DELETE CASCADE,
  heard       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voicemails_mailbox_created_idx ON voicemails (mailbox_id, created_at DESC);

CREATE TABLE tenant_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  record_calls  boolean NOT NULL DEFAULT false
);

-- migrate:down
DROP TABLE tenant_settings, voicemails, calls, purchase_requests, phone_numbers, ivr_menus,
  ring_group_members, ring_groups, mailboxes, media, users, tenants;
DROP TYPE call_disposition, media_kind, ring_strategy, number_status, user_role;
