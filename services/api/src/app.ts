import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { metrics } from './metrics.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';

// Builds the Fastify app without listening, so tests can drive it with app.inject().
// index.ts wires the real dependencies; tests pass fakes.

export interface AppDeps {
  /** Dependency checks for GET /ready (index.ts: db + objectStore). */
  readinessChecks: Record<string, ReadinessCheck>;
  isDraining: () => boolean;
}

export async function buildApp(cfg: Pick<Config, 'LOG_LEVEL'>, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // JSON logs to stdout (journald / docker). Never log cookies or auth headers.
    logger: {
      level: cfg.LOG_LEVEL,
      base: { svc: 'api' },
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    // The edge HAProxy can set X-Request-Id; otherwise Fastify generates one. It appears on every
    // log line of the request, so one browser request can be followed across logs.
    requestIdHeader: 'x-request-id',
    // We run behind the edge HAProxies, which set X-Forwarded-For / -Proto. The API port is only
    // reachable on the private network (host firewall), so trusting the proxy headers is safe.
    trustProxy: true,
  });

  registerErrorHandling(app);

  app.addHook('onResponse', async (req, reply) => {
    metrics.httpRequestDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  await app.register(healthRoutes, { checks: deps.readinessChecks, isDraining: deps.isDraining });

  // Steps 2+ register auth, staff, numbers, ... routes here.

  return app;
}
