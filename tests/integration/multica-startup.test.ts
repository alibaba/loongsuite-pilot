import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHomeEnvironment } from '../helpers/isolated-agent-home.js';

it.skipIf(process.platform === 'win32').each(['explicit', 'local daemon'] as const)(
  'starts the %s Multica pipeline through the standard Pilot entry point', async mode => {
  const auto = mode === 'local daemon';
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), 'multica-startup-'));
  // Keep external package resolution in the repository while isolating all runtime state.
  const bundleDir = await mkdtemp(path.join(repo, 'node_modules', '.multica-startup-'));
  const held: ServerResponse[] = [];
  const posts: Array<{__source__: string; __logs__: Record<string, string>[]}> = [];
  const postPaths: string[] = [];
  let release = false;
  let child: ChildProcess | undefined;
  let output = '';
  const profile = 'pilot-test-' + process.pid;
  const healthPort = 19515 + Buffer.from(profile).reduce((sum, byte) => sum + byte, 0) % 1000;
  const daemonHealth = createServer((_req, res) => res.end(JSON.stringify({
    status: 'running', pid: process.pid, uptime: '1m', daemon_id: 'test-daemon',
    device_name: 'test-device', server_url: 'http://multica.test', agents: [], workspaces: null,
  })));
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.end('multica_http_requests_total 1\n');
    } else {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        postPaths.push(new URL(req.url ?? '/', 'http://test').pathname);
        posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (release) res.end('{}');
        else held.push(res);
      });
    }
  });
  const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    const dataDir = path.join(root, 'data');
    const configDir = path.join(dataDir, 'configs', 'local');
    const versionDir = path.join(dataDir, 'versions', 'test');
    await mkdir(configDir, {recursive: true});
    await mkdir(path.join(versionDir, 'agents.d'), {recursive: true});
    await writeFile(path.join(dataDir, 'current'), 'test');
    await writeFile(path.join(versionDir, 'package.json'), '{"version":"1.2.0"}');
    const home = path.join(root, 'home');
    const daemonDir = path.join(home, '.multica', 'profiles', profile);
    const log = auto ? path.join(daemonDir, 'daemon.log') : path.join(root, 'backend.log');
    const content = auto
      ? '12:34:56.789 INF task phase recorded task_id=local-daemon-task task_phase=environment_ready phase_elapsed_ms=250 total_elapsed_ms=500\n'
      : 'INFO comment created issue_id=shutdown-test\n';
    if (auto) {
      await mkdir(daemonDir, {recursive: true});
      await writeFile(path.join(daemonDir, 'daemon.pid'), String(process.pid));
      await new Promise<void>((resolve, reject) => {
        daemonHealth.once('error', reject);
        daemonHealth.listen(healthPort, '127.0.0.1', resolve);
      });
      release = true;
    }
    await writeFile(log, content);
    const agents = Object.fromEntries((await readdir(path.join(repo, 'agents.d')))
      .filter(name => name.endsWith('.json')).map(name => [name.slice(0, -5), {enabled: false}]));
    const configFile = path.join(root, 'config.json');
    await writeFile(configFile, JSON.stringify({enabled: true, dataDir, agents,
      collectTrace: false, serviceNamePrefix: 'installed-pilot-env',
      enableStatusBarApp: false, dashboard: {enabled: false}, autoUpdate: {enabled: false}, interceptor: {mode: 'all'},
      retention: {enabled: false}, hookWatchdog: {enabled: false},
      ...(auto ? {sls: {endpoint: 'http://sls.invalid', project: 'test', logstore: 'agent-event'}}
        : {pipeline: {enabled: true, multica: {mode: 'on'}}})}));
    if (!auto) await writeFile(path.join(configDir, 'lab.json'), JSON.stringify({configName: 'lab',
      inputs: [{Type: 'input_multica', Instance: 'previous-env', CollectionMode: 'on', MetricsUrls: [endpoint], LogFiles: [log]}],
      flushers: [{Type: 'flusher_sls', Endpoint: 'http://sls.invalid', Project: 'test', Logstore: 'lab'}]}));
    const bundle = path.join(bundleDir, 'main.mjs');
    const internalStubPlugin = {name: 'internal-stub', setup(b: import('esbuild').PluginBuild) {
      b.onResolve({filter: /\.internal/}, args => ({path: args.path, namespace: 'internal-stub'}));
      b.onLoad({filter: /.*/, namespace: 'internal-stub'}, () => ({
        contents: 'export function sendAlarm() {} export function sendStatus() {} export function sendRunningStatus() {}',
        loader: 'ts',
      }));
    }};
    // The merge target runs the interceptor in a worker. Build its real entry
    // when present so this test also exercises GitHub's merged PR checkout.
    if (await access(path.join(repo, 'src/interceptor/worker.ts')).then(() => true, () => false)) {
      await build({absWorkingDir: repo, entryPoints: ['src/interceptor/worker.ts'],
        outfile: path.join(bundleDir, 'interceptor', 'worker.cjs'), bundle: true,
        platform: 'node', target: 'node22', format: 'cjs', mainFields: ['module', 'main'],
        define: {'__PROPRIETARY_BUILD__': 'false'}, plugins: [internalStubPlugin]});
    }
    await build({absWorkingDir: repo, entryPoints: ['src/index.ts'], outfile: bundle,
      bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external',
      define: {'__PROPRIETARY_BUILD__': 'false'},
      // Only redirect the SLS destination and shorten the first transport timeout.
      // Detection, retries, manager/orchestrator lifecycle, runtime and SIGTERM are real.
      banner: {js: `const realFetch = globalThis.fetch; let firstPost = true;
        globalThis.fetch = (url, opts) => {
          if (String(url).startsWith('http://test.sls.invalid/')) {
            const signal = firstPost ? AbortSignal.timeout(100) : opts.signal;
            firstPost = false;
            return realFetch(${JSON.stringify(endpoint)} + new URL(url).pathname, {...opts, signal});
          }
          return realFetch(url, opts);
        };`},
      plugins: [internalStubPlugin],
    });
    const env = {...process.env, ...agentHomeEnvironment(home)};
    for (const key of Object.keys(env)) {
      if (key.startsWith('LOONGSUITE_') || key.startsWith('OTEL_')) delete env[key];
    }
    child = spawn(process.execPath, ['--experimental-sqlite', bundle], {cwd: root,
      env: {...env, AGENT_DATA_COLLECTION_CONFIG: configFile, LOONGSUITE_PILOT_DATA_DIR: dataDir,
        ...(auto ? {LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE: 'on', POD_NAME: 'test-daemon-pod'} : {}),
        LOONGSUITE_PILOT_STDOUT: '1', LOONGSUITE_PILOT_INTERCEPTOR_MODE: 'all', LOG_LEVEL: 'info'},
      stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    const exited = new Promise<{code: number | null; signal: string | null}>(resolve => {
      child!.once('exit', (code, signal) => resolve({code, signal}));
    });
    const runtimePath = path.join(dataDir, 'logs', 'runtime.json');
    const interceptorPath = path.join(dataDir, 'interceptor', 'runtime.json');
    await vi.waitFor(async () => {
      expect(await json(runtimePath).catch(() => output)).toMatchObject({status: 'active', pid: child!.pid});
    }, {timeout: 8000});
    await vi.waitFor(async () => {
      expect(await json(interceptorPath).catch(() => output)).toMatchObject({status: 'ok'});
    }, {timeout: 8000});
    const interceptor = await json(interceptorPath);
    expect(interceptor.pid).toBe(child.pid);
    expect((await fetch(`http://127.0.0.1:${interceptor.daemon_port}/health`)).ok).toBe(true);
    if (auto) {
      await vi.waitFor(() => {
        expect(posts.flatMap(post => post.__logs__).find(row => row.task_id === 'local-daemon-task'))
          .toMatchObject({phase: 'environment_ready', phase_elapsed_ms: '250', total_elapsed_ms: '500',
            instance: 'installed-pilot-env', multica_env: 'installed-pilot-env', pod_name: 'test-daemon-pod'});
        expect(postPaths).toContain('/logstores/multica-logs/track');
      }, {timeout: 8000});
      const event = posts.flatMap(post => post.__logs__).find(row => row.task_id === 'local-daemon-task');
      expect(event).not.toHaveProperty('source_time');
      expect(await readdir(configDir)).toEqual([]);
      child.kill('SIGTERM');
      expect(await exited).toEqual({code: 0, signal: null});
      return;
    }
    await vi.waitFor(() => expect(posts).toHaveLength(2), {timeout: 5000});
    for (const post of posts) {
      expect(post.__source__).toBe('installed-pilot-env');
      expect(post.__logs__.map(row => row.record_type)).toEqual(['prometheus_sample', 'collection_status']);
      for (const row of post.__logs__) {
        expect(row).toMatchObject({multica_env: 'installed-pilot-env', instance: 'installed-pilot-env'});
      }
    }
    await vi.waitFor(() => {
      expect(output).toContain('SLS webtracking retrying');
      expect(output).toContain('TimeoutError');
    });
    const stateDir = path.join(dataDir, 'state', 'pipeline');
    const pendingName = (await readdir(stateDir)).find(name => name.endsWith('.multica-pending'))!;
    const pendingDir = path.join(stateDir, pendingName);
    const stateFile = path.join(stateDir, pendingName.replace(/-pending$/, '.json'));
    expect(await readdir(pendingDir)).toHaveLength(1);
    expect(await readFile(stateFile, 'utf8').catch(() => '')).toBe('');
    child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(child.exitCode, output).toBeNull();
    expect(child.signalCode, output).toBeNull();
    release = true;
    for (const response of held) if (!response.destroyed) response.end('{}');
    await vi.waitFor(() => expect(child!.exitCode, output).toBe(0), {timeout: 5000});
    expect(await exited, output).toEqual({code: 0, signal: null});
    expect((await json(stateFile))[`log:${log}`].extra.checkpoint.offset)
      .toBe(Buffer.byteLength(content));
    expect(await readdir(pendingDir)).toEqual([]);
    await expect(readFile(runtimePath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(fetch(`http://127.0.0.1:${interceptor.daemon_port}/health`, {signal: AbortSignal.timeout(1000)})).rejects.toThrow();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child!.once('exit', resolve));
      child.kill('SIGKILL');
      await stopped;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (daemonHealth.listening) {
      daemonHealth.closeAllConnections();
      await new Promise<void>(resolve => daemonHealth.close(() => resolve()));
    }
    await rm(root, {recursive: true, force: true});
    await rm(bundleDir, {recursive: true, force: true});
  }
}, 25000);
