import { build } from 'esbuild';

const isInternal = process.argv.includes('--internal');

// Packages that must remain external (need native binaries or are too large to bundle).
// @loongsuite/otel-util-genai and @opentelemetry/* are intentionally NOT listed here
// so they get inlined into the bundle — avoids runtime 404 when the private package
// is unavailable on public npm registries.
const externalPackages = [
  '@alicloud/log',
  'axios',
  'express',
  'pino',
  'pino-roll',
  'sqlite3',
  'uuid',
  'zod',
];

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  bundle: true,
  minify: true,
  treeShaking: true,
  external: externalPackages,
  define: {
    __INTERNAL_BUILD__: String(isInternal),
  },
});

await build({
  entryPoints: ['src/cli-probe.ts'],
  outfile: 'dist/cli-probe.cjs',
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  banner: { js: "process.env.LOG_LEVEL = 'silent';" },
  define: {
    __INTERNAL_BUILD__: String(isInternal),
  },
  minifySyntax: true,
});

await build({
  entryPoints: ['src/updater/index.ts'],
  outdir: 'dist/updater',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  bundle: true,
  minify: true,
  treeShaking: true,
  external: externalPackages,
  define: {
    __INTERNAL_BUILD__: String(isInternal),
  },
});
