-- migrate:up
ALTER TABLE users
  ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_tenant_role_check CHECK (
    (tenant_id IS NULL AND role = 'unassigned')
    OR (tenant_id IS NOT NULL AND role IN ('owner', 'staff'))
  );

-- migrate:down
ALTER TABLE users DROP CONSTRAINT users_tenant_role_check;
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
