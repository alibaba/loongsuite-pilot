import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    '__INTERNAL_BUILD__': 'false',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: [
        'src/inputs/**',
        'src/checkpoints/**',
        'src/normalization/**',
        'src/flushers/**',
        'src/core/**',
      ],
      exclude: [
        'src/inputs/base/base-cli-forwarder.ts',
        'src/inputs/base/base-sqlite-input.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      reporter: ['text', 'lcov'],
    },
    testTimeout: 15_000,
  },
});
