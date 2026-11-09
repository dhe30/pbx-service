import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { registry } from '../metrics.js';
import { withDoc } from '../openapi/document.js';

// GET /health  liveness: the process is up and its event loop answers. Never touches dependencies,
//              so a DB outage doesn't make systemd/docker restart healthy API processes.
// GET /ready   readiness: DB and object store reachable, and not shutting down. The edge HAProxies
//              health-check this to decide which app-N replicas get traffic.
// GET /metrics Prometheus scrape.

/** A dependency check: resolves if healthy, rejects otherwise. Must honour the abort signal. */
export type ReadinessCheck = (signal: AbortSignal) => Promise<unknown>;

export interface HealthOptions {
  checks: Record<string, ReadinessCheck>;
  /** True once SIGTERM was received; /ready then returns 503 so HAProxy drains this replica. */
  isDraining: () => boolean;
  checkTimeoutMs?: number;
}

export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, opts) => {
  const timeoutMs = opts.checkTimeoutMs ?? 1500;
  // HAProxy and Prometheus poll these every few seconds: don't log each request at info level
  // (failures are still logged as warnings below). A route logLevel overrides the global one, so
  // only raise it, never lower it (LOG_LEVEL=error must stay quieter than warn).
  const verbose = ['info', 'debug', 'trace'].includes(app.log.level);
  const quiet = verbose ? ({ logLevel: 'warn' } as const) : {};

  app.get(
    '/health',
    withDoc(quiet, {
      tag: 'Health',
      auth: 'public',
      summary: 'Liveness',
      description: 'The process is up. Never checks dependencies.',
      responses: { 200: { description: 'Alive', schema: z.object({ status: z.literal('ok').describe('Always "ok".') }) } },
    }),
    async () => ({ status: 'ok' }),
  );

  const ReadySchema = z.object({
    status: z.enum(['ok', 'fail', 'draining']).describe('"ok" when every check passed; "draining" while shutting down.'),
    checks: z
      .record(z.string().describe('Check name (db, objectStore).'), z.enum(['ok', 'fail']).describe('Result of the check.'))
      .optional()
      .describe('Result per dependency (absent while draining).'),
  });
  app.get(
    '/ready',
    withDoc(quiet, {
      tag: 'Health',
      auth: 'public',
      summary: 'Readiness',
      description: 'Database and object store reachable and not shutting down. Load balancers route on this.',
      responses: {
        200: { description: 'Ready', schema: ReadySchema },
        503: { description: 'Not ready: a dependency failed, or the process is draining', schema: ReadySchema },
      },
    }),
    async (req, reply) => {
      if (opts.isDraining()) {
        return reply.status(503).send({ status: 'draining' });
      }
      // Run all checks in parallel, each bounded by the timeout, so /ready answers in < timeoutMs
      // even when a dependency hangs (HAProxy's check would otherwise time out instead).
      const names = Object.keys(opts.checks);
      const results = await Promise.all(
        names.map((name) => runCheck(opts.checks[name]!, timeoutMs).catch((err: unknown) => {
          req.log.warn({ check: name, err: errMessage(err) }, 'readiness check failed');
          return false;
        })),
      );
      const checks = Object.fromEntries(names.map((n, i) => [n, results[i] ? 'ok' : 'fail']));
      const ok = results.every(Boolean);
      return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'fail', checks });
    },
  );

  app.get(
    '/metrics',
    withDoc(quiet, {
      tag: 'Health',
      auth: 'public',
      summary: 'Prometheus metrics',
      description: 'Prometheus text format (not JSON). Reachable on the private network only.',
      responses: { 200: { description: 'Metrics in the Prometheus exposition format' } },
    }),
    async (_req, reply) => {
      reply.header('Content-Type', registry.contentType);
      return registry.metrics();
    },
  );
};

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<true> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([check(ac.signal), timeout]);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
