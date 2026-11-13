-- migrate:up
-- Support tickets (course spec §3): an account's users open a ticket (subject + description)
-- through the API or the website, list the account's tickets with their status, and close them.
-- The provider (us) sees the open tickets of ALL accounts as they come in (GET /operator/tickets,
-- docs/backend-for-team.md "Support tickets"). Written and read only by the API
-- (services/api/src/routes/tickets.ts).
--
-- status: open -> closed (one way: a recurring problem gets a new ticket). closed_at is set
-- exactly when the ticket is closed (CHECK below).
-- created_by / closed_by: the user who did it; NULL once that user is deleted (the ticket stays
-- with the account).

CREATE TABLE support_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  subject      text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  description  text NOT NULL CHECK (length(description) BETWEEN 1 AND 10000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  closed_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
-- An account's tickets, newest first (GET /tickets; keyset paging on created_at, id).
CREATE INDEX support_tickets_tenant_idx ON support_tickets (tenant_id, created_at DESC, id DESC);
-- Open tickets of every account, newest first (GET /operator/tickets). Partial: stays small
-- because closed tickets leave it.
CREATE INDEX support_tickets_open_idx ON support_tickets (created_at DESC, id DESC) WHERE status = 'open';

-- migrate:down
DROP TABLE support_tickets;
