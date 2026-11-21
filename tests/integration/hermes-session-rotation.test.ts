import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const directories: string[] = [];
const flushers: OtlpTraceFlusher[] = [];
const plugin = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');

async function fixture(journaled: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-rotation-'));
  directories.push(dir);
  const spans: ReadableSpan[] = [];
  const journal = journaled ? new CodexTurnJournal(dir, 100, ['hermes']) : undefined;
  const flusher = new OtlpTraceFlusher({
    enabled: true, protocol: 'http/protobuf', serviceName: 'hermes-rotation-test',
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
  }, undefined, () => ({
    export(batch, done) { spans.push(...batch); done({ code: 0 }); },
    async shutdown() {},
  }), journal);
  flushers.push(flusher);
  return { dir, spans, flusher, journal };
}

function legacyRows(session: string, trace: string): AgentActivityEntry[] {
  const common = {
    'user.id': 'synthetic-user', 'gen_ai.agent.type': 'hermes',
    'agent.hermes.collection': 'realtime-v1', 'gen_ai.session.id': session,
    'gen_ai.turn.id': 'shared-native-turn', trace_id: trace,
    'gen_ai.provider.name': 'test', 'gen_ai.request.model': 'synthetic-model',
  };
  const span = session === 'old' ? '11'.repeat(8) : '22'.repeat(8);
  return [
    { ...common, 'event.name': 'llm.request', 'event.id': `${session}-request`,
      'gen_ai.step.id': 'shared-native-turn:s1', 'gen_ai.response.id': 'shared-native-turn:s1:r',
      span_id: span, time_unix_nano: '1794900000000000000',
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: session }] }] },
    { ...common, 'event.name': 'llm.response', 'event.id': `${session}-response`,
      'gen_ai.step.id': 'shared-native-turn:s1', 'gen_ai.response.id': 'shared-native-turn:s1:r',
      span_id: span, time_unix_nano: '1794900001000000000',
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: session }] }],
      'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 },
    { ...common, 'event.name': 'other', 'event.id': `${session}-end`,
      time_unix_nano: '1794900002000000000', 'gen_ai.turn.end': true },
  ] as AgentActivityEntry[];
}

