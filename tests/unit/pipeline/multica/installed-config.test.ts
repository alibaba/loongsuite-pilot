import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'protobufjs';
import { loadConfig, buildOtlpTraceConfig } from '../../../../src/core/config-loader.js';
import { PipelineManager } from '../../../../src/pipeline/pipeline-manager.js';

const logger = vi.hoisted(() => ({info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn()}));
vi.mock('../../../../src/utils/logger.js', () => ({createLogger: () => logger}));

// Decode the actual protobuf sent by the production transport, rather than
// replacing the sender with a mock that could hide an incorrect auth route.
const logGroupType = parse(`
  syntax = "proto2";
  message Content { required string key = 1; required string value = 2; }
  message Log { required uint32 time = 1; repeated Content contents = 2; }
  message LogGroup {
    repeated Log logs = 1;
    optional string topic = 3;
    optional string source = 4;
    repeated Content tags = 6;
  }
`).root.lookupType('LogGroup');

interface ReceivedRequest {url: string; headers: IncomingHttpHeaders; body: Buffer}
function records(requests: ReceivedRequest[]): Record<string, string>[] {
  return requests.flatMap(request => {
    const group = logGroupType.toObject(logGroupType.decode(request.body)) as {
      logs?: Array<{contents?: Array<{key: string; value: string}>}>;
    };
    return (group.logs ?? []).map(log => Object.fromEntries((log.contents ?? []).map(row => [row.key, row.value])));
  });
}

let directory: string;
let configDir: string;
let stateDir: string;
let serverLog: string;
let server: Server;
let endpoint: string;
let metricRequests: number;
let writes: ReceivedRequest[];
let sendStatus: number;
let tasks: Record<string, unknown>[];
let manager: PipelineManager | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  // Keep workstation configuration and environment credentials out of the test.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LOONGSUITE_') || key === 'AGENT_DATA_COLLECTION_CONFIG') vi.stubEnv(key, undefined);
  }
  directory = await mkdtemp(path.join(os.tmpdir(), 'multica-installed-config-'));
  configDir = path.join(directory, 'configs', 'local');
  stateDir = path.join(directory, 'state', 'pipeline');
  serverLog = path.join(directory, 'backend.log');
  await mkdir(configDir, {recursive: true});
  await writeFile(serverLog, 'INFO comment created issue_id=installed-config-event\n');
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(directory, 'config.json'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', directory);
  metricRequests = 0;
  writes = [];
  sendStatus = 200;
  tasks = [];
  server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      metricRequests++;
      res.setHeader('Content-Type', 'text/plain');
      res.end('# TYPE multica_task_total counter\nmultica_task_total 3\n');
      return;
    }
    if (req.method === 'GET') {
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      const response = pathname === '/api/agents' ? [{id: 'agent-a'}]
        : pathname === '/api/agents/agent-a/tasks' || pathname === '/api/agent-task-snapshot' ? tasks
        : pathname === '/api/issues' ? {issues: []}
        : pathname === '/api/issue-statuses' ? {statuses: []}
        : pathname === '/api/autopilots' ? {autopilots: []}
        : pathname === '/api/autopilots/usage' ? {} : [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(response));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    writes.push({url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks)});
    res.statusCode = sendStatus;
    res.end(sendStatus === 200 ? '{}' : '{"error":"unauthorized"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await manager?.stop();
  manager = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(directory, {recursive: true, force: true});
  vi.unstubAllEnvs();
});

