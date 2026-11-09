-- Extra columns on Kamailio's subscriber table (run as the kamailio role, idempotent, every deploy).
-- auth_db loads tenant_id into $avp(tenant) on every successful auth (modparam load_credentials),
-- so Kamailio can keep all of an account's calls on one pbx node without another DB query.
-- The API sets both when it creates an extension (docs/telephony-contract.md).
ALTER TABLE subscriber ADD COLUMN IF NOT EXISTS tenant_id varchar(64) NOT NULL DEFAULT '';
ALTER TABLE subscriber ADD COLUMN IF NOT EXISTS extension_id varchar(64) NOT NULL DEFAULT '';
