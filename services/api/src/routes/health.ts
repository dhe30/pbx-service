import type { FastifyPluginAsync } from 'fastify';
import { registry } from '../metrics.js';

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

  app.get('/health', quiet, async () => ({ status: 'ok' }));

  app.get('/ready', quiet, async (req, reply) => {
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
  });

  app.get('/metrics', quiet, async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
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