async function installConfig(apiKey = 'test-installer-api-key', collectionMode?: 'on' | 'off') {
  // This is the config.json shape written by installer.sh --sls-* / --cms-*.
  // Enabling the pipeline and supplying its source is a separate opt-in step.
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({
    dataDir: directory,
    collectLog: true,
    collectTrace: true,
    serviceNamePrefix: 'ai-coding-agent',
    sls: {endpoint, project: 'agentloop-installer-target', logstore: 'agent-event', mode: 'apiKey', apiKey},
    cms: {
      endpoint: 'https://proj-xtrace-unrelated.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry',
      licenseKey: 'test-cms-license-key',
      workspace: 'default-cms-test',
    },
    pipeline: {enabled: true},
  }));
  await writeFile(path.join(configDir, 'multica.json'), JSON.stringify({
    configName: 'multica',
    inputs: [{
      Type: 'input_multica',
      ...(collectionMode ? {CollectionMode: collectionMode} : {}),
      MetricsUrls: [`${endpoint}/metrics`],
      LogFiles: [serverLog],
      Instance: 'multica-installer-test',
    }],
    flushers: [{Type: 'flusher_sls'}],
  }));
  return loadConfig();
}

async function collectInstalledConfig() {
  const config = await loadConfig();
  logger.info.mockClear();
  manager = new PipelineManager({
    configDir, stateDir, failedLogDir: path.join(directory, 'failed'), dataDir: directory,
    pipelineConfig: config.pipeline, sls: config.flushers.sls,
  });
  await manager.start();
  // Pipeline startup schedules collection in the background so it cannot
  // block Pilot readiness. Wait for this cycle before stopping the manager.
  await vi.waitFor(() => {
    expect(logger.info.mock.calls.some(([message, state]) => message === 'collection cycle complete'
      || (message === 'Multica collection activation' && state.enabled === false))).toBe(true);
  }, {timeout: 5_000});
  await manager.stop();
  manager = undefined;
}

