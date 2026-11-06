import type { Sql } from '@pbx/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth } from './auth.js';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { metrics } from './metrics.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { staffRoutes } from './routes/staff.js';

// Builds the Fastify app without listening, so tests can drive it with app.inject().
// index.ts wires the real dependencies; tests pass fakes or a test database.

export interface AppDeps {
  sql: Sql;
  /** Dependency checks for GET /ready (index.ts: db + objectStore). */
  readinessChecks: Record<string, ReadinessCheck>;
  isDraining: () => boolean;
}

export type AppConfig = Pick<
  Config,
  | 'LOG_LEVEL'
  | 'JWT_SECRET'
  | 'ACCESS_TOKEN_TTL_SEC'
  | 'REFRESH_TOKEN_TTL_SEC'
  | 'COOKIE_SECURE'
  | 'SIP_WS_URI'
  | 'SIP_DOMAIN'
>;

export async function buildApp(cfg: AppConfig, deps: AppDeps): Promise<FastifyInstance> {
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
  await registerAuth(app, cfg);

  app.addHook('onResponse', async (req, reply) => {
    metrics.httpRequestDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  await app.register(healthRoutes, { checks: deps.readinessChecks, isDraining: deps.isDraining });
  await app.register(authRoutes, { sql: deps.sql });
  await app.register(staffRoutes, { sql: deps.sql, sipWsUri: cfg.SIP_WS_URI, sipDomain: cfg.SIP_DOMAIN });

  // Steps 5+ register numbers, ivr-menus, ... routes here. Every tenant-scoped route follows the
  // rules in src/tenancy.ts (docs/backend-step3.md).

  return app;
}
