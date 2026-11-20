import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSync } from 'protobufjs';

interface ChildRun {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  closed: Promise<{code: number | null; signal: NodeJS.Signals | null}>;
}

let bundleDir: string;
let testDir: string;
let children: ChildRun[];
let servers: Server[];

beforeAll(async () => {
  bundleDir = await mkdtemp(path.join(os.tmpdir(), 'multica-cli-activation-'));
  await build({
    entryPoints: ['src/pipeline/input/multica/cli.ts'], outfile: path.join(bundleDir, 'collector.cjs'),
    platform: 'node', target: 'node22', format: 'cjs', bundle: true, logLevel: 'silent',
    define: {__INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false'},
  });
});
beforeEach(async () => {
  testDir = await mkdtemp(path.join(bundleDir, 'case-'));
  children = [];
  servers = [];
});
afterEach(async () => {
  for (const run of children) {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.child.kill('SIGTERM');
      const timer = setTimeout(() => run.child.kill('SIGKILL'), 1_000);
      try { await run.closed; } finally { clearTimeout(timer); }
    }
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await rm(testDir, {recursive: true, force: true});
});
afterAll(async () => { await rm(bundleDir, {recursive: true, force: true}); });

async function metricsServer(onRequest: () => void): Promise<string> {
  const server = createServer((_req, res) => {
    onRequest();
    res.end('go_goroutines 4\nprocess_cpu_seconds_total 1\n');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as {port: number}).port}/metrics`;
}

async function launch(metricsUrl: string, enabled: boolean, once = false, pilotConfig?: Record<string, unknown>): Promise<ChildRun> {
  const configPath = path.join(testDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    configName: 'cli-activation', inputs: [{Type: 'input_multica', Instance: 'previous-env', MetricsUrls: [metricsUrl],
      IntervalSeconds: 1, DetectionFailureThreshold: 2, ...(enabled ? {CollectionMode: 'on'} : {})}],
    flushers: pilotConfig ? undefined : [{Type: 'flusher_sls', Endpoint: 'example.invalid', Project: 'unused', Logstore: 'unused'}],
  }));
  const env: NodeJS.ProcessEnv = {...process.env, LOG_LEVEL: 'info'};
  // A standalone collector now reads installed Pilot reporting configuration.
  // Isolate subprocess tests from the developer's installation and credentials.
  for (const key of Object.keys(env)) if (key.startsWith('LOONGSUITE_') || key === 'AGENT_DATA_COLLECTION_CONFIG') delete env[key];
  const pilotConfigPath = path.join(testDir, 'pilot-config.json');
  await writeFile(pilotConfigPath, JSON.stringify({dataDir: testDir, ...pilotConfig}));
  env.AGENT_DATA_COLLECTION_CONFIG = pilotConfigPath;
  delete env.LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE;
  delete env.LOONGSUITE_PILOT_PIPELINE_MULTICA_ENABLED;
  const stateDir = path.join(testDir, 'state');
  await mkdir(stateDir);
  const child = spawn(process.execPath, [path.join(bundleDir, 'collector.cjs'), '--config', configPath,
    '--state-dir', stateDir,
    ...(pilotConfig ? ['--pilot-config', pilotConfigPath] : []), ...(once ? ['--once'] : [])], {env, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdin.end();
  const run: ChildRun = {
    child, stdout: '', stderr: '',
    closed: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({code, signal}));
    }),
  };
  child.stdout.on('data', chunk => { run.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { run.stderr += chunk.toString(); });
  children.push(run);
  return run;
}

async function waitFor(run: ChildRun, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(`Collector exited before condition: ${run.stderr}\n${run.stdout}`);
    }
    if (Date.now() > deadline) throw new Error(`Collector condition timed out: ${run.stderr}\n${run.stdout}`);
    await delay(20);
  }
}

async function terminateNormally(run: ChildRun): Promise<void> {
  run.child.kill('SIGTERM');
  expect(await run.closed).toEqual({code: 0, signal: null});
}

describe('Multica standalone CLI activation lifecycle', () => {
  it.each([null, 'invalid-json', '[]'])('rejects an unreadable or invalid explicit reporting file before probing: %s', async content => {
    let requests = 0;
    const metricsUrl = await metricsServer(() => { requests++; });
    const configPath = path.join(testDir, 'pipeline.json');
    const pilotPath = path.join(testDir, 'explicit-pilot.json');
    await writeFile(configPath, JSON.stringify({
      configName: 'bad-reporting', inputs: [{Type: 'input_multica', CollectionMode: 'on', MetricsUrls: [metricsUrl]}],
      flushers: [{Type: 'flusher_sls', Endpoint: 'example.invalid', Project: 'standalone', Logstore: 'multica-logs'}],
    }));
    if (content !== null) await writeFile(pilotPath, content);
    const env = {...process.env, AGENT_DATA_COLLECTION_CONFIG: pilotPath, LOONGSUITE_PILOT_DATA_DIR: testDir};
    const result = await new Promise<{code: unknown; stdout: string; stderr: string}>(resolve => {
      execFile(process.execPath, [path.join(bundleDir, 'collector.cjs'), '--config', configPath,
        '--pilot-config', pilotPath, '--state-dir', path.join(testDir, 'state'), '--once'],
      {env, timeout: 10_000}, (error, stdout, stderr) => resolve({code: error ? error.code ?? error.signal : 0, stdout, stderr}));
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Multica collector failed');
    expect(requests).toBe(0);
  }, 15_000);

  it('inherits reporting, environment, and collection mode from --pilot-config with trace disabled', async () => {
    const writes: Array<{url: string; auth?: string; host?: string; body: Buffer}> = [];
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') res.end('multica_task_total 1\n');
      else {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        writes.push({url: req.url ?? '', auth: req.headers.authorization, host: req.headers.host, body: Buffer.concat(chunks)});
        res.end('{}');
      }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    const run = await launch(`${endpoint}/metrics`, false, true, {
      serviceNamePrefix: 'installed-cli-env', collectTrace: false,
      sls: {endpoint, project: 'cli-project', logstore: 'agent-event', mode: 'apiKey', apiKey: 'test-cli-key'},
      pipeline: {multica: {mode: 'on'}},
    });
    expect(await run.closed).toEqual({code: 0, signal: null});
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({url: '/logstores/multica-logs/shards/lb', auth: 'Bearer test-cli-key', host: `cli-project.${new URL(endpoint).host}`});
    const slsSchema = createRequire(import.meta.url).resolve('@alicloud/log/lib/sls.proto');
    const logGroup = loadSync(slsSchema).lookupType('sls.LogGroup');
    const group = logGroup.toObject(logGroup.decode(writes[0].body));
    expect(group.Source).toBe('installed-cli-env');
    expect(group.Logs).toHaveLength(2);
    for (const log of group.Logs) {
      expect(log.Contents).toEqual(expect.arrayContaining([
        {Key: 'multica_env', Value: 'installed-cli-env'}, {Key: 'instance', Value: 'installed-cli-env'},
      ]));
    }
    expect(run.stdout).not.toContain('test-cli-key');
    expect(run.stderr).not.toContain('test-cli-key');
  }, 5_000);

  it('honors the installed Multica disabled switch even when the input requests on', async () => {
    let requests = 0;
    const run = await launch(await metricsServer(() => { requests++; }), true, true, {
      sls: {endpoint: 'example.invalid', project: 'cli-project', logstore: 'agent-event', mode: 'apiKey', apiKey: 'test-cli-key'},
      pipeline: {multica: {enabled: false, mode: 'on'}},
    });
    expect(await run.closed).toEqual({code: 0, signal: null});
    expect(requests).toBe(0);
    expect(run.stdout).toContain('"reason":"pipeline_disabled"');
  }, 5_000);

  it('stays alive while disabled by default and performs no HTTP requests', async () => {
    let requests = 0;
    const run = await launch(await metricsServer(() => { requests++; }), false);
    await waitFor(run, () => run.stdout.includes('Multica collection activation'));
    await delay(200);
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    expect(requests).toBe(0);
    expect(run.stdout).toContain('"reason":"forced_off"');
    await terminateNormally(run);
  }, 5_000);

  it('remains alive after the miss threshold without restarting detection', async () => {
    let requests = 0;
    const run = await launch(await metricsServer(() => { requests++; }), true);
    await waitFor(run, () => requests === 2);
    await delay(1_300);
    expect(requests).toBe(2);
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    expect(run.stdout).toContain('"reason":"detection_failure_threshold"');
    await terminateNormally(run);
  }, 6_000);

  it('--once exits successfully with a disabled summary and no HTTP requests', async () => {
    let requests = 0;
    const run = await launch(await metricsServer(() => { requests++; }), false, true);
    expect(await run.closed).toEqual({code: 0, signal: null});
    const rows = run.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(rows.find(row => 'collectionEnabled' in row)).toMatchObject({
      collectionEnabled: false, collectionMode: 'off', successfulSources: 0, failedSources: 0,
    });
    expect(requests).toBe(0);
  }, 5_000);
});
