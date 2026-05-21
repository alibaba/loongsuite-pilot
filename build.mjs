import { build } from 'esbuild';
import { globSync } from 'node:fs';

const isInternal = process.argv.includes('--internal');

const entryPoints = globSync('src/**/*.ts', {
  exclude: ['**/*.d.ts', '**/*.test.ts'],
});

await build({
  entryPoints,
  outdir: 'dist',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  bundle: false,
  sourcemap: isInternal ? true : 'external',
  sourcesContent: isInternal,
  define: {
    __INTERNAL_BUILD__: String(isInternal),
  },
  minifySyntax: !isInternal,
});
