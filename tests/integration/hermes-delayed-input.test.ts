import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { contentHash } from '../../src/utils/content-hash.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const driver = String.raw`
import importlib.util, json, pathlib, sys, types
plugin, fixture, root, stage, initial = sys.argv[1:]
spec = importlib.util.spec_from_file_location('pilot', plugin)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
events = [json.loads(line) for line in pathlib.Path(fixture).read_text().splitlines()]
full = next(e['payload']['conversation_history'] for e in events if e['hook'] == 'post_llm_call')
prior = [dict(role='user', content='Previous prompt'), dict(role='assistant', content='Previous answer')]
def read():
    return [json.loads(line) for f in pathlib.Path(root).glob('logs/hermes-agent/*.jsonl') for line in f.read_text().splitlines()]
clock = p.time.time_ns()
batches, seen = [], 0
for e in events:
    payload = dict(e['payload'])
    if e['hook'] == 'pre_llm_call':
        payload['user_message'] = ''
        payload['conversation_history'] = []
        if initial == 'missing': payload.pop('conversation_history')
    if e['hook'] == 'post_api_request':
        assistant = [m for m in full if m['role'] == 'assistant'][payload['api_call_count'] - 1]
        payload['response'] = dict(assistant_message=assistant)
    boundary = (stage == 'request' and e['hook'] == 'pre_api_request' and payload.get('api_call_count') == 2) or (stage == 'terminal' and e['hook'] == 'post_llm_call')
    if boundary:
        assert not read(), 'request/response/tool escaped before input was known'
    if e['hook'] == 'pre_api_request' and payload.get('api_call_count') == 2 and stage == 'request':
        payload['conversation_history'] = prior + full[:-1]
    if e['hook'] == 'post_llm_call': payload['conversation_history'] = prior + full
    # One poll every 15 source seconds, including after request, response and tool.
    clock += 15_000_000_000
    p.time.time_ns = lambda: clock
    hooks[e['hook']](**payload)
    records = read()
    batches.append(records[seen:])
    seen = len(records)
pathlib.Path(root, 'batches.json').write_text(json.dumps(batches))
`;

it.each([
  { stage: 'request', initial: 'empty' }, { stage: 'request', initial: 'missing' },
  { stage: 'terminal', initial: 'empty' }, { stage: 'terminal', initial: 'missing' },
])('exports every span under upstream after delayed $stage input ($initial history)', async ({ stage, initial }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-delayed-'));
  roots.push(root);
  const producer = path.join(root, 'producer'), sessionDir = path.join(root, 'collector'), correlate = path.join(root, 'correlate');
  await fs.mkdir(sessionDir); await fs.mkdir(correlate);
  const fixturePath = path.resolve('tests/fixtures/hermes-agent/real-tool-turn-hooks.jsonl');
  const fixture = (await fs.readFile(fixturePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const prompt = fixture.find(e => e.hook === 'pre_llm_call').payload.user_message;
  const session = 'fixture-session-001', traceId = '1'.repeat(32), parent = '2'.repeat(16);
  await fs.writeFile(path.join(correlate, `${session}.jsonl`), JSON.stringify({
    type: 'turn', contentHash: contentHash(prompt), traceparent: `00-${traceId}-${parent}-01`,
  }) + '\n');
  const run = spawnSync('python3', ['-c', driver, path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py'), fixturePath, producer, stage, initial], {
    encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: producer, PYTHONDONTWRITEBYTECODE: '1',
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '', LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_USER_ID: '' },
  });
  expect(run.status, run.stderr || String(run.signal)).toBe(0);
  const batches: Record<string, any>[][] = JSON.parse(await fs.readFile(path.join(producer, 'batches.json'), 'utf8'));
  const source = batches.flat();
  expect(source[0]['agent.hermes.hook']).toBe('turn_start');
  expect(source[0]['agent.pilot.correlation.content_hash']).toBe(contentHash(prompt));
  expect(source.filter(r => r['agent.hermes.hook'] === 'turn_start')).toHaveLength(1);
  const spans: ReadableSpan[] = [];
  const otlp = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'delayed-input',
    endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }] }, undefined,
  () => ({ export(batch, cb) { spans.push(...batch); cb({ code: 0 }); }, shutdown: async () => {} }));
  const capture = new MockFlusher(), manager = new InputManager();
  manager.setFlusher(new MultiFlusher([capture, otlp]));
  manager.setTraceLinker(new TraceLinker(new CorrelationStore(correlate), { retries: 0 }));
  const input = new HermesLogInput({ stateStore: new MockStateStore() as any, sessionDir, pollIntervalMs: 60_000 });
  manager.registerInput(input);
  try {
    for (const batch of batches) {
      await fs.appendFile(path.join(sessionDir, 'hermes-agent-delayed.jsonl'), batch.map(r => JSON.stringify(r) + '\n').join(''));
      await manager.startInput(input.id); await manager.stopInput(input.id);
    }
    const canonical = capture.batchCalls.flat();
    expect(canonical.every(r => r.trace_id === traceId)).toBe(true);
    expect(new Set(canonical.map(r => r['event.id'])).size).toBe(canonical.length);
    expect(spans).toHaveLength(7); // ENTRY, AGENT, two STEP/LLM pairs, TOOL
    expect(spans.every(s => s.spanContext().traceId === traceId)).toBe(true);
    expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')?.parentSpanId).toBe(parent);
    const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms.map(s => [s.attributes['gen_ai.usage.input_tokens'], s.attributes['gen_ai.usage.output_tokens']])).toEqual([[1711, 31], [1794, 36]]);
    const agent = spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(3505);
    expect(agent.attributes['gen_ai.usage.output_tokens']).toBe(67);
    // Staging preserves the original source request identities and timestamps.
    for (const request of source.filter(r => r['event.name'] === 'llm.request')) {
      const span = llms.find(s => s.spanContext().spanId === request.span_id)!;
      expect(span).toBeDefined();
      const start = BigInt(span.startTime[0]) * 1_000_000_000n + BigInt(span.startTime[1]);
      expect(canonical.find(r => r['event.id'] === request['event.id'])?.time_unix_nano).toBe(request.time_unix_nano);
      const difference = start - BigInt(request.time_unix_nano);
      expect(difference < 1_000_000n && difference > -1_000_000n).toBe(true);
    }
  } finally { await manager.stopInput(input.id); await otlp.shutdown(); }
});
