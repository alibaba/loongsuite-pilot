import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

interface ChildRun {
  child: ChildProcessWithoutNullStreams;
  activationFile: string;
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

async function launch(metricsUrl: string, enabled: boolean, once = false): Promise<ChildRun> {
  const configPath = path.join(testDir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    configName: 'cli-activation', inputs: [{Type: 'input_multica', MetricsUrls: [metricsUrl],
      IntervalSeconds: 1, DetectionFailureThreshold: 2, ...(enabled ? {CollectionMode: 'on'} : {})}],
    flushers: [{Type: 'flusher_sls', Endpoint: 'example.invalid', Project: 'unused', Logstore: 'unused'}],
  }));
  const env: NodeJS.ProcessEnv = {...process.env, LOG_LEVEL: 'info'};
  delete env.LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE;
  delete env.LOONGSUITE_PILOT_PIPELINE_MULTICA_ENABLED;
  const stateDir = path.join(testDir, 'state');
  const activationFile = path.join(testDir, 'activation.json');
  await mkdir(stateDir);
  const child = spawn(process.execPath, [path.join(bundleDir, 'collector.cjs'), '--config', configPath,
    '--state-dir', stateDir, '--activation-state-file', activationFile, ...(once ? ['--once'] : [])], {env, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdin.end();
  const run: ChildRun = {
    child, activationFile, stdout: '', stderr: '',
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
  it('stays alive while disabled by default and performs no HTTP requests', async () => {
    let requests = 0;
    const run = await launch(await metricsServer(() => { requests++; }), false);
    await waitFor(run, () => run.stdout.includes('Multica collection activation'));
    await delay(200);
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    expect(requests).toBe(0);
    expect(JSON.parse(await readFile(run.activationFile, 'utf8'))).toMatchObject({enabled: false, mode: 'off', expiresAt: 0});
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
    expect(JSON.parse(await readFile(run.activationFile, 'utf8'))).toMatchObject({enabled: false, stopped: true, expiresAt: 0});
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
