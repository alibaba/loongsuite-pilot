import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentHomeEnvironment } from '../helpers/isolated-agent-home.js';

// Exercise the real main/Orchestrator/MetricsWriter/Worker chain and actual JSONL.
// Windows native signal termination does not execute Node's SIGTERM cleanup.
describe.skipIf(process.platform === 'win32')('initial interceptor status in the real collector', () => {
  let bundleDir: string;
  let disabledAgents: Record<string, { enabled: boolean }>;
  beforeAll(async () => {
    // External dependencies resolve through the repository node_modules.
    bundleDir = await mkdtemp(join(resolve('node_modules'), '.interceptor-startup-status-'));
    const publicSenders: Plugin = { name: 'public-senders', setup(builder) {
      builder.onResolve({ filter: /\.internal\.js$/ }, args => ({
        path: resolve(args.resolveDir, args.path.replace('.internal.js', '.ts')),
      }));
    } };
    const common = { bundle: true, platform: 'node' as const, target: 'node22',
      define: { __PROPRIETARY_BUILD__: 'false' }, plugins: [publicSenders], logLevel: 'silent' as const };
    await build({ ...common, entryPoints: ['src/interceptor/worker.ts'],
      outfile: join(bundleDir, 'interceptor', 'worker.cjs'), format: 'cjs', mainFields: ['module', 'main'] });
    await build({ ...common, entryPoints: ['src/index.ts'], outfile: join(bundleDir, 'main.mjs'),
      format: 'esm', packages: 'external' });
    await mkdir(join(bundleDir, 'failed', 'interceptor'), { recursive: true });
    await copyFile(join(bundleDir, 'main.mjs'), join(bundleDir, 'failed', 'main.mjs'));
    await writeFile(join(bundleDir, 'failed', 'interceptor', 'worker.cjs'),
      'throw new Error("synthetic interceptor startup failure");');
    disabledAgents = Object.fromEntries((await readdir('agents.d')).filter(name => name.endsWith('.json'))
      .map(name => [name.slice(0, -5), { enabled: false }]));
  }, 30_000);
  afterAll(async () => { if (bundleDir) await rm(bundleDir, { recursive: true, force: true }); });

  it.each(['enabled', 'disabled', 'failed'] as const)('writes the completed %s startup state before the first periodic report', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-startup-status-'));
    const dataDir = join(root, 'data');
    let child: ChildProcess | undefined;
    let exited: Promise<void> | undefined;
    let output = '';
    const rows = async (): Promise<any[]> => {
      const dir = join(dataDir, 'logs', 'metric_alarm');
      const files = (await readdir(dir)).filter(name => /^pilot-metrics-.*\.jsonl$/.test(name));
      return (await Promise.all(files.map(name => readFile(join(dir, name), 'utf8'))))
        .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    };
    try {
      const versionDir = join(dataDir, 'versions', 'test');
      await mkdir(join(versionDir, 'agents.d'), { recursive: true });
      await mkdir(join(dataDir, 'configs', 'managed'), { recursive: true });
      await writeFile(join(dataDir, 'current'), 'test');
      await writeFile(join(versionDir, 'package.json'), '{"version":"startup-status-test"}');
      await writeFile(join(dataDir, 'configs', 'managed', 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
        kind: 'pattern', id: 'startup', version: '1', agents: ['qoder'], events: ['UserPromptSubmit'],
        match: 'substring', pattern: 'STARTUP_STATUS_PROBE',
      }] } }));
      const config = join(root, 'config.json');
      await writeFile(config, JSON.stringify({ enabled: true, dataDir, agents: disabledAgents,
        userId: 'startup-status-test', collectTrace: false, jsonl: { enabled: false },
        enableStatusBarApp: false, dashboard: { enabled: false }, autoUpdate: { enabled: false },
        interceptor: { mode: scenario === 'disabled' ? 'none' : 'all' },
        retention: { enabled: false }, hookWatchdog: { enabled: false }, pipeline: { enabled: false } }));
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('LOONGSUITE_') || key.startsWith('OTEL_')) delete env[key];
      }
      Object.assign(env, agentHomeEnvironment(join(root, 'home')), {
        NODE_OPTIONS: '', AGENT_DATA_COLLECTION_CONFIG: config,
        LOONGSUITE_PILOT_DATA_DIR: dataDir, LOONGSUITE_PILOT_CACHE_DIR: dataDir,
        LOONGSUITE_PILOT_STDOUT: '1', LOG_LEVEL: 'info',
      });
      child = spawn(process.execPath, [join(bundleDir, ...(scenario === 'failed' ? ['failed'] : []), 'main.mjs')],
        { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_000); };
      child.stdout!.on('data', capture);
      child.stderr!.on('data', capture);
      exited = new Promise<void>(resolveExit => child!.once('exit', () => resolveExit()));
      await vi.waitFor(() => {
        expect(child!.exitCode, output).toBeNull();
        expect(output).toContain('orchestrator started');
      }, { timeout: 15_000, interval: 25 });

      // No getter calls or timer advancement: inspect the actual startup output.
      const initial = await rows();
      expect(initial).toHaveLength(1);
      if (scenario === 'enabled') {
        expect(initial[0].interceptor).toMatchObject({
          enabled: true, running: true, collection_status: 'ok',
          sampled_at: expect.any(String), worker_started_at: expect.any(String),
          rules: { configured: 1, effective: 1 },
          activity: { evaluations_total: 0 },
        });
        const runtime = JSON.parse(await readFile(join(dataDir, 'interceptor', 'runtime.json'), 'utf8'));
        const response = await fetch('http://127.0.0.1:' + runtime.daemon_port + '/v1/hooks/evaluate', {
          method: 'POST', headers: { connection: 'close' },
          body: JSON.stringify({ agent: 'qoder', event: 'UserPromptSubmit', prompt: 'STARTUP_STATUS_PROBE' }),
          signal: AbortSignal.timeout(2_000),
        });
        expect(await response.json()).toMatchObject({ action: 'block', matched: true });
      } else {
        expect(initial[0].interceptor).toMatchObject({
          enabled: scenario !== 'disabled', running: false,
          collection_status: scenario === 'disabled' ? 'disabled' : 'unavailable',
          worker_started_at: null, rules: null,
        });
        if (scenario === 'failed') expect(output).toContain('interceptor start failed');
      }
      child.kill('SIGTERM');
      await vi.waitFor(() => expect(child!.exitCode, output).toBe(0), { timeout: 10_000, interval: 25 });
      const final = await rows();
      expect(final).toHaveLength(2); // Startup + shutdown; no extra immediate status burst.
      expect(final[1].interceptor.running).toBe(false);
      if (scenario === 'enabled') expect(final[1].interceptor.activity).toMatchObject({ evaluations_total: 1, blocked_total: 1 });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
