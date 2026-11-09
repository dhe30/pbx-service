-- Test account for VM testing ("Tony's Pizza"), course-spec data model. Idempotent.
-- Run with psql variables, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v did=+15555550100 -v sip_domain=pbx.example \
--        -v alice_password=... -v bob_password=... -f db/seeds/test_tenant.sql
--
-- Extensions: 101 alice -> browser softphone (WebRTC test page)
--             102 bob   -> UDP softphone or SIPp UAS
-- Number :did -> IVR "Main menu":
--   1 -> ring group "Everyone" (101 + 102 at once), no answer -> voicemail "Main"
--   2 -> voicemail "Main"
--   0 -> extension 101 (rings all of alice's devices; no answer -> her mailbox)
--   timeout -> voicemail "Main"

BEGIN;

INSERT INTO tenants (id, name, timezone) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Tony''s Pizza', 'America/New_York')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_settings (tenant_id, record_calls, intl_calling, included_us_minutes) VALUES
  ('00000000-0000-4000-8000-000000000001', true, false, 100)
ON CONFLICT (tenant_id) DO UPDATE SET record_calls = EXCLUDED.record_calls;

-- password_hash '!' = cannot log in to the dashboard.
INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'owner@tonys.test', '!', 'owner'),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'alice@tonys.test', '!', 'staff'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'bob@tonys.test',   '!', 'staff')
ON CONFLICT (id) DO NOTHING;

INSERT INTO mailboxes (id, tenant_id, name, owner_user_id) VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', 'Main', NULL),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', 'Alice', '00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000001', 'Bob', '00000000-0000-4000-8000-000000000012')
ON CONFLICT (id) DO NOTHING;

INSERT INTO extensions (id, tenant_id, number, name, sip_username, mailbox_id, user_id) VALUES
  ('00000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000001', '101', 'Alice', 'alice',
   '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000001', '102', 'Bob', 'bob',
   '00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000012')
ON CONFLICT (id) DO NOTHING;

-- Kamailio credentials (auth_db calculate_ha1=yes reads the plaintext password column).
INSERT INTO kamailio.subscriber (username, domain, password, tenant_id, extension_id) VALUES
  ('alice', :'sip_domain', :'alice_password', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000061'),
  ('bob',   :'sip_domain', :'bob_password',   '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000062')
ON CONFLICT (username, domain) DO UPDATE
  SET password = EXCLUDED.password, tenant_id = EXCLUDED.tenant_id, extension_id = EXCLUDED.extension_id;

INSERT INTO ring_groups (id, tenant_id, name, strategy, ring_timeout_sec, no_answer_destination) VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000001', 'Everyone', 'all', 20,
   '{"type": "voicemail", "id": "00000000-0000-4000-8000-000000000020"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ring_group_members (ring_group_id, extension_id, position) VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000061', 0),
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000062', 1)
ON CONFLICT DO NOTHING;

INSERT INTO ivr_menus (id, tenant_id, name, timeout_sec, max_retries, config) VALUES
  ('00000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-000000000001', 'Main menu', 5, 3,
   '{
      "options": {
        "1": {"type": "ring_group", "id": "00000000-0000-4000-8000-000000000030"},
        "2": {"type": "voicemail",  "id": "00000000-0000-4000-8000-000000000020"},
        "0": {"type": "extension",  "id": "00000000-0000-4000-8000-000000000061"}
      },
      "timeout": {"type": "voicemail", "id": "00000000-0000-4000-8000-000000000020"},
      "repeat_digit": "*"
    }')
ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config;

INSERT INTO phone_numbers (id, did, tenant_id, ivr_menu_id, destination, status, provider_ref) VALUES
  ('00000000-0000-4000-8000-000000000050', :'did', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000040',
   '{"type": "ivr_menu", "id": "00000000-0000-4000-8000-000000000040"}', 'assigned', 'seed')
ON CONFLICT (id) DO UPDATE SET did = EXCLUDED.did, destination = EXCLUDED.destination;

COMMIT;