describe('Multica inherits installer SLS configuration', () => {
  it.each(['', '\n', '\r\n'])('redacts complete private tails before pending storage and real HTTP delivery (%j)', async separator => {
    await installConfig('test-installer-api-key', 'on');
    const error = `execution failed prompt="PRIVATE_FIRST${separator}PRIVATE_SECOND"`;
    const stderr = `command failed body="PRIVATE_STDERR_FIRST${separator}PRIVATE_STDERR_SECOND"`;
    await writeFile(serverLog, JSON.stringify({msg: 'task failed', task_id: 'log-task', error, stderr}) + '\n');
    tasks = [{id: 'api-task', status: 'failed', error, stderr}];
    vi.stubEnv('MULTICA_DIAGNOSTIC_TEST_TOKEN', 'test-multica-api-token');
    const inputFile = path.join(configDir, 'multica.json');
    const pipeline = JSON.parse(await readFile(inputFile, 'utf8'));
    Object.assign(pipeline.inputs[0], {ApiBase: endpoint, WorkspaceIds: ['workspace-a'], TokenEnv: 'MULTICA_DIAGNOSTIC_TEST_TOKEN'});
    await writeFile(inputFile, JSON.stringify(pipeline));
    // Keep batches durable after the controlled HTTP server receives them.
    sendStatus = 401;
    await collectInstalledConfig();
    const sent = records(writes);
    for (const [type, task_id] of [['server_log', 'log-task'], ['task_snapshot', 'api-task']]) {
      expect(sent).toContainEqual(expect.objectContaining({record_type: type, task_id,
        error_message: 'execution failed prompt=[REDACTED]', stderr: 'command failed body=[REDACTED]'}));
    }
    for (const request of writes) {
      expect(request.headers['content-type']).toBe('application/x-protobuf');
      expect(request.body.toString('utf8')).not.toContain('PRIVATE_');
    }
    const pendingName = (await readdir(stateDir)).find(name => name.endsWith('.multica-pending'))!;
    const pendingDir = path.join(stateDir, pendingName);
    const pending = (await Promise.all((await readdir(pendingDir)).map(file => readFile(path.join(pendingDir, file), 'utf8')))).join('\n');
    expect(pending).toContain('execution failed prompt=[REDACTED]');
    expect(pending).toContain('command failed body=[REDACTED]');
    expect(pending).not.toContain('PRIVATE_');
  });
  it('uses the installed project and API key for multica-logs, independently of Agent and CMS destinations', async () => {
    const config = await installConfig('test-installer-api-key', 'on');
    expect(config.flushers.sls?.endpoints[0]).toMatchObject({
      endpoint, project: 'agentloop-installer-target', logstore: 'agent-event',
      mode: 'apiKey', apiKey: 'test-installer-api-key',
    });
    expect(buildOtlpTraceConfig(config)?.endpoints[0]).toMatchObject({
      endpoint: 'https://proj-xtrace-unrelated.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry',
    });
    await collectInstalledConfig();
    expect(metricRequests).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    for (const request of writes) {
      expect(request.url).toBe('/logstores/multica-logs/shards/lb');
      expect(request.headers.host).toBe(`agentloop-installer-target.${new URL(endpoint).host}`);
      expect(request.headers.authorization).toBe('Bearer test-installer-api-key');
      expect(request.headers['content-type']).toBe('application/x-protobuf');
    }
    expect(records(writes)).toEqual(expect.arrayContaining([
      expect.objectContaining({record_type: 'server_log', issue_id: 'installed-config-event'}),
      expect.objectContaining({record_type: 'prometheus_sample', metric_name: 'multica_task_total', metric_value: '3'}),
    ]));
    const persistedConfig = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
    expect(persistedConfig.sls.logstore).toBe('agent-event');
    expect(JSON.stringify(records(writes))).not.toContain('test-installer-api-key');
    expect(JSON.stringify(records(writes))).not.toContain('test-cms-license-key');
  });

  it('keeps Multica off even with complete installed SLS credentials and pipeline enabled', async () => {
    const config = await installConfig();
    expect(config.pipeline.multica?.mode).toBe('off');
    await collectInstalledConfig();
    expect(metricRequests).toBe(0);
    expect(writes).toHaveLength(0);
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('retains unacknowledged data and retries with a rotated installed key without persisting credentials', async () => {
    await installConfig('test-expired-api-key', 'on');
    sendStatus = 401;
    await collectInstalledConfig();
    const attemptedLog = records(writes).find(row => row.record_type === 'server_log');
    expect(attemptedLog?.issue_id).toBe('installed-config-event');
    const names = await readdir(stateDir);
    expect(names.filter(name => name.endsWith('.multica.json'))).toEqual([]);
    const pendingDir = path.join(stateDir, names.find(name => name.endsWith('.multica-pending'))!);
    const pendingFiles = await readdir(pendingDir);
    expect(pendingFiles.length).toBeGreaterThan(0);
    const pending = (await Promise.all(pendingFiles.map(file => readFile(path.join(pendingDir, file), 'utf8')))).join('\n');
    expect(pending).toContain(attemptedLog!.event_id);
    expect(pending).not.toContain('test-expired-api-key');
    expect(pending).not.toContain('test-cms-license-key');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('test-expired-api-key');

    // The same target must retain the batch/event ID across credential rotation.
    await appendFile(serverLog, 'INFO comment created issue_id=after-rotation\n');
    await installConfig('test-rotated-api-key', 'on');
    sendStatus = 200;
    writes = [];
    await collectInstalledConfig();
    expect(writes.every(request => request.headers.authorization === 'Bearer test-rotated-api-key')).toBe(true);
    expect(records(writes).filter(row => row.record_type === 'server_log')).toEqual([attemptedLog]);
    expect(await readdir(pendingDir)).toEqual([]);
    expect((await readdir(stateDir)).some(name => name.endsWith('.multica.json'))).toBe(true);

    writes = [];
    await collectInstalledConfig();
    expect(records(writes).filter(row => row.record_type === 'server_log').map(row => row.issue_id)).toEqual(['after-rotation']);
    const stateFile = (await readdir(stateDir)).find(name => name.endsWith('.multica.json'))!;
    const state = await readFile(path.join(stateDir, stateFile), 'utf8');
    expect(state).not.toContain('test-expired-api-key');
    expect(state).not.toContain('test-rotated-api-key');
  });
});
