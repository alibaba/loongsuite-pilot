import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const isInternal = process.argv.includes('--internal');

const entryPoints = readdirSync('src', { recursive: true })
  .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
  .map(f => join('src', f));

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
