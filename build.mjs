import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const isInternal = process.argv.includes('--internal');

function readDirRecursive(dir, depth = 0) {
  if (depth > 10) throw new Error(`readDirRecursive: exceeded max depth at ${dir}`);
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readDirRecursive(fullPath, depth + 1));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const entryPoints = readDirRecursive('src')
  .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'));

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
