import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { MulticaActivationGate, parseMulticaCollectionMode } from '../../../../src/pipeline/input/multica/activation.js';
import { MulticaPipeline } from '../../../../src/pipeline/input/multica/multica-pipeline.js';
import { validateMulticaConfig, type MulticaInputConfig } from '../../../../src/pipeline/input/multica/types.js';
import { postWebtracking } from '../../../../src/flushers/sls-transport.js';

vi.mock('../../../../src/utils/logger.js', () => ({createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()})}));
vi.mock('../../../../src/flushers/sls-transport.js', () => ({postWebtracking: vi.fn()}));

const MODE_ENV = 'LOONGSUITE_PILOT_MULTICA_COLLECTION_MODE';
const ENABLED_ENV = 'LOONGSUITE_PILOT_PIPELINE_MULTICA_ENABLED';
const base: MulticaInputConfig = {Type: 'input_multica'};
const on: MulticaInputConfig = {...base, CollectionMode: 'on'};
const metric = 'multica_http_requests_total{method="GET",route="/api/issues",status="200"} 1\n';
let dir: string;
let servers: Server[];

beforeEach(async () => {
  // Vitest 1.x stringifies undefined; register the originals before deleting.
  vi.stubEnv(MODE_ENV, 'off');
  vi.stubEnv(ENABLED_ENV, 'true');
  delete process.env[MODE_ENV];
  delete process.env[ENABLED_ENV];
  vi.mocked(postWebtracking).mockReset().mockResolvedValue();
  dir = await mkdtemp(path.join(os.tmpdir(), 'multica-activation-'));
  servers = [];
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await rm(dir, {recursive: true, force: true});
});

