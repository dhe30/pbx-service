import type { Sql } from '@pbx/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AudioConverter } from './audio.js';
import { registerAuth } from './auth.js';
import type { StripeClient } from './billing/stripe.js';
import type { Config } from './config.js';
import { registerErrorHandling } from './errors.js';
import { metrics } from './metrics.js';
import type { MediaStore } from './object-store.js';
import { collectOpenApi, withDoc } from './openapi/document.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { blockedNumberRoutes } from './routes/blocked-numbers.js';
import { businessHoursRoutes } from './routes/business-hours.js';
import { extensionRoutes } from './routes/extensions.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { ivrMenuRoutes } from './routes/ivr-menus.js';
import { mailboxRoutes } from './routes/mailboxes.js';
import { mediaRoutes } from './routes/media.js';
import { numberRoutes } from './routes/numbers.js';
import { ringGroupRoutes } from './routes/ring-groups.js';
import { staffRoutes } from './routes/staff.js';

// Builds the Fastify app without listening, so tests can drive it with app.inject().
// index.ts wires the real dependencies; tests pass fakes or a test database.

export interface AppDeps {
  sql: Sql;
  /** Dependency checks for GET /ready (index.ts: db + objectStore). */
  readinessChecks: Record<string, ReadinessCheck>;
  isDraining: () => boolean;
  /** Payment gateway (index.ts: HttpStripeClient; tests: a fake). */
  stripe: StripeClient;
  /** Object store for audio (index.ts: ObjectStore on Garage; tests: in-memory). */
  store: MediaStore;
  /** Greeting conversion (index.ts: FfmpegConverter). */
  audio: AudioConverter;
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
  | 'STRIPE_PUBLISHABLE_KEY'
  | 'STRIPE_JS_URL'
>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Routes without OpenAPI docs (test/openapi.test.ts requires none). */
    openapiUndocumented: () => string[];
  }
}

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

  // Must run before any route is registered: records each route's config.openapi.
  const openapi = collectOpenApi(app, {
    title: 'PBX API',
    version: '1.0.0',
    description:
      'Hosted virtual PBX for small businesses: signup and billing, extensions, call routing (IVR menus, ring ' +
      'groups, business hours, number routing), voicemail and call history. Everything the web dashboard does ' +
      'goes through this API.\n\n' +
      'Authentication: POST /auth/signup or /auth/login sets an httpOnly access cookie (pbx_access, 15 min) and a ' +
      'refresh cookie (pbx_refresh, path /auth). Send cookies back on every request; on 401 call POST /auth/refresh ' +
      'once and retry. Request bodies are JSON. Errors are `{ "error": "<code>", "message": "<text>" }`. Ids of ' +
      'another account answer 404 like unknown ids.',
  });
  app.get(
    '/openapi.json',
    withDoc(
      {},
      {
        tag: 'Health',
        auth: 'public',
        summary: 'This OpenAPI 3.1 document',
        responses: { 200: { description: 'OpenAPI 3.1 document (JSON)' } },
      },
    ),
    async () => openapi.document(),
  );
  app.decorate('openapiUndocumented', () => openapi.undocumented());

  await app.register(healthRoutes, { checks: deps.readinessChecks, isDraining: deps.isDraining });
  const cardSetup = { stripe: deps.stripe, publishableKey: cfg.STRIPE_PUBLISHABLE_KEY, stripeJsUrl: cfg.STRIPE_JS_URL };
  await app.register(authRoutes, { sql: deps.sql, ...cardSetup });
  await app.register(billingRoutes, { sql: deps.sql, ...cardSetup });
  await app.register(staffRoutes, { sql: deps.sql, sipWsUri: cfg.SIP_WS_URI, sipDomain: cfg.SIP_DOMAIN });
  await app.register(extensionRoutes, { sql: deps.sql, sipDomain: cfg.SIP_DOMAIN });

  await app.register(mailboxRoutes, { sql: deps.sql });
  await app.register(ringGroupRoutes, { sql: deps.sql });
  await app.register(ivrMenuRoutes, { sql: deps.sql });
  await app.register(numberRoutes, { sql: deps.sql });
  await app.register(businessHoursRoutes, { sql: deps.sql });
  await app.register(blockedNumberRoutes, { sql: deps.sql });
  await app.register(mediaRoutes, { sql: deps.sql, store: deps.store, audio: deps.audio });

  // Steps 7+ register voicemails, calls, settings routes here. Every tenant-scoped route
  // follows the rules in src/tenancy.ts (docs/backend-step3.md) and src/references.ts.

  return app;
}
