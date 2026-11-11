import { createDb } from '@pbx/shared';
import { hostname } from 'node:os';
import { buildApp } from './app.js';
import { FfmpegConverter } from './audio.js';
import { startBillingScheduler } from './billing/scheduler.js';
import { HttpStripeClient } from './billing/stripe.js';
import { ConfigError, loadConfig } from './config.js';
import { HttpDidwwProvider } from './numbers/didww.js';
import { FakeDidProvider } from './numbers/fake-provider.js';
import { ObjectStore } from './object-store.js';

// API entrypoint (Fastify). See CLAUDE.md §11 for the endpoint list.
// Stateless: auth is a signed JWT in an httpOnly cookie so any app-N replica can serve any request.
//
// Lifecycle:
//  - Startup does NOT wait for the DB or object store. The process starts and listens even while
//    Postgres is failing over; /ready reports 503 until dependencies answer, so HAProxy simply
//    doesn't route here yet. postgres.js connects lazily and reconnects on its own.
//  - SIGTERM/SIGINT (deploy, reboot): /ready -> 503, wait SHUTDOWN_DRAIN_MS so the edge HAProxies
//    notice and stop sending new requests, then finish in-flight requests and exit.

async function main(): Promise<void> {
  const cfg = loadConfig();
  const sql = createDb(cfg.DATABASE_URL, { max: cfg.DB_POOL_MAX, applicationName: `api@${hostname()}` });
  const store = new ObjectStore(cfg);

  let draining = false;
  const stripe = new HttpStripeClient(cfg.STRIPE_API_URL, cfg.STRIPE_SECRET_KEY);
  const app = await buildApp(cfg, {
    sql,
    readinessChecks: {
      db: () => sql`select 1`,
      objectStore: (signal) => store.ping(signal),
    },
    isDraining: () => draining,
    stripe,
    store,
    audio: new FfmpegConverter(cfg.FFMPEG_PATH),
    didProvider:
      cfg.DID_PROVIDER_MODE === 'fake'
        ? new FakeDidProvider()
        : new HttpDidwwProvider({
            baseUrl: cfg.DID_PROVIDER_URL,
            apiKey: cfg.DID_PROVIDER_API_KEY!,
            trunk: cfg.DID_TRUNK_GROUP_ID
              ? { type: 'voice_in_trunk_groups', id: cfg.DID_TRUNK_GROUP_ID }
              : { type: 'voice_in_trunks', id: cfg.DID_TRUNK_ID! },
          }),
  });

  const stopBilling = cfg.BILLING_SCHEDULER
    ? startBillingScheduler({ sql, stripe, log: app.log.child({ component: 'billing' }) }, cfg.BILLING_TICK_SEC * 1000)
    : async () => {};

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    draining = true;
    app.log.info({ signal, drainMs: cfg.SHUTDOWN_DRAIN_MS }, 'shutting down: draining');

    // Exit even if something below hangs (e.g. a request that never finishes).
    setTimeout(() => {
      app.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, cfg.SHUTDOWN_DRAIN_MS + cfg.SHUTDOWN_TIMEOUT_MS).unref();

    await new Promise((r) => setTimeout(r, cfg.SHUTDOWN_DRAIN_MS));
    try {
      await stopBilling(); // lets a running tick finish its current step
      await app.close(); // stops accepting connections, waits for in-flight requests
      await sql.end({ timeout: 5 });
      store.close();
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
}

main().catch((err: unknown) => {
  // The Fastify logger may not exist yet (bad config), so write to stderr directly.
  if (err instanceof ConfigError) {
    console.error(`api: ${err.message}`);
  } else {
    console.error('api: fatal startup error', err);
  }
  process.exit(1);
});
