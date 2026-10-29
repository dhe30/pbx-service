import postgres from 'postgres';

// Database access shared by api and ari-app (postgres.js).
// In production every node connects to its local HAProxy (127.0.0.1:5432), which always points at
// the current Patroni primary. During a failover (10-30 s) queries fail with connection errors or
// "read-only transaction" errors; callers on hot paths wrap queries in withRetry().

export type Sql = postgres.Sql;

export interface DbOptions {
  /** Max pool size. */
  max?: number;
  /** App name shown in pg_stat_activity. */
  applicationName?: string;
}

export function createDb(url: string, opts: DbOptions = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    connect_timeout: 5,
    idle_timeout: 30,
    // Recycle connections so a pool never stays pinned to a demoted primary for long.
    max_lifetime: 60 * 10,
    // snake_case columns -> camelCase fields on returned rows.
    transform: postgres.camel,
    connection: { application_name: opts.applicationName ?? 'pbx' },
    onnotice: () => {},
  });
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01', // admin_shutdown (primary stopped)
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up / in recovery)
  '25006', // read_only_sql_transaction (connected to a replica mid-failover)
]);

/** True for errors that are expected during a DB failover and worth retrying. */
export function isTransientDbError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return TRANSIENT_CODES.has(code) || code.startsWith('08'); // 08xxx = connection exceptions
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
}

/** Retry `fn` on transient DB errors with linear backoff. Non-transient errors throw immediately. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 500;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransientDbError(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
}
