import { isTransientDbError } from '@pbx/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { StripeError } from './billing/stripe.js';
import { ObjectStoreError } from './object-store.js';

// One error shape for every route: { error: <machine-readable code>, message: <human text> }.
// Routes signal expected failures with `throw new HttpError(404, 'not_found', 'No such number')`.
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }

    // The payment gateway failed (unreachable, 5xx, rejected request). Not the client's fault; the
    // billing routes are idempotent, so retrying is safe.
    if (err instanceof StripeError) {
      req.log.error({ err: err.message, status: err.status }, 'payment gateway error');
      return reply.status(502).send({ error: 'payment_gateway_error', message: 'The payment service failed; please retry' });
    }

    // DB failover in progress (10-30 s): tell the client to retry instead of reporting a bug.
    // The web client retries 503 + Retry-After; HAProxy may also retry on another replica.
    if (isTransientDbError(err)) {
      req.log.warn({ err }, 'database unavailable');
      return reply
        .status(503)
        .header('Retry-After', '2')
        .send({ error: 'unavailable', message: 'Temporarily unavailable, please retry' });
    }

    // Object store (Garage) unreachable or failing: also temporary, from the client's side.
    if (err instanceof ObjectStoreError) {
      req.log.warn({ err }, 'object store unavailable');
      return reply
        .status(503)
        .header('Retry-After', '2')
        .send({ error: 'unavailable', message: 'Temporarily unavailable, please retry' });
    }

    // Postgres rejected a malformed value (e.g. "abc" for a uuid column) that slipped past route
    // validation. It's the client's input, not a server fault.
    if ((err as { code?: string }).code === '22P02') {
      return reply.status(400).send({ error: 'invalid_request', message: 'Malformed id or value' });
    }

    // Fastify's own 4xx errors (schema validation, bad JSON, body too large, ...).
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }

    // Anything else is a bug: log everything, return nothing internal to the client.
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url} not found` });
  });
}

/** True if `err` is a Postgres unique violation (23505) of the named constraint. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint_name?: string } | null;
  return e?.code === '23505' && e.constraint_name === constraint;
}
