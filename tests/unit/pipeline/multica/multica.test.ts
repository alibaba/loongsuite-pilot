import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { parseMulticaLog, parsePrometheus } from '../../../../src/pipeline/input/multica/parsers.js';
import { envelope, snapshot } from '../../../../src/pipeline/input/multica/records.js';
import { collectApi, collectFileStat, collectLog } from '../../../../src/pipeline/input/multica/sources.js';
import { fetchBounded } from '../../../../src/pipeline/input/multica/http.js';
import { validateMulticaConfig, type MulticaInputConfig, type MulticaRecord } from '../../../../src/pipeline/input/multica/types.js';
import { MulticaPipeline } from '../../../../src/pipeline/input/multica/multica-pipeline.js';
import { PipelineManager } from '../../../../src/pipeline/pipeline-manager.js';
import { postWebtracking } from '../../../../src/flushers/sls-transport.js';

vi.mock('../../../../src/utils/logger.js', () => ({createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()})}));
vi.mock('../../../../src/flushers/sls-transport.js', () => ({postWebtracking: vi.fn()}));
// Activation is exercised with real endpoints in activation.test.ts; keep delivery tests focused on ACK/checkpoints.
vi.mock('../../../../src/pipeline/input/multica/activation.js', () => ({MulticaActivationGate: class {
  async evaluate() { return {enabled: true, mode: 'on', reason: 'metrics_detected', consecutiveMisses: 0, stopped: false}; }
}}));
let dir: string;
let servers: Server[];
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'multica-test-')); servers = []; vi.mocked(postWebtracking).mockReset().mockResolvedValue(); });
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  vi.unstubAllEnvs();
  await rm(dir, {recursive: true, force: true});
});
const input: MulticaInputConfig = {Type: 'input_multica'};
async function server(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const s = createServer(handler); servers.push(s);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as {port: number}).port}`;
}
function pipeline(config: MulticaInputConfig, serviceNamePrefix?: string): MulticaPipeline {
  return new MulticaPipeline({config: {configName: 'lab', inputs: [config], flushers: [{Type: 'flusher_sls', Endpoint: 'example.invalid', Project: 'p', Logstore: 'l'}]}, stateDir: dir, dataDir: dir, failedLogDir: dir, serviceNamePrefix});
}

describe('Multica existing-data parsers', () => {
  it('separates native telemetry, simulated work and explicitly injected failures without interpreting prose', () => {
    const config: MulticaInputConfig = {...input, EvidenceKind: 'observed', AgentEvidence: {
      real: {Kind: 'observed', WorkloadType: 'real_llm'},
      fake: {Kind: 'fixture', WorkloadType: 'simulated_cli'},
      injected: {Kind: 'fault_injection', WorkloadType: 'fault_injection'},
    }};
    validateMulticaConfig(config);
    const record = {record_type: 'task_snapshot', status: 'failed'};
    expect(envelope(config, 'tasks', 1, {...record, agent_id: 'real'})).toMatchObject({evidence_kind: 'observed', workload_type: 'real_llm'});
    expect(envelope(config, 'tasks', 1, {...record, agent_id: 'fake'})).toMatchObject({evidence_kind: 'fixture', workload_type: 'simulated_cli'});
    expect(envelope(config, 'tasks', 1, {...record, agent_id: 'injected'})).toMatchObject({evidence_kind: 'fault_injection'});
    expect(envelope(config, 'issues', 1, {assignee_type: 'agent', assignee_id: 'fake'}).evidence_kind).toBe('fixture');
    expect(envelope(config, 'metrics', 1, {record_type: 'prometheus_sample'})).toMatchObject({evidence_kind: 'observed', workload_type: 'mixed_lab'});
    expect(() => validateMulticaConfig({...config, AgentEvidence: {bad: {Kind: 'pretend', WorkloadType: 'real_llm'}} as never})).toThrow('Invalid AgentEvidence');
  });
  it('keeps histogram buckets and safe labels without secrets or arbitrary metrics', () => {
    const rows = parsePrometheus('# HELP ignore\nmultica_http_request_seconds_bucket{route="/api/issues",le="+Inf",token="secret"} 9\ngo_goroutines 12\nother_secret 4\nprocess_cpu_seconds_total 1.25e2\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({metric_value: '9', le: '+Inf', route: '/api/issues'});
    expect(JSON.stringify(rows)).not.toContain('secret');
    const failures = parsePrometheus('multica_agent_task_failed_total{failure_reason="rate_limit",runtime_mode="local"} 1\nmultica_agent_task_failed_total{failure_reason="auth",runtime_mode="local"} 2');
    expect(failures[0]).toMatchObject({failure_reason: 'rate_limit', runtime_mode: 'local'});
    expect(failures[0].entity_id).not.toBe(failures[1].entity_id);
  });
  it('removes query content from metric path labels without merging distinct counter series', () => {
    const rows = parsePrometheus('multica_http_request_total{path="/api/search?q=private-message&filter=private-filter"} 1\n'
      + 'multica_http_request_total{path="/api/search?q=another-message"} 2\n'
      + 'multica_http_request_total{path="/api/issues"} 3\n');
    expect(rows).toHaveLength(3);
    expect(rows.map(row => JSON.parse(row.metric_labels).path)).toEqual(['/api/search', '/api/search', '/api/issues']);
    expect(rows[0].entity_id).not.toBe(rows[1].entity_id);
    expect(JSON.stringify(rows)).not.toMatch(/private-message|private-filter|another-message|\?q=/);
  });
  it('omits arbitrary query labels while retaining distinct raw series identities', () => {
    const rows = parsePrometheus('multica_http_request_total{query="customer-private-search",method="GET"} 1\n'
      + 'multica_http_request_total{query="another-private-search",method="GET"} 2\n');
    expect(rows).toHaveLength(2);
    expect(rows.map(row => JSON.parse(row.metric_labels))).toEqual([{method: 'GET'}, {method: 'GET'}]);
    expect(rows[0].entity_id).not.toBe(rows[1].entity_id);
    expect(JSON.stringify(rows)).not.toMatch(/customer-private-search|another-private-search|"query"/);
  });
  it('parses Kubernetes timestamp + tint duration, exports only known message templates', () => {
    const row = parseMulticaLog('2026-11-16T08:00:00.123Z \u001b[32mINF\u001b[0m http request method=POST path=/api/issues/i/comments?token=secret status=200 duration=1.25s request_id=req-1 token=secret');
    expect(row).toMatchObject({message: 'http request', source_time: '2026-11-16T08:00:00.123Z', level: 'INF', duration_ms: '1250', http_status: '200', path: '/api/issues/i/comments'});
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(parseMulticaLog('INFO private user prompt=please-do-something')).toBeUndefined();
    expect(parseMulticaLog('@multica-k8s-v1\t1970-01-01T00:00:01Z INF task completed task_id=t1')).toBeUndefined();
    expect(parseMulticaLog('2026-11-16T08:00:00Z {"msg":"task failed","error":"429 rate limit","task_id":"t1"}'))
      .toMatchObject({task_id: 't1', failure_reason: 'provider_capacity_or_rate_limit'});
  });
  it('preserves phase timing and file order for local daemon logs with a time-of-day prefix', async () => {
    const file = path.join(dir, 'daemon.log');
    const phase = '23:59:59.990 INF task phase recorded component=daemon task_id=task-1 runtime_id=runtime-1 task_phase=claimed phase_elapsed_ms=0 total_elapsed_ms=0\n';
    await writeFile(file, phase);
    const first = await collectLog(input, file, {});
    expect(first.records[0]).toMatchObject({record_type: 'server_log', task_id: 'task-1', runtime_id: 'runtime-1',
      phase: 'claimed', phase_elapsed_ms: '0', total_elapsed_ms: '0', entity_id: expect.stringMatching(/^\d+:\d+:0$/)});
    expect(first.records[0]).not.toHaveProperty('source_time');

    await appendFile(file, '00:00:00.015 INF task phase recorded component=daemon task_id=task-1 runtime_id=runtime-1 task_phase=environment_ready phase_elapsed_ms=25 total_elapsed_ms=25\n');
    const second = await collectLog(input, file, first.checkpoint ?? {});
    const fileIdentity = first.records[0].entity_id.split(':').slice(0, 2).join(':');
    expect(second.records).toEqual([expect.objectContaining({phase: 'environment_ready', phase_elapsed_ms: '25',
      total_elapsed_ms: '25', entity_id: `${fileIdentity}:${Buffer.byteLength(phase)}`})]);
    expect(second.records[0]).not.toHaveProperty('source_time');
  });

  it('retains native slow event handler timings from JSON without event payloads', () => {
    const row = parseMulticaLog(JSON.stringify({
      time: '2026-06-28T08:00:00Z', level: 'WARN', msg: 'slow global event handler',
      event_type: 'comment:created', handler_index: 0, duration_ms: 82,
      payload: {body: 'private-comment'}, token: 'private-token',
    }));
    expect(row).toMatchObject({record_type: 'server_log', source_type: 'log',
      message: 'slow global event handler', source_time: '2026-06-28T08:00:00Z', level: 'WARN',
      event_type: 'comment:created', handler_index: '0', duration_ms: '82'});
    expect(JSON.stringify(row)).not.toMatch(/private-comment|private-token/);
  });
  it('retains native slow publish totals from slog text without user content', () => {
    const row = parseMulticaLog('time=2026-06-28T08:00:00Z level=WARN msg="slow event publish" event_type=comment:created total_duration_ms=154 handler_count=3 payload="private-comment" prompt="private-prompt" token=private-token');
    expect(row).toMatchObject({record_type: 'server_log', source_type: 'log',
      message: 'slow event publish', source_time: '2026-06-28T08:00:00Z', level: 'WARN',
      event_type: 'comment:created', total_duration_ms: '154', handler_count: '3'});
    expect(JSON.stringify(row)).not.toMatch(/private-comment|private-prompt|private-token/);
    // Keep the event bus total separate from an individual handler duration.
    expect(row).not.toHaveProperty('duration_ms');
  });
  it('keeps redacted task errors while dropping prompt/result and distinguishes classification from evidence', () => {
    const row = snapshot('task_snapshot', {id: 't1', status: 'failed', error: '401 credential secret expired', prompt: 'sensitive', result: {secret: 'sensitive'}, created_at: '2026-11-16T00:00:00Z', started_at: '2026-11-16T00:00:02Z', completed_at: '2026-11-16T00:00:05Z', usage: [{input_tokens: 12, output_tokens: 3, cost_usd_ticks: 10000000000}]});
    expect(row).toMatchObject({task_id: 't1', failure_reason: 'provider_auth_or_access', queue_wait_ms: '2000', run_duration_ms: '3000', cost_usd: '1', total_tokens: '15'});
    expect(JSON.stringify(row)).not.toContain('sensitive');
    expect(row.error_message).toBe('401 credential secret expired');
    expect(snapshot('task_snapshot', {id: 't2'})).not.toHaveProperty('cost_usd');
  });
  it('never passes credential-shaped raw errors through as failure codes', () => {
    for (const secret of ['sk-examplecredential', 'mat_exampletoken', 'mpt_exampletoken']) {
      const api = snapshot('task_snapshot', {id: 't', error: secret});
      const log = parseMulticaLog(JSON.stringify({msg: 'task failed', error: secret}));
      const reason = snapshot('trigger_snapshot', {id: 'r', reason_code: secret});
      expect(api.failure_reason).toBe('unclassified');
      expect(log?.failure_reason).toBe('unclassified');
      expect(JSON.stringify([api, log, reason])).not.toContain(secret);
    }
    expect(snapshot('task_snapshot', {id: 't', failure_reason: 'agent_error.provider_capacity_or_rate_limit'}).failure_reason)
      .toBe('agent_error.provider_capacity_or_rate_limit');
    expect(snapshot('trigger_snapshot', {id: 'r', reason_code: 'quota_exceeded'}).failure_reason).toBe('quota_exceeded');
  });
  it('rejects credential-bearing URLs and unreasonable bounds', () => {
    expect(() => validateMulticaConfig({...input, MetricsUrls: ['https://host/metrics?token=x']})).toThrow();
    expect(() => validateMulticaConfig({...input, IntervalSeconds: 0})).toThrow();
  });
  it('rejects read chunks that cannot fit an allowed log line and its newline', async () => {
    for (const config of [{...input, MaxLogBytes: 1024}, {...input, MaxLogBytes: 1024, MaxLineBytes: 1024}]) {
      expect(() => validateMulticaConfig(config)).toThrow('MaxLogBytes must exceed MaxLineBytes');
      expect(() => pipeline(config)).toThrow('MaxLogBytes must exceed MaxLineBytes');
      await expect(collectLog(config, path.join(dir, 'unopened.log'), {})).rejects.toThrow('invalid_log_read_bounds');
    }
    expect(() => validateMulticaConfig({...input, MaxLogBytes: 1024, MaxLineBytes: 1023})).not.toThrow();
  });
  it('maps custom issue states and separates current age from completed wait time', () => {
    expect(snapshot('issue_status_snapshot', {id: 's1', key: 'qa_approval', category: 'in_review', name: 'private name'}))
      .toMatchObject({status: 'qa_approval', status_category: 'in_review'});
    const row = envelope(input, 'tasks', Date.parse('2026-11-16T00:00:05Z'), snapshot('task_snapshot', {id: 't1', status: 'queued', created_at: '2026-11-16T00:00:00Z'}));
    expect(row.queue_age_ms).toBe('5000');
    expect(row.queue_wait_ms).toBeUndefined();
  });
});

describe('bounded source reads', () => {
  it('advances past an oversized line across chunks and a checkpoint restart', async () => {
    const file = path.join(dir, 'chunked.log');
    const content = `${'x'.repeat(2000)}\nINFO comment created issue_id=after-long-line\n`;
    await writeFile(file, content);
    const config = {...input, MaxLogBytes: 1024, MaxLineBytes: 1023};
    validateMulticaConfig(config);
    let checkpoint = {};
    const records: MulticaRecord[] = [];
    for (let round = 0; round < 4; round++) {
      const result = await collectLog(config, file, checkpoint);
      records.push(...result.records);
      const previousOffset = (checkpoint as {offset?: number}).offset ?? 0;
      expect(result.checkpoint!.offset).toBeGreaterThanOrEqual(previousOffset);
      if (previousOffset < Buffer.byteLength(content)) expect(result.checkpoint!.offset).toBeGreaterThan(previousOffset);
      // A new process restores only the persisted checkpoint, with no partial-line buffer.
      checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    }
    expect(checkpoint).toMatchObject({offset: Buffer.byteLength(content), discardPartial: false});
    expect(records.filter(row => row.record_type === 'server_log')).toEqual([
      expect.objectContaining({issue_id: 'after-long-line', message: 'comment created'}),
    ]);
    expect(records.some(row => row.error_kind === 'oversized_log_line_skipped')).toBe(true);
  });
  it('uses documented header pagination and drops API content before returning', async () => {
    vi.stubEnv('MULTICA_TEST_TOKEN', 'fake-api-token');
    const cursors: string[] = [];
    const base = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer fake-api-token');
      expect(req.headers['x-workspace-id']).toBe('w1');
      const cursor = new URL(req.url!, 'http://local').searchParams.get('before') ?? ''; cursors.push(cursor);
      if (!cursor) res.setHeader('X-Agent-Tasks-Next-Cursor', 'next-page');
      res.end(JSON.stringify([{id: cursor ? 't2' : 't1', status: 'completed', prompt: 'secret', usage: [{input_tokens: 2}]}]));
    });
    const result = await collectApi({...input, ApiBase: base, TokenEnv: 'MULTICA_TEST_TOKEN'}, {name: 'tasks', workspace: 'w1', path: '/api/agents/a/tasks?include_usage=true', recordType: 'task_snapshot', pagination: 'cursor'});
    expect(cursors).toEqual(['', 'next-page']);
    expect(result.truncated).toBe(false);
    expect(result.records.map(r => r.task_id)).toEqual(['t1', 't2']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('reports incomplete pagination and rejects oversized responses and redirects', async () => {
    vi.stubEnv('MULTICA_TEST_TOKEN', 'fake');
    const base = await server((req, res) => {
      if (req.url === '/large') { res.end('x'.repeat(2000)); return; }
      if (req.url === '/redirect') { res.writeHead(302, {Location: '/large'}); res.end(); return; }
      res.setHeader('X-Agent-Tasks-Next-Cursor', 'more'); res.end('[{"id":"t"}]');
    });
    const cfg = {...input, ApiBase: base, TokenEnv: 'MULTICA_TEST_TOKEN', MaxPages: 1, MaxResponseBytes: 1024};
    expect((await collectApi(cfg, {name: 'tasks', workspace: 'w', path: '/tasks', recordType: 'task_snapshot', pagination: 'cursor'})).truncated).toBe(true);
    await expect(fetchBounded(`${base}/large`, cfg)).rejects.toThrow('response_too_large');
    await expect(fetchBounded(`${base}/redirect`, cfg, 'w')).rejects.toThrow('http_302');
  });
  it('stats a large file without parsing its contents and distinguishes missing', async () => {
    const file = path.join(dir, '.multica_issue.json');
    await writeFile(file, 'invalid-secret-json'.repeat(10000));
    const result = await collectFileStat(file);
    expect(result.records[0]).toMatchObject({exists: 'true', size_bytes: '190000'});
    expect(JSON.stringify(result)).not.toContain('invalid-secret');
    expect((await collectFileStat(`${file}.missing`)).records[0].exists).toBe('false');
  });
  it('uses stable usage dimensions when aggregate counts change', async () => {
    vi.stubEnv('MULTICA_TEST_TOKEN', 'fake');
    let count = 1;
    const base = await server((_req, res) => res.end(JSON.stringify([{date: '2026-11-16', agent_id: 'a1', provider: 'codex', model: 'm', input_tokens: count++}])));
    const cfg = {...input, ApiBase: base, TokenEnv: 'MULTICA_TEST_TOKEN'};
    const source = {name: 'usage', workspace: 'w', path: '/usage', recordType: 'usage_snapshot', extra: {report_type: 'usage/daily'}};
    const a = await collectApi(cfg, source); const b = await collectApi(cfg, source);
    expect(a.records[0].entity_id).toBe(b.records[0].entity_id);
    expect(a.records[0].input_tokens).not.toBe(b.records[0].input_tokens);
  });
  it('keeps each activity date as a distinct entity while its counts change', async () => {
    vi.stubEnv('MULTICA_TEST_TOKEN', 'fake');
    let count = 1;
    const base = await server((_req, res) => res.end(JSON.stringify([
      {bucket_at: '2026-11-15T00:00:00Z', agent_id: 'a1', task_count: count++},
      {bucket_at: '2026-11-16T00:00:00Z', agent_id: 'a1', task_count: count++},
    ])));
    const cfg = {...input, ApiBase: base, TokenEnv: 'MULTICA_TEST_TOKEN'};
    const source = {name: 'agent-activity-30d', workspace: 'w', path: '/activity', recordType: 'usage_snapshot'};
    const a = await collectApi(cfg, source); const b = await collectApi(cfg, source);
    expect(a.records[0].entity_id).not.toBe(a.records[1].entity_id);
    expect(a.records.map(row => row.day)).toEqual(['2026-11-15', '2026-11-16']);
    expect(a.records.map(row => row.entity_id)).toEqual(b.records.map(row => row.entity_id));
    expect(a.records[0].task_count).not.toBe(b.records[0].task_count);
  });
  it('preserves partial lines, handles rotation and bounds oversized lines', async () => {
    const file = path.join(dir, 'server.log');
    await writeFile(file, 'INFO http request status=200 duration=2ms\nINFO comment');
    const first = await collectLog(input, file, {});
    expect(first.records).toHaveLength(1);
    await appendFile(file, ' created issue_id=i1\n');
    const second = await collectLog(input, file, first.checkpoint!);
    expect(second.records[0]).toMatchObject({message: 'comment created', issue_id: 'i1'});
    await rename(file, `${file}.1`);
    await writeFile(file, `${'x'.repeat(1200)}\nINFO http request status=500\n`);
    const rotated = await collectLog({...input, MaxLineBytes: 256}, file, second.checkpoint!);
    expect(rotated.records.some(r => r.http_status === '500')).toBe(true);
    expect(rotated.records.some(r => r.error_kind === 'log_rotation_detected')).toBe(true);
    expect(JSON.stringify(rotated.records)).not.toContain('xxx');
  });
});

describe('Multica delivery and failure isolation', () => {
  it.each([
    {prefix: 'staging', instance: 'legacy', expected: 'staging'},
    {prefix: undefined, instance: 'legacy', expected: 'legacy'},
    {prefix: undefined, instance: undefined, expected: 'multica'},
  ])('reports the resolved Multica environment and legacy instance ($expected)', async ({prefix, instance, expected}) => {
    const cfg = {...input, Instance: instance, Environment: 'region-tag', StatFiles: [path.join(dir, 'missing')]};
    await pipeline(cfg, prefix).collectOnce();
    const [, records, options] = vi.mocked(postWebtracking).mock.calls[0];
    expect(options?.source).toBe(expected);
    expect(records.map(row => row.record_type)).toEqual(['file_stat', 'collection_status']);
    for (const row of records) {
      expect(row).toMatchObject({multica_env: expected, instance: expected, environment: 'region-tag'});
    }
  });
  it('preserves the source and event ID of a pre-upgrade batch after changing environments', async () => {
    const cfg = {...input, Instance: 'original', StatFiles: [path.join(dir, 'missing')]};
    vi.mocked(postWebtracking).mockRejectedValue(new Error('offline'));
    await pipeline(cfg).collectOnce();
    const spoolDir = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.multica-pending'))!);
    const [file] = await readdir(spoolDir);
    const spoolPath = path.join(spoolDir, file);
    const batch = JSON.parse(await readFile(spoolPath, 'utf8')) as {records: MulticaRecord[]};
    // Previously persisted envelopes have only the legacy instance field.
    for (const row of batch.records) delete row.multica_env;
    await writeFile(spoolPath, JSON.stringify(batch));

    vi.mocked(postWebtracking).mockClear().mockResolvedValue();
    const restarted = pipeline(cfg, 'new-environment');
    await restarted.collectOnce();
    await restarted.collectOnce();
    const [replay, fresh] = vi.mocked(postWebtracking).mock.calls;
    expect(replay[2]?.source).toBe('original');
    expect(replay[1]).toMatchObject(batch.records);
    expect(fresh[2]?.source).toBe('new-environment');
    expect(fresh[1][0]).toMatchObject({instance: 'new-environment', multica_env: 'new-environment'});
  });
  it('starts a configured Multica input through the normal PipelineManager', async () => {
    const configDir = path.join(dir, 'configs');
    await import('node:fs/promises').then(fs => fs.mkdir(configDir));
    await writeFile(path.join(configDir, 'multica.json'), JSON.stringify({configName: 'registered', inputs: [{...input, StatFiles: [path.join(dir, 'missing')]}], flushers: [{Type: 'flusher_sls', Endpoint: 'example.invalid', Project: 'p'}]}));
    const manager = new PipelineManager({configDir, stateDir: path.join(dir, 'state'), failedLogDir: path.join(dir, 'failed'), dataDir: dir, pipelineConfig: {enabled: true, file: {enabled: false}, qoderApi: {enabled: false}}});
    try {
      await manager.start();
      await vi.waitFor(() => expect(vi.mocked(postWebtracking).mock.calls.some(call => call[1].some(row => row.record_type === 'file_stat'))).toBe(true));
      expect(vi.mocked(postWebtracking).mock.calls[0][0]).toMatchObject({project: 'p', logstore: 'multica-logs'});
    } finally { await manager.stop(); }
  });
  it('starts before the first SLS ACK and drains that batch on stop', async () => {
    const file = path.join(dir, 'startup.log');
    const content = 'INFO comment created issue_id=startup\n';
    await writeFile(file, content);
    let acknowledge!: () => void;
    const ack = new Promise<void>(resolve => { acknowledge = resolve; });
    vi.mocked(postWebtracking).mockImplementation(() => ack);
    const p = pipeline({...input, LogFiles: [file]});
    let started = false;
    const starting = p.start().then(() => { started = true; });
    try {
      await vi.waitFor(() => expect(postWebtracking).toHaveBeenCalledTimes(1));
      expect(started).toBe(true);
      const pendingName = (await readdir(dir)).find(name => name.endsWith('.multica-pending'))!;
      const stateFile = path.join(dir, pendingName.replace(/-pending$/, '.json'));
      expect(await readFile(stateFile, 'utf8').catch(() => 'absent')).toBe('absent');
      let stopped = false;
      const stopping = p.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      acknowledge();
      await stopping;
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      expect(state[`log:${file}`].extra.checkpoint.offset).toBe(Buffer.byteLength(content));
      expect(await readdir(path.join(dir, pendingName))).toEqual([]);
    } finally { acknowledge(); await starting; await p.stop(); }
  });
  it('can stop before its scheduled first collection without making a request', async () => {
    const p = pipeline({...input, StatFiles: [path.join(dir, 'missing')]});
    await p.start();
    await p.stop();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(postWebtracking).not.toHaveBeenCalled();
  });
  it('handles a background cycle rejection and retries without abandoning lifecycle ownership', async () => {
    const p = pipeline({...input, IntervalSeconds: 1, StatFiles: [path.join(dir, 'missing')]});
    const collect = vi.spyOn(p, 'collectOnce').mockRejectedValueOnce(new Error('collection cycle unavailable'));
    try {
      await p.start();
      await vi.waitFor(() => expect(postWebtracking).toHaveBeenCalled(), {timeout: 2000});
      expect(collect).toHaveBeenCalledTimes(2);
    } finally { await p.stop(); }
  });
  it('replays the same sanitized event IDs after SLS failure and restart, advancing offsets only after ACK', async () => {
    const file = path.join(dir, 'server.log');
    await writeFile(file, 'INFO comment created issue_id=i1 token=secret\n');
    const cfg = {...input, LogFiles: [file], EvidenceKind: 'fixture' as const, TestCase: 'delivery-test'};
    vi.mocked(postWebtracking).mockRejectedValue(new Error('offline'));
    expect((await pipeline(cfg).collectOnce()).failedSources).toBe(1);
    expect((await readdir(dir)).filter(name => name.endsWith('.multica.json'))).toEqual([]);
    const failedRows = vi.mocked(postWebtracking).mock.calls[0][1];
    expect(vi.mocked(postWebtracking).mock.calls[0][0].endpoint).toBe('https://example.invalid');
    expect(JSON.stringify(failedRows)).not.toContain('secret');
    vi.mocked(postWebtracking).mockClear().mockResolvedValue();
    const restarted = pipeline(cfg);
    await restarted.collectOnce();
    expect(vi.mocked(postWebtracking).mock.calls[0][1]).toEqual(failedRows);
    expect(failedRows[0]).toMatchObject({evidence_kind: 'fixture', test_case: 'delivery-test'});
    const stateFile = (await readdir(dir)).find(name => name.endsWith('.multica.json'))!;
    const state = JSON.parse(await readFile(path.join(dir, stateFile), 'utf8'));
    expect(state[`log:${file}`].extra.checkpoint.offset).toBe(Buffer.byteLength('INFO comment created issue_id=i1 token=secret\n'));
    expect(await readdir(path.join(dir, stateFile.replace(/\.json$/, '-pending')))).toEqual([]);
    vi.mocked(postWebtracking).mockClear();
    await restarted.collectOnce();
    const rows = vi.mocked(postWebtracking).mock.calls.flatMap(call => call[1]);
    expect(rows.filter(r => r.record_type === 'server_log')).toHaveLength(0);
  });
  it('continues other sources after one endpoint fails and emits its coverage gap', async () => {
    const base = await server((_req, res) => {res.statusCode = 503; res.end('private error response');});
    const result = await pipeline({...input, MetricsUrls: [`${base}/metrics`], StatFiles: [path.join(dir, 'missing')]}).collectOnce();
    expect(result).toMatchObject({successfulSources: 1, failedSources: 1, collectionEnabled: true});
    const rows: MulticaRecord[] = vi.mocked(postWebtracking).mock.calls.flatMap(call => call[1]);
    expect(rows.some(row => row.error_kind === 'http_503')).toBe(true);
    expect(rows.some(row => row.record_type === 'file_stat')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('private error');
  });
});
