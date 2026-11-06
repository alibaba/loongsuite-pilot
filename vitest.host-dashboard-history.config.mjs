import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: 'target/host-dashboard-history-cache',
  test: {
    globals: true, environment: 'node',
    globalSetup: ['tests/helpers/isolated-home-global-setup.ts'],
    include: ['tests/host/dashboard-static-page.test.mjs'],
    testTimeout: 15000, fileParallelism: false, maxWorkers: 1, cache: false,
  },
});
