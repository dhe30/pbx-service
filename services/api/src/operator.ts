import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

// Provider-side ("operator") access: us, the PBX operator, not a customer account. Used by the
// cross-account support ticket view (GET /operator/tickets). Course spec §3: "the provider must
// see the open tickets of all accounts as they come in".
//
// Mechanism: one shared secret, OPERATOR_TOKEN (Ansible Vault `vault_operator_token`), sent as
// `Authorization: Bearer <token>`. Deliberately NOT a user role, because:
//  - every user row and every JWT belongs to exactly one tenant, and all tenant routes trust
//    tenantOf(req) (docs/backend-step3.md). An operator user would have to live inside some
//    customer tenant, and a cross-tenant role inside the tenant JWT is exactly what the tenancy
//    rules are built to rule out. Keeping the operator outside users/JWTs means a mistake in
//    a tenant route can't hand out cross-account data, and an operator route can't be reached
//    with a customer's cookie.
//  - it needs no schema change, no signup/login path and no UI to create operators; rotating
//    it is a vault change + redeploy of the `api` role.
// Not set (local dev, tests that don't need it) -> operator routes answer 401 to everyone.

/** preHandler for operator routes. Wrong, missing or unconfigured token -> 401. */
export function requireOperator(token: string | undefined) {
  const expected = token ? digest(token) : null;
  return async (req: FastifyRequest): Promise<void> => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    // Compare fixed-length digests in constant time, so response timing reveals nothing about
    // how much of a guessed token was right.
    if (!expected || !m || !timingSafeEqual(digest(m[1]!), expected)) {
      throw new HttpError(401, 'unauthorized', 'Operator token missing or wrong');
    }
  };
}

const digest = (s: string) => createHash('sha256').update(s).digest();
