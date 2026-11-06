import { createDb, type Sql } from '@pbx/shared';
import { buildApp, type AppConfig, type AppDeps } from '../src/app.js';

export const testConfig: AppConfig = {
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'test-secret-at-least-16-chars',
  ACCESS_TOKEN_TTL_SEC: 900,
  REFRESH_TOKEN_TTL_SEC: 7 * 86400,
  COOKIE_SECURE: true,
};

/** Local docker-compose Postgres (npm run dev:up && npm run db:migrate). Override with TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://pbx:pbx@127.0.0.1:5432/pbx?sslmode=disable';

/** postgres.js connects lazily, so this never touches the network unless a query runs. */
export const unusedDb = (): Sql => createDb('postgres://unused@127.0.0.1:1/unused');

export function build(deps: Partial<AppDeps> = {}, cfg: Partial<AppConfig> = {}) {
  return buildApp(
    { ...testConfig, ...cfg },
    {
      sql: unusedDb(),
      readinessChecks: { db: async () => {}, objectStore: async () => {} },
      isDraining: () => false,
      ...deps,
    },
  );
}

/** Returns a connected test DB, or null if it isn't running (DB tests are then skipped). */
export async function connectTestDb(): Promise<Sql | null> {
  const sql = createDb(TEST_DATABASE_URL, { max: 5, applicationName: 'api-test' });
  try {
    await sql`select 1 from users limit 1`; // also proves migrations ran
    return sql;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    return null;
  }
}
