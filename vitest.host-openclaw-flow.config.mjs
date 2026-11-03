// Explicit optional host contracts. Default Cargo has no Node dependency.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  cacheDir: 'target/host-openclaw-flow-cache',
  resolve: { alias: {
    '@loongsuite/otel-util-genai': fileURLToPath(new URL('./scripts/testing/openclaw-native-projection.mjs', import.meta.url)),
  } },
  test: {
    globals: true, environment: 'node',
    globalSetup: ['tests/helpers/isolated-home-global-setup.ts'],
    include: ["tests/unit/hooks/openclaw/build-context.test.mjs", "tests/unit/hooks/openclaw/e2e-assertions.test.mjs", "tests/unit/hooks/openclaw/legacy.test.mjs", "tests/unit/hooks/openclaw/session-key-e2e.test.mjs", "tests/unit/hooks/openclaw/plugin.test.mjs"],
    testTimeout: 15000, fileParallelism: false, maxWorkers: 1, cache: false,
  },
});