async function server(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(instance.address() as {port: number}).port}`;
}

function pipeline(input: MulticaInputConfig, mode?: 'on' | 'off'): MulticaPipeline {
  return new MulticaPipeline({
    config: {configName: 'activation', inputs: [input], flushers: [{Type: 'flusher_sls', Endpoint: 'example.invalid', Project: 'p', Logstore: 'l'}]},
    stateDir: dir, dataDir: dir, failedLogDir: dir,
  }, mode);
}

function sentRecords() { return vi.mocked(postWebtracking).mock.calls.flatMap(call => call[1]); }

describe('Multica collection activation', () => {
  it('defaults to off, accepts only on/off, and validates the detection threshold', () => {
    expect(parseMulticaCollectionMode(undefined)).toBe('off');
    expect(parseMulticaCollectionMode(' ON ')).toBe('on');
    for (const value of ['auto', 'enabled', true, 1, null]) expect(() => parseMulticaCollectionMode(value)).toThrow();
    expect(() => validateMulticaConfig({...base, CollectionMode: 'auto' as never})).toThrow();
    for (const threshold of [0, 31, 1.5, '3', null]) {
      expect(() => validateMulticaConfig({...on, DetectionFailureThreshold: threshold as number})).toThrow();
    }
    for (const threshold of [1, 3, 30]) expect(() => validateMulticaConfig({...on, DetectionFailureThreshold: threshold})).not.toThrow();
  });

  it('performs no probes, reads, state initialization, or sends by default', async () => {
    let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(metric); });
    const result = await pipeline({...base, ApiBase: url, WorkspaceIds: ['workspace-1'], TokenFile: path.join(dir, 'missing-token'), MetricsUrls: [`${url}/metrics`]}).collectOnce();
    expect(result).toMatchObject({collectionEnabled: false, collectionMode: 'off', successfulSources: 0, failedSources: 0});
    expect(requests).toBe(0);
    expect(postWebtracking).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it.each([
    'go_goroutines 15\nprocess_cpu_seconds_total 4\n',
    '# HELP multica_http_requests_total Multica request count\n# TYPE multica_http_requests_total counter\n',
    '<html>Multica metrics service</html>',
    'multica_http_requests_total not-a-number\n',
  ])('does not identify a service from HTTP 200 or superficial metric text: %s', async body => {
    const url = await server((_req, res) => res.end(body));
    const result = await new MulticaActivationGate({...on, MetricsUrls: [`${url}/metrics`]}).evaluate();
    expect(result).toMatchObject({enabled: false, mode: 'on', consecutiveMisses: 1, stopped: false});
  });

  it('requires identity even for explicitly enabled file-only configs', async () => {
    const log = path.join(dir, 'multica', 'server.log');
    await mkdir(path.dirname(log));
    await writeFile(log, 'INFO task completed task_id=t1\n');
    const collector = pipeline({...on, LogFiles: [log], StatFiles: [log]});
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await collector.collectOnce()).toMatchObject({collectionEnabled: false, collectionMode: 'on',
        detectionMisses: attempt, collectionStopped: attempt === 3, successfulSources: 0, failedSources: 0});
    }
    expect(postWebtracking).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(['multica']);
  });

  it('starts collection after observing a native Multica metric', async () => {
    const url = await server((_req, res) => res.end(metric));
    const result = await pipeline({...on, MetricsUrls: [`${url}/metrics`]}).collectOnce();
    expect(result).toMatchObject({collectionEnabled: true, collectionMode: 'on', collectionStopped: false,
      detectionMisses: 0, successfulSources: 1, failedSources: 0});
    expect(sentRecords().some(row => row.record_type === 'prometheus_sample' && row.metric_name === 'multica_http_requests_total')).toBe(true);
  });

  it.each(['running', 'starting'])('recognizes a native daemon health response in %s state', async status => {
    const url = await server((_req, res) => res.end(JSON.stringify({
      status, pid: 123, uptime: '10s', daemon_id: 'daemon-1', device_name: 'test-host',
      server_url: 'https://multica.example', agents: ['claude-code'], workspaces: [],
    })));
    expect(await new MulticaActivationGate({...on, DaemonHealthUrls: [`${url}/health`]}).evaluate()).toMatchObject({enabled: true, mode: 'on'});
  });

  it('does not identify a generic health endpoint as Multica', async () => {
    const url = await server((_req, res) => res.end(JSON.stringify({status: 'running', pid: 123, uptime: '10s'})));
    expect(await new MulticaActivationGate({...on, DaemonHealthUrls: [`${url}/health`]}).evaluate()).toMatchObject({enabled: false});
  });

  it.each([
    {allow_signup: true, cdn_domain: '', daemon_setup_target: 'self_host'},
    {allow_signup: false, cdn_domain: '', local_worktree_supported: true, agent_conversation_starters_supported: true},
  ])('recognizes API-only deployments without reading or sending credentials', async config => {
    const requests: {url?: string; authorization?: string; workspace?: string | string[]}[] = [];
    const url = await server((req, res) => {
      requests.push({url: req.url, authorization: req.headers.authorization, workspace: req.headers['x-workspace-id']});
      res.end(JSON.stringify(config));
    });
    const result = await new MulticaActivationGate({...on, ApiBase: url, WorkspaceIds: ['workspace-1'], TokenFile: path.join(dir, 'missing-token')}).evaluate();
    expect(result).toMatchObject({enabled: true});
    expect(requests).toEqual([{url: '/api/config', authorization: undefined, workspace: undefined}]);
  });

  it('skips API collection before the first successful product identification', async () => {
    const requests: string[] = [];
    const url = await server((req, res) => { requests.push(req.url!); res.end(JSON.stringify({allow_signup: true, cdn_domain: ''})); });
    const result = await pipeline({...on, ApiBase: url, WorkspaceIds: ['workspace-1'], TokenFile: path.join(dir, 'missing-token')}).collectOnce();
    expect(result).toMatchObject({collectionEnabled: false, successfulSources: 0, failedSources: 0});
    expect(requests).toEqual(['/api/config']);
    expect(postWebtracking).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('honors environment, input, and global defaults while preserving the legacy hard-off switch', async () => {
    let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(metric); });
    const config = {...base, MetricsUrls: [`${url}/metrics`]};
    expect(await new MulticaActivationGate(config, 'on').evaluate()).toMatchObject({enabled: true, mode: 'on'});
    const gate = new MulticaActivationGate({...config, CollectionMode: 'off'}, 'on');
    expect(await gate.evaluate()).toMatchObject({enabled: false, mode: 'off'});
    vi.stubEnv(MODE_ENV, 'on');
    expect(await gate.evaluate()).toMatchObject({enabled: true, mode: 'on'});
    const beforeOff = requests;
    for (const value of ['false', '0']) {
      vi.stubEnv(ENABLED_ENV, value);
      expect(await gate.evaluate()).toMatchObject({enabled: false, mode: 'off'});
    }
    expect(requests).toBe(beforeOff);
    delete process.env[ENABLED_ENV];
    vi.stubEnv(MODE_ENV, 'off');
    expect(await gate.evaluate()).toMatchObject({enabled: false, mode: 'off'});
  });

  it.each(['typo', 'auto'])('fails closed for an invalid environment override: %s', async value => {
    vi.stubEnv(MODE_ENV, value);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await new MulticaActivationGate(on).evaluate()).toMatchObject({enabled: false});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops after three consecutive initial misses and never probes again until reset', async () => {
    let ready = false;
    let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(ready ? metric : 'go_goroutines 1\n'); });
    const gate = new MulticaActivationGate({...on, MetricsUrls: [`${url}/metrics`]});
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await gate.evaluate()).toMatchObject({enabled: false, consecutiveMisses: attempt, stopped: attempt === 3});
    }
    ready = true;
    expect(await gate.evaluate()).toMatchObject({enabled: false, consecutiveMisses: 3, stopped: true});
    expect(requests).toBe(3);
  });

  it('allows two misses after identification, then stops collection on the third', async () => {
    let healthy = true;
    const url = await server((_req, res) => {
      if (!healthy) res.statusCode = 503;
      res.end(healthy ? metric : 'service unavailable');
    });
    const file = path.join(dir, 'server.log');
    await writeFile(file, 'INFO task completed task_id=t1\n');
    const collector = pipeline({...on, MetricsUrls: [`${url}/metrics`], LogFiles: [file]});
    expect(await collector.collectOnce()).toMatchObject({collectionEnabled: true, detectionMisses: 0});
    healthy = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      vi.mocked(postWebtracking).mockClear();
      expect(await collector.collectOnce()).toMatchObject({collectionEnabled: true, collectionStopped: false,
        detectionMisses: attempt, successfulSources: 1, failedSources: 1});
      expect(sentRecords().some(row => row.record_type === 'collection_status' && row.error_kind === 'http_503')).toBe(true);
    }
    vi.mocked(postWebtracking).mockClear();
    expect(await collector.collectOnce()).toMatchObject({collectionEnabled: false, collectionStopped: true,
      detectionMisses: 3, successfulSources: 0, failedSources: 0});
    expect(postWebtracking).not.toHaveBeenCalled();
  });

  it('resets consecutive misses when identity is observed between failures', async () => {
    let ready = false;
    const url = await server((_req, res) => res.end(ready ? metric : 'go_goroutines 1\n'));
    const gate = new MulticaActivationGate({...on, MetricsUrls: [`${url}/metrics`]});
    expect(await gate.evaluate()).toMatchObject({enabled: false, consecutiveMisses: 1});
    expect(await gate.evaluate()).toMatchObject({enabled: false, consecutiveMisses: 2});
    ready = true;
    expect(await gate.evaluate()).toMatchObject({enabled: true, consecutiveMisses: 0, stopped: false});
    ready = false;
    expect(await gate.evaluate()).toMatchObject({enabled: true, consecutiveMisses: 1, stopped: false});
    expect(await gate.evaluate()).toMatchObject({enabled: true, consecutiveMisses: 2, stopped: false});
    ready = true;
    expect(await gate.evaluate()).toMatchObject({enabled: true, consecutiveMisses: 0, stopped: false});
  });

  it('supports a custom miss threshold and requires an off/on transition to clear the stop latch', async () => {
    let ready = false;
    const url = await server((_req, res) => res.end(ready ? metric : 'go_goroutines 1\n'));
    const gate = new MulticaActivationGate({...on, MetricsUrls: [`${url}/metrics`], DetectionFailureThreshold: 1});
    expect(await gate.evaluate()).toMatchObject({enabled: false, consecutiveMisses: 1, stopped: true});
    ready = true;
    expect(await gate.evaluate()).toMatchObject({enabled: false, stopped: true});
    vi.stubEnv(MODE_ENV, 'off');
    expect(await gate.evaluate()).toMatchObject({enabled: false, mode: 'off', consecutiveMisses: 0, stopped: false});
    vi.stubEnv(MODE_ENV, 'on');
    expect(await gate.evaluate()).toMatchObject({enabled: true, mode: 'on', consecutiveMisses: 0, stopped: false});
  });

  it('does not replay failed pending batches after the detection stop latch engages', async () => {
    let ready = true;
    let requests = 0;
    const url = await server((_req, res) => { requests++; res.end(ready ? metric : 'go_goroutines 1\n'); });
    const collector = pipeline({...on, MetricsUrls: [`${url}/metrics`], DetectionFailureThreshold: 1});
    vi.mocked(postWebtracking).mockRejectedValue(new Error('offline'));
    expect(await collector.collectOnce()).toMatchObject({collectionEnabled: true, failedSources: 1});
    const pendingDir = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.multica-pending'))!);
    const pendingFiles = await readdir(pendingDir);
    expect(pendingFiles).toHaveLength(1);
    const pending = await readFile(path.join(pendingDir, pendingFiles[0]), 'utf8');
    ready = false;
    vi.mocked(postWebtracking).mockClear().mockResolvedValue();
    expect(await collector.collectOnce()).toMatchObject({collectionEnabled: false, collectionStopped: true});
    const stoppedRequests = requests;
    ready = true;
    expect(await collector.collectOnce()).toMatchObject({collectionEnabled: false, collectionStopped: true});
    expect(requests).toBe(stoppedRequests);
    expect(postWebtracking).not.toHaveBeenCalled();
    expect(await readFile(path.join(pendingDir, pendingFiles[0]), 'utf8')).toBe(pending);
  });

  it('does not schedule timers when started with collection disabled', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const collector = pipeline({...base, MetricsUrls: ['http://example.invalid/metrics'], IntervalSeconds: 1});
    try {
      await collector.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { await collector.stop(); }
  });

  it('stops scheduled probing after the third miss without leaving a retry timer', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('go_goroutines 1\n'));
    const collector = pipeline({...on, MetricsUrls: ['http://example.invalid/metrics'], IntervalSeconds: 1});
    try {
      await collector.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(postWebtracking).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(await collector.collectOnce()).toMatchObject({collectionStopped: true, detectionMisses: 3});
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally { await collector.stop(); }
  });
});
