import { createServer, type Server } from 'node:http';
import type { AriClient } from './ari/client.js';
import { registry } from './metrics.js';
import type { Repo } from './repo.js';

// Local-only HTTP endpoints:
//   GET /health  -> 200 if ARI is connected AND the DB answers, else 503 (used by monitoring and
//                   later by the graceful-drain script)
//   GET /metrics -> Prometheus metrics
export function startHealthServer(opts: { host: string; port: number; ari: AriClient; repo: Repo }): Server {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/health') {
        const ari = opts.ari.connected;
        const db = await Promise.race([
          opts.repo.ping().then(() => true, () => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
        ]);
        res.writeHead(ari && db ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ari, db }));
      } else if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(await registry.metrics());
      } else {
        res.writeHead(404).end();
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(opts.port, opts.host);
  return server;
}
