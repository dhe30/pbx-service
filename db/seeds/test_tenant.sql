-- Test tenant for phase-1 testing ("Tony's Pizza"). Idempotent: safe to re-run.
-- Run with psql variables, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v did=+15555550100 -v sip_domain=pbx.example \
--        -v alice_password=... -v bob_password=... -f db/seeds/test_tenant.sql
--
-- Staff:  alice -> browser softphone (WebRTC test page)
--         bob   -> UDP softphone or SIPp UAS
-- IVR:    1 -> ring group "Everyone" (alice + bob, ring all), falls back to voicemail
--         2 -> voicemail "Main"
--         0 -> alice directly
--         timeout -> voicemail "Main"

BEGIN;

INSERT INTO tenants (id, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Tony''s Pizza')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_settings (tenant_id, record_calls) VALUES
  ('00000000-0000-4000-8000-000000000001', true)
ON CONFLICT (tenant_id) DO UPDATE SET record_calls = EXCLUDED.record_calls;

-- password_hash '!' = cannot log in to the dashboard (no API in phase 1).
INSERT INTO users (id, tenant_id, email, password_hash, role, sip_username) VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'owner@tonys.test', '!', 'owner', NULL),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'alice@tonys.test', '!', 'staff', 'alice'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'bob@tonys.test',   '!', 'staff', 'bob')
ON CONFLICT (id) DO NOTHING;

-- Kamailio credentials (auth_db calculate_ha1=yes reads the plaintext password column).
INSERT INTO kamailio.subscriber (username, domain, password) VALUES
  ('alice', :'sip_domain', :'alice_password'),
  ('bob',   :'sip_domain', :'bob_password')
ON CONFLICT (username, domain) DO UPDATE SET password = EXCLUDED.password;

INSERT INTO mailboxes (id, tenant_id, name, owner_user_id) VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', 'Main', NULL),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', 'Alice', '00000000-0000-4000-8000-000000000011')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ring_groups (id, tenant_id, name, strategy, ring_timeout_sec, fallback_mailbox_id) VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000001', 'Everyone', 'all', 20,
   '00000000-0000-4000-8000-000000000020')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ring_group_members (ring_group_id, user_id, position) VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000011', 0),
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000012', 1)
ON CONFLICT DO NOTHING;

INSERT INTO ivr_menus (id, tenant_id, name, timeout_sec, max_retries, config) VALUES
  ('00000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-000000000001', 'Main menu', 5, 3,
   '{
      "options": {
        "1": {"action": "ring_group", "target": "00000000-0000-4000-8000-000000000030"},
        "2": {"action": "voicemail",  "target": "00000000-0000-4000-8000-000000000020"},
        "0": {"action": "user",       "target": "00000000-0000-4000-8000-000000000011"}
      },
      "on_timeout": {"action": "voicemail", "target": "00000000-0000-4000-8000-000000000020"}
    }')
ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config;

INSERT INTO phone_numbers (id, did, tenant_id, ivr_menu_id, status, provider_ref) VALUES
  ('00000000-0000-4000-8000-000000000050', :'did', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000040', 'assigned', 'seed')
ON CONFLICT (id) DO UPDATE SET did = EXCLUDED.did;

COMMIT;
