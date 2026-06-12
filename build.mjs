import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const isInternal = process.env.BUILD_TYPE === 'internal';

const commonDefine = {
  '__INTERNAL_BUILD__': String(isInternal),
};

const internalStubPlugin = {
  name: 'internal-stub',
  setup(b) {
    if (isInternal) return;
    b.onResolve({ filter: /\.internal/ }, (args) => ({
      path: args.path,
      namespace: 'internal-stub',
    }));
    b.onLoad({ filter: /alarm-sender\.internal/, namespace: 'internal-stub' }, () => ({
      contents: 'export function sendAlarm() {} export function sendStatus() {}',
      loader: 'ts',
    }));
    b.onLoad({ filter: /statistic\.internal/, namespace: 'internal-stub' }, () => ({
      contents: 'export function sendRunningStatus() {}',
      loader: 'ts',
    }));
  },
};

const commonPlugins = [internalStubPlugin];

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  bundle: true,
  minify: true,
  treeShaking: true,
  packages: 'external',
  define: commonDefine,
  plugins: commonPlugins,
});

await build({
  entryPoints: ['src/cli-probe.ts'],
  outfile: 'dist/cli-probe.cjs',
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  banner: { js: "process.env.LOG_LEVEL = 'silent';" },
  minifySyntax: true,
  define: commonDefine,
  plugins: commonPlugins,
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
  packages: 'external',
  define: commonDefine,
  plugins: commonPlugins,
});

await mkdir('dist', { recursive: true });
await copyFile('src/mask/sensitive-rules.json', 'dist/sensitive-rules.json');

// Best-effort: build macOS status bar app (Swift)
if (process.platform === 'darwin') {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', ['scripts/build-status-bar-app.mjs'], { stdio: 'inherit', timeout: 200_000 });
  } catch {
    // non-fatal — status bar app build failure doesn't block the main build
  }
}
