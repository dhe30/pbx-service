import { isTransientDbError } from '@pbx/shared';
import type { FastifyError, FastifyInstance } from 'fastify';

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

    // DB failover in progress (10-30 s): tell the client to retry instead of reporting a bug.
    // The web client retries 503 + Retry-After; HAProxy may also retry on another replica.
    if (isTransientDbError(err)) {
      req.log.warn({ err }, 'database unavailable');
      return reply
        .status(503)
        .header('Retry-After', '2')
        .send({ error: 'unavailable', message: 'Temporarily unavailable, please retry' });
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
