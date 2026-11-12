-- migrate:up
ALTER TYPE user_role ADD VALUE 'unassigned';

-- migrate:down
-- PostgreSQL enum values cannot be removed safely.
