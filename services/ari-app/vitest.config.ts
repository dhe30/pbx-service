import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
    // Each spec file starts its own in-process Postgres (PGlite); keep files isolated.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
