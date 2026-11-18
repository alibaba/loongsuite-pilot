import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentHomeEnvironment } from '../helpers/isolated-agent-home.js';

it.skipIf(process.platform === 'win32')('publishes main-process health during SLS timeout/retry and drains on SIGTERM', async () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), 'multica-startup-'));
  // Keep external package resolution in the repository while isolating all runtime state.
  const bundleDir = await mkdtemp(path.join(repo, 'node_modules', '.multica-startup-'));
  const held: ServerResponse[] = [];
  let posts = 0;
  let release = false;
  let child: ChildProcess | undefined;
  let output = '';
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.end('multica_http_requests_total 1\n');
    } else {
      posts++;
      req.resume();
      if (release) res.end('{}');
      else held.push(res);
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
    const log = path.join(root, 'backend.log');
    const content = 'INFO comment created issue_id=shutdown-test\n';
    await writeFile(log, content);
    const agents = Object.fromEntries((await readdir(path.join(repo, 'agents.d')))
      .filter(name => name.endsWith('.json')).map(name => [name.slice(0, -5), {enabled: false}]));
    const configFile = path.join(root, 'config.json');
    await writeFile(configFile, JSON.stringify({enabled: true, dataDir, agents,
      enableStatusBarApp: false, dashboard: {enabled: false}, autoUpdate: {enabled: false},
      retention: {enabled: false}, hookWatchdog: {enabled: false},
      pipeline: {enabled: true, multica: {mode: 'on'}}}));
    await writeFile(path.join(configDir, 'lab.json'), JSON.stringify({configName: 'lab',
      inputs: [{Type: 'input_multica', CollectionMode: 'on', MetricsUrls: [endpoint], LogFiles: [log]}],
      flushers: [{Type: 'flusher_sls', Endpoint: 'http://sls.invalid', Project: 'test', Logstore: 'lab'}]}));
    const bundle = path.join(bundleDir, 'main.mjs');
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
      plugins: [{name: 'internal-stub', setup(b) {
        b.onResolve({filter: /\.internal/}, args => ({path: args.path, namespace: 'internal-stub'}));
        b.onLoad({filter: /.*/, namespace: 'internal-stub'}, () => ({
          contents: 'export function sendAlarm() {} export function sendStatus() {} export function sendRunningStatus() {}',
          loader: 'ts',
        }));
      }}],
    });
    const env = {...process.env, ...agentHomeEnvironment(path.join(root, 'home'))};
    for (const key of Object.keys(env)) {
      if (key.startsWith('LOONGSUITE_') || key.startsWith('OTEL_')) delete env[key];
    }
    child = spawn(process.execPath, ['--experimental-sqlite', bundle], {cwd: root,
      env: {...env, AGENT_DATA_COLLECTION_CONFIG: configFile, LOONGSUITE_PILOT_DATA_DIR: dataDir,
        LOONGSUITE_PILOT_STDOUT: '1', LOG_LEVEL: 'info'},
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
    await vi.waitFor(() => expect(posts).toBe(2), {timeout: 5000});
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
    await rm(root, {recursive: true, force: true});
    await rm(bundleDir, {recursive: true, force: true});
  }
}, 25000);
