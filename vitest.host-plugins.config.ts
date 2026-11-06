// Optional host suite only. No Node/Bun requirement enters default Cargo tests.
import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from './vitest.config';
export default mergeConfig(base, defineConfig({ resolve: { alias: {
  '@loongsuite/otel-util-genai': fileURLToPath(new URL('./scripts/testing/native-plugin-projection.mjs', import.meta.url)),
} } }));