afterEach(async () => {
  for (const flusher of flushers.splice(0)) await flusher.shutdown();
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('Hermes session rotation', () => {
  it('keeps the native turn ID and separates session request/response identities', async () => {
    const { dir, flusher, spans } = await fixture(false);
    const driver = String.raw`
import importlib.util, json, pathlib, sys, types
runtime = types.ModuleType('run_agent')
class Agent:
    session_id = 'old-session'
    def run_conversation(self, behavior): return behavior(self)
runtime.AIAgent = Agent
sys.modules['run_agent'] = runtime
sys.modules['agent.conversation_loop'] = None
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
native = 'old-session:task:turn'
def call(agent, i):
    data = dict(session_id=agent.session_id, task_id='task', turn_id=native, model='model',
                provider='test', user_message='hello', api_call_count=i,
                api_request_id=agent.session_id + str(i))
    hooks['pre_api_request'](**data)
    hooks['post_api_request'](**data, finish_reason='stop',
        usage=dict(input_tokens=10, output_tokens=2),
        response=dict(assistant_message=dict(role='assistant', content='answer')))
def business(agent):
    hooks['pre_llm_call'](session_id=agent.session_id, task_id='task', turn_id=native,
                          user_message='hello', model='model')
    call(agent, 1); call(agent, 2)
    agent.session_id = 'new-session'
    call(agent, 1); call(agent, 2)
Agent().run_conversation(business)
rows = [json.loads(line) for f in pathlib.Path(sys.argv[2]).glob('logs/hermes-agent/*.jsonl')
        for line in f.read_text().splitlines()]
print(json.dumps(rows))
`;
    const run = spawnSync('python3', ['-c', driver, plugin, dir], {
      encoding: 'utf8', env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dir,
        LOONGSUITE_PILOT_USER_ID: '', LOONGSUITE_USER_ID: '', PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(run.status, run.stderr).toBe(0);
    const rows = JSON.parse(run.stdout) as AgentActivityEntry[];
    const requests = rows.filter(row => row['event.name'] === 'llm.request');
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map(row => row['gen_ai.turn.id']))).toEqual(new Set(['old-session:task:turn']));
    expect(new Set(requests.map(row => row['gen_ai.session.id'])).size).toBe(2);
    expect(new Set(requests.map(row => row['gen_ai.response.id'])).size).toBe(4);
    expect(rows.filter(row => row['gen_ai.turn.end'] === true)).toHaveLength(2);
    const input = new HermesLogInput({ stateStore: new MockStateStore() as any,
      sessionDir: path.join(dir, 'logs/hermes-agent'), pollIntervalMs: 60_000 });
    const collected = new MockFlusher();
    const manager = new InputManager();
    manager.setAgentsConfig({ [ClientType.Hermes]: { captureMessageContent: true } });
    manager.setFlusher(collected);
    manager.registerInput(input);
    await manager.startInput(input.id);
    await manager.stopInput(input.id);
    const normalized = collected.batchCalls.flat();
    expect(normalized.filter(row => row['event.name'] === 'llm.request')).toHaveLength(4);
    await flusher.sendBatch(normalized);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(4);
    expect(new Set(llms.map(span => span.spanContext().traceId)).size).toBe(2);
    expect(new Set(llms.map(span => span.spanContext().spanId))).toEqual(new Set(requests.map(row => row.span_id)));
    expect(llms.every(span => span.attributes['gen_ai.usage.input_tokens'] === 10)).toBe(true);
  });

  it.each([false, true])('isolates legacy events by session, journaled=%s', async journaled => {
    const { flusher, spans, journal } = await fixture(journaled);
    const old = legacyRows('old', 'aa'.repeat(16));
    const rotated = legacyRows('new', 'bb'.repeat(16));
    await flusher.sendBatch([...old.slice(0, 2), ...rotated.slice(0, 2)]);
    await flusher.sendBatch([old[2]]);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    await flusher.sendBatch([rotated[2]]);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(2);
    expect(new Set(llms.map(span => span.spanContext().traceId))).toEqual(new Set(['aa'.repeat(16), 'bb'.repeat(16)]));
    expect(new Set(llms.map(span => span.spanContext().spanId))).toEqual(new Set(['11'.repeat(8), '22'.repeat(8)]));
    expect(llms.every(span => span.attributes['gen_ai.usage.input_tokens'] === 10)).toBe(true);
    if (journal) {
      expect(await journal.isAcknowledged(old[0])).toBe(true);
      expect(await journal.isAcknowledged(rotated[0])).toBe(true);
    }
  });

  it('replays two legacy sessions independently after a collector restart', async () => {
    const { dir, flusher } = await fixture(true);
    const old = legacyRows('old', 'aa'.repeat(16));
    const rotated = legacyRows('new', 'bb'.repeat(16));
    await flusher.sendBatch([...old.slice(0, 2), ...rotated.slice(0, 2)]);
    await flusher.shutdown();
    flushers.splice(flushers.indexOf(flusher), 1);
    const spans: ReadableSpan[] = [];
    const journal = new CodexTurnJournal(dir, 100, ['hermes']);
    const restarted = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf',
      serviceName: 'hermes-rotation-test', endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    }, undefined, () => ({ export(batch, done) { spans.push(...batch); done({ code: 0 }); },
      async shutdown() {} }), journal);
    flushers.push(restarted);
    await restarted.start();
    await restarted.sendBatch([old[2]]);
    expect(await journal.isAcknowledged(old[0])).toBe(true);
    expect(await journal.isAcknowledged(rotated[0])).toBe(false);
    await restarted.sendBatch([rotated[2]]);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(new Set(llms.map(span => span.spanContext().traceId))).toEqual(new Set(['aa'.repeat(16), 'bb'.repeat(16)]));
    expect(new Set(llms.map(span => span.spanContext().spanId))).toEqual(new Set(['11'.repeat(8), '22'.repeat(8)]));
    expect(await journal.isAcknowledged(rotated[0])).toBe(true);
  });

  it.each([false, true])('isolates two users who reuse a session and turn, journaled=%s', async journaled => {
    const { flusher, spans, journal } = await fixture(journaled);
    const first = legacyRows('same-session', 'aa'.repeat(16));
    const second = legacyRows('same-session', 'bb'.repeat(16)).map((row) => ({
      ...row, 'user.id': 'another-user', 'event.id': `${row['event.id']}-other`,
      ...(row.span_id ? { span_id: '33'.repeat(8) } : {}),
    })) as AgentActivityEntry[];
    await flusher.sendBatch([...first.slice(0, 2), ...second.slice(0, 2)]);
    await flusher.sendBatch([first[2]]);
    const firstLlms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(firstLlms.map(span => span.spanContext().traceId)).toEqual(['aa'.repeat(16)]);
    if (journal) {
      expect(await journal.isAcknowledged(first[0])).toBe(true);
      expect(await journal.isAcknowledged(second[0])).toBe(false);
    }
    await flusher.sendBatch([second[2]]);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(new Set(llms.map(span => span.spanContext().traceId))).toEqual(new Set(['aa'.repeat(16), 'bb'.repeat(16)]));
    expect(llms.every(span => span.attributes['gen_ai.usage.input_tokens'] === 10)).toBe(true);
    if (journal) expect(await journal.isAcknowledged(second[0])).toBe(true);
  });

  it('retains distinct spans when rotated sessions share an explicit upstream trace', async () => {
    const { flusher, spans } = await fixture(true);
    const upstream = 'dd'.repeat(16);
    const parent = 'ee'.repeat(8);
    const first = legacyRows('old', upstream).map(row => ({ ...row, parent_span_id: parent })) as AgentActivityEntry[];
    const second = legacyRows('new', upstream).map(row => ({ ...row, parent_span_id: parent })) as AgentActivityEntry[];
    await flusher.sendBatch([...first.slice(0, 2), ...second.slice(0, 2), first[2], second[2]]);
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(2);
    expect(new Set(llms.map(span => span.spanContext().traceId))).toEqual(new Set([upstream]));
    expect(new Set(spans.map(span => span.spanContext().spanId)).size).toBe(spans.length);
    expect(llms.every(span => span.attributes['gen_ai.usage.input_tokens'] === 10)).toBe(true);
  });
});
