import { createDb } from '@pbx/shared';
import { PbxApp } from './app.js';
import { AriClient } from './ari/client.js';
import { EventBus } from './ari/events.js';
import type { AriEvent } from './ari/types.js';
import { loadConfig } from './config.js';
import type { Ctx } from './ctx.js';
import { GreetingCache } from './greetings.js';
import { startHealthServer } from './health.js';
import { log } from './log.js';
import { metrics } from './metrics.js';
import { ObjectStore } from './object-store.js';
import { Repo } from './repo.js';
import { Uploader } from './uploader.js';

// ARI call-control app. One instance per Asterisk node, talking to Asterisk on localhost.
//
// Lifecycle (crash-only):
//  - Startup: retry connecting to ARI with backoff until Asterisk is up. While we're not
//    connected, Asterisk's Stasis() fails and the dialplan returns 503, so Kamailio sends calls to
//    another pbx node.
//  - If the ARI WebSocket drops later, exit(1) and let systemd restart us.

async function main(): Promise<void> {
  const cfg = loadConfig();
  const sql = createDb(cfg.DATABASE_URL, { max: 10, applicationName: `ari-app@${cfg.PBX_NODE}` });
  const repo = new Repo(sql);
  const store = new ObjectStore(cfg);
  const uploader = new Uploader(cfg.SPOOL_DIR, repo, store, log.child({ mod: 'uploader' }));
  const greetings = new GreetingCache(cfg.SOUNDS_CACHE_DIR, repo, store, log.child({ mod: 'greetings' }));
  const ari = new AriClient({ url: cfg.ARI_URL, user: cfg.ARI_USER, password: cfg.ARI_PASSWORD, app: cfg.ARI_APP });
  const bus = new EventBus();
  const ctx: Ctx = { cfg, ari, bus, repo, greetings, uploader };
  const app = new PbxApp(ctx, log);

  startHealthServer({ host: cfg.HEALTH_HOST, port: cfg.HEALTH_PORT, ari, repo });
  uploader.start();

  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ code, activeCalls: app.activeCalls }, 'shutting down');
    uploader.stop();
    ari.close();
    void sql.end({ timeout: 2 }).finally(() => process.exit(code));
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  // Buffer events until orphan cleanup is done, so we never hang up a brand-new call by mistake.
  let ready = false;
  const early: AriEvent[] = [];
  ari.on('event', (ev) => (ready ? app.onEvent(ev) : early.push(ev)));
  ari.on('close', (reason) => {
    metrics.ariConnected.set(0);
    log.error({ reason }, 'ARI WebSocket closed');
    shutdown(1);
  });

  await connectWithBackoff(ari);
  metrics.ariConnected.set(1);
  log.info({ app: cfg.ARI_APP, node: cfg.PBX_NODE }, 'connected to ARI');

  const newCallIds = new Set(early.filter((e) => e.type === 'StasisStart').map((e) => e.channel.id));
  try {
    await app.hangupOrphans(newCallIds);
  } catch (err) {
    log.warn({ err }, 'orphan cleanup failed');
  }
  ready = true;
  for (const ev of early.splice(0)) app.onEvent(ev);
}

async function connectWithBackoff(ari: AriClient): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ari.connect();
      return;
    } catch (err) {
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
      log.warn({ err: (err as Error).message, retryInMs: delay }, 'ARI not reachable yet');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

main().catch((err) => {
  log.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
