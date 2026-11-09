// In-process Postgres for tests, no docker needed: PGlite (Postgres compiled to WASM) behind a
// Postgres wire-protocol socket, with db/migrations, the Kamailio schema (db/kamailio) and the
// extra subscriber columns applied. Data lives in memory and is gone when the process exits.
//
//   node dev/pglite-server.mjs [port]          (default 55432)
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm test -w @pbx/api
//
// The docker-compose Postgres (npm run dev:up && npm run db:migrate && npm run db:kamailio) is the
// real thing; use this when docker isn't available. PGlite serves one connection at a time, so
// run test files sequentially (vitest --no-file-parallelism).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 55432);

const db = new PGlite({ extensions: { pg_trgm } });
const kam = ['standard-create.sql', 'auth_db-create.sql', 'usrloc-create.sql', 'pbx-subscriber-columns.sql']
  .map((f) => readFileSync(join(root, 'db/kamailio', f), 'utf8'))
  .join('\n');
await db.exec(`create schema kamailio; set search_path = kamailio; ${kam}; reset search_path;`);
for (const f of readdirSync(join(root, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(root, 'db/migrations', f), 'utf8').split('-- migrate:down')[0]);
}

const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`pglite ready on postgres://postgres@127.0.0.1:${port}/postgres`);
const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
