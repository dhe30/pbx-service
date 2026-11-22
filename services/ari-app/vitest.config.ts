import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ALT_PRICING=off: charges must not depend on the hour the tests run (the alternate list has
    // its own tests with explicit times).
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent', ALT_PRICING: 'off' },
    // Each spec file starts its own in-process Postgres (PGlite); keep files isolated.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
