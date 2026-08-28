import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const isProprietary = process.env.BUILD_MODE === 'proprietary';

const commonDefine = {
  '__PROPRIETARY_BUILD__': String(isProprietary),
};

const internalStubPlugin = {
  name: 'internal-stub',
  setup(b) {
    if (isProprietary) return;
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

// Dependency-free browser launcher, safe even when the collector cannot start.
await build({
  entryPoints: ['src/dashboard-cli.ts'],
  outfile: 'dist/dashboard-cli.cjs',
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  minifySyntax: true,
});

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
  // The guard must run BEFORE this bundle's module graph loads: the graph
  // imports sqlite3 at top level (orchestrator.ts → qoder-*-sqlite inputs), so
  // on a libc that cannot load the addon the bundle dies mid-import, before any
  // logging exists, and the spawners used to drop that stderr. A static import
  // in the banner is evaluated first by Node, so the guard's check — and its
  // readable FATAL diagnostic — precede the crash it replaces. See
  // src/native-deps-guard.ts.
  banner: { js: "import './native-deps-guard.cjs';" },
  define: commonDefine,
  plugins: commonPlugins,
});

// Loaded by the banner above, before the daemon graph. Must keep
// `packages: 'external'`: its require('sqlite3') has to resolve against the
// payload's node_modules at runtime — bundling it would try to inline a native
// addon and defeat the check.
await build({
  entryPoints: ['src/native-deps-guard.ts'],
  outfile: 'dist/native-deps-guard.cjs',
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  packages: 'external',
  minifySyntax: true,
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

// Self-contained CJS, like cli-probe above: no `packages: 'external'`, so it
// needs no node_modules at runtime. That is the point — the K8s preload blocks
// the business process on this while it runs, so it must start at bare-node
// cost rather than dragging in the daemon's dependency graph.
await build({
  entryPoints: ['src/inject-hooks.ts'],
  outfile: 'dist/inject-hooks.cjs',
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  bundle: true,
  // Prefer each package's ESM build over its `main`. Needed for real
  // self-containment: jsonc-parser's `main` is a UMD file whose deps are
  // fetched with a runtime require('./impl/format'), which esbuild cannot
  // follow — the bundle then builds fine and throws MODULE_NOT_FOUND on first
  // run without node_modules. Its `module` entry uses static imports that
  // bundle cleanly. Verified by running the artifact with node_modules absent.
  mainFields: ['module', 'main'],
  // Keeps pilot's own logging off the agent's stdout/stderr; this process runs
  // attached to a business workload, and some agents parse their own output.
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
