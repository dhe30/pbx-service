// Login/signup capacity of one API process: argon2id (the API's settings) under N concurrent
// requests. Each hash runs on libuv's thread pool, whose size (UV_THREADPOOL_SIZE, default 4) caps
// how many run at once; DNS lookups (getaddrinfo) and file I/O share that pool.
//
//   node loadtest/api/argon2-bench.mjs [concurrency=32] [rounds=4]
//   UV_THREADPOOL_SIZE=8 node loadtest/api/argon2-bench.mjs 32
//   ARGON2_MEMORY_KIB=19456 ARGON2_TIME=2 ARGON2_PARALLELISM=1 node loadtest/api/argon2-bench.mjs 32
//
// Prints per-hash latency (p50/p95, queueing included) and hashes per second.
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';

const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const argon2 = require('argon2');

const concurrency = Number(process.argv[2] ?? 32);
const rounds = Number(process.argv[3] ?? 4);
const pool = process.env.UV_THREADPOOL_SIZE ?? '4 (default)';

// Defaults = the library's (what the API used until 2026-11-12): 64 MiB, 3 passes, 4 lanes.
const opts = { type: argon2.argon2id };
if (process.env.ARGON2_MEMORY_KIB) opts.memoryCost = Number(process.env.ARGON2_MEMORY_KIB);
if (process.env.ARGON2_TIME) opts.timeCost = Number(process.env.ARGON2_TIME);
if (process.env.ARGON2_PARALLELISM) opts.parallelism = Number(process.env.ARGON2_PARALLELISM);
const hash = await argon2.hash('correct horse battery', opts);
await argon2.verify(hash, 'warm up');

const latencies = [];
const t0 = performance.now();
for (let r = 0; r < rounds; r++) {
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const s = performance.now();
      await argon2.verify(hash, 'correct horse battery');
      latencies.push(performance.now() - s);
    }),
  );
}
const total = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(0);
console.log(
  `cpus=${availableParallelism()} UV_THREADPOOL_SIZE=${pool} m=${opts.memoryCost ?? 65536}KiB t=${opts.timeCost ?? 3} ` +
    `p=${opts.parallelism ?? 4} concurrency=${concurrency} ` +
    `p50=${pct(50)}ms p95=${pct(95)}ms throughput=${(latencies.length / total).toFixed(1)}/s`,
);
