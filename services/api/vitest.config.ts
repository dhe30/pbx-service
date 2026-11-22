import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Prices must not depend on the hour the tests run: only the standard list (catalog.ts). The
    // alternate list has its own tests, which pass explicit times.
    env: { ALT_PRICING: 'off' },
  },
});
