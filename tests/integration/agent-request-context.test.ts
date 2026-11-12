import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { InputManager } from '../../src/core/input-manager.js';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { MockStateStore } from '../helpers/mock-state-store.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  (globalThis as any)[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function pilotRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-request-context-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'config.json'), '{}');
  return root;
}

async function recordsIn(root: string, agent: string): Promise<EventLogRecord[]> {
  const dir = path.join(root, 'logs', agent);
  const files = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  return (await Promise.all(files.map(name => fs.readFile(path.join(dir, name), 'utf8'))))
    .join('\n').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function llmSpans(records: EventLogRecord[]) {
  vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental');
  vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'SPAN_ONLY');
  const converted = await convertEventLogToReadableSpans(records, { strict: false });
  expect(converted.warnings).toEqual([]);
  return converted.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
}

it('preserves resumed OpenClaw history and assistant/tool inputs in every converted step', async () => {
  const root = await pilotRoot();
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
  const pluginPath = process.env.PILOT_OPENCLAW_TEST_PLUGIN || path.resolve('assets/plugins/openclaw/plugin.mjs');
  const plugin = (await import(`${pluginPath}?request-context=${Date.now()}`)).default;
  const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
  plugin.register({ runtime: { version: '2026.6.5' }, on(name: string, handler: any) { handlers[name] = handler; } });
  const ctx = { runId: 'context-run', sessionId: 'context-session', sessionKey: 'agent:main:context' };
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'previous question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
  ];
  await handlers.llm_input({ ...ctx, systemPrompt: 'system-rule', prompt: 'current question', tools: [
    { name: 'read', parameters: { type: 'object' } },
  ], historyMessages: history }, ctx);
  history[1].content[0].text = 'mutated after input boundary';
  await handlers.model_call_started({ ...ctx, callId: 'native-1', provider: 'test', model: 'fixture-model' }, ctx);
  await handlers.before_message_write({ message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'fixture-call', name: 'read', arguments: { path: 'fixture.txt' } },
  ], stopReason: 'toolUse', usage: { input: 100, output: 2 } } }, ctx);
  await handlers.model_call_ended({ ...ctx, callId: 'native-1' }, ctx);
  await handlers.tool_result_persist({ toolCallId: 'fixture-call', message: {
    role: 'toolResult', toolCallId: 'fixture-call', content: [{ type: 'text', text: 'file contents' }],
  } }, ctx);
  await handlers.model_call_started({ ...ctx, callId: 'native-2', provider: 'test', model: 'fixture-model' }, ctx);
  await handlers.before_message_write({ message: { role: 'assistant', content: [
    { type: 'text', text: 'current answer' },
  ], stopReason: 'stop', usage: { input: 120, output: 3 } } }, ctx);
  await handlers.model_call_ended({ ...ctx, callId: 'native-2' }, ctx);
  await handlers.llm_output({ ...ctx }, ctx);
  const records = await recordsIn(root, 'openclaw');
  const spans = await llmSpans(records);
  expect(spans).toHaveLength(2);
  const inputs = spans.map(span => JSON.parse(String(span.attributes['gen_ai.input.messages'])));
  for (const messages of inputs) {
    expect(JSON.stringify(messages)).toContain('previous question');
    expect(JSON.stringify(messages)).toContain('previous answer');
    expect(JSON.stringify(messages)).toContain('current question');
    expect(JSON.stringify(messages)).not.toContain('mutated after input boundary');
  }
  expect(inputs[1].slice(-2).map((message: any) => message.role)).toEqual(['assistant', 'tool']);
  expect(inputs[1].at(-2).parts[0]).toMatchObject({ type: 'tool_call', id: 'fixture-call' });
  expect(inputs[1].at(-1).parts[0]).toMatchObject({ type: 'tool_call_response', id: 'fixture-call' });
  // Metadata is inherited by the converter; it need not be repeated on each raw request.
  expect(spans.every(span => String(span.attributes['gen_ai.system_instructions']).includes('system-rule'))).toBe(true);
  expect(spans.every(span => String(span.attributes['gen_ai.tool.definitions']).includes('read'))).toBe(true);
});

async function hermesRecords(history: any[], nativeMessages?: any[], request?: any) {
  const root = await pilotRoot();
  const plugin = process.env.PILOT_HERMES_TEST_PLUGIN || path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
  const events = [
    { hook: 'pre_llm_call', payload: { session_id: 'hermes-context', user_message: 'current question', conversation_history: history } },
    { hook: 'pre_api_request', payload: { session_id: 'hermes-context', task_id: 'context-task', api_call_count: 1,
      model: 'fixture-model', provider: 'openai', api_mode: 'chat_completions',
      conversation_history: history, request_messages: nativeMessages, request } },
    { hook: 'post_api_request', payload: { session_id: 'hermes-context', task_id: 'context-task', api_call_count: 1,
      model: 'fixture-model', provider: 'openai', finish_reason: 'stop', usage: { input_tokens: 100, output_tokens: 2 },
      assistant_message: { role: 'assistant', content: 'current answer' } } },
    { hook: 'post_llm_call', payload: { session_id: 'hermes-context', user_message: 'current question',
      assistant_response: 'current answer', conversation_history: [...history, { role: 'assistant', content: 'current answer' }] } },
  ];
  const run = spawnSync('python3', ['-c', `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('pilot_context', os.environ['PILOT_CONTEXT_PLUGIN_PATH'])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
class Context:
    hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Context()
plugin.register(ctx)
for event in json.load(sys.stdin): ctx.hooks[event['hook']](**event['payload'])
`], { env: { ...process.env, PILOT_CONTEXT_PLUGIN_PATH: plugin,
    LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' },
    input: JSON.stringify(events), encoding: 'utf8' });
  expect(run.status, run.error?.message || run.stderr || run.signal || '').toBe(0);
  return recordsIn(root, 'hermes-agent');
}

it('preserves Hermes cross-turn history without expanding the current-turn lifecycle window', async () => {
  const history = [
    { role: 'user', content: 'previous question' }, { role: 'assistant', content: 'previous answer' },
    { role: 'user', content: 'current question' },
  ];
  const records = await hermesRecords(history);
  const spans = await llmSpans(records);
  expect(spans).toHaveLength(1);
  const input = JSON.parse(String(spans[0].attributes['gen_ai.input.messages']));
  expect(input.map((message: any) => message.role)).toEqual(['user', 'assistant', 'user']);
  expect(JSON.stringify(input)).toContain('previous answer');
  const response = records.find(record => record['event.name'] === 'llm.response');
  expect(JSON.stringify(response?.['gen_ai.output.messages'])).toContain('current answer');
  expect(JSON.stringify(response?.['gen_ai.output.messages'])).not.toContain('previous answer');
});

it('uses Hermes native request messages when the sanitized body is absent', async () => {
  const history = [{ role: 'user', content: 'current question' }];
  const native = [
    { role: 'system', content: 'uncapped system rule' },
    { role: 'user', content: 'actual provider input' },
  ];
  const records = await hermesRecords(history, native, { _truncated: true, preview: 'incomplete JSON' });
  const request = records.find(record => record['event.name'] === 'llm.request')!;
  expect(request['gen_ai.system_instructions']).toEqual([{ type: 'text', content: 'uncapped system rule' }]);
  expect(JSON.stringify(request['gen_ai.input.messages'])).toContain('actual provider input');
  expect(JSON.stringify(request['gen_ai.input.messages'])).not.toContain('current question');
});

it('retains Hermes request history beyond the lifecycle message and text limits', async () => {
  const history = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `history-${index}`,
  }));
  history.push({ role: 'user', content: 'x'.repeat(40_000) + 'current question' });
  const records = await hermesRecords(history);
  const request = records.find(record => record['event.name'] === 'llm.request')!;
  expect(request['gen_ai.input.messages']).toHaveLength(81);
  expect(JSON.stringify(request['gen_ai.input.messages'])).toContain('history-0');
  expect(JSON.stringify(request['gen_ai.input.messages'])).toContain('current question');
  expect(request['agent.pilot.request_context.truncated']).toBeUndefined();
});

it('keeps normalized Hermes tool history when the native API uses provider-specific blocks', async () => {
  const history = [
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'native-tool', type: 'function',
      function: { name: 'read', arguments: { path: 'fixture.txt' } } }] },
    { role: 'tool', tool_call_id: 'native-tool', content: 'observed result' },
  ];
  const records = await hermesRecords(history, [{ role: 'assistant', content: [
    { type: 'tool_use', id: 'native-tool', name: 'read', input: { path: 'fixture.txt' } },
  ] }]);
  const request = records.find(record => record['event.name'] === 'llm.request')!;
  expect(request['gen_ai.input.messages']).toMatchObject([
    { role: 'user' }, { role: 'assistant', parts: [{ type: 'tool_call', id: 'native-tool' }] },
    { role: 'tool', parts: [{ type: 'tool_call_response', id: 'native-tool' }] },
  ]);
});

it('bounds large request captures and carries the truncation diagnostic into exported spans', async () => {
  const history = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `history-${index} ` + 'x'.repeat(40_000),
  }));
  history.push({ role: 'user', content: 'current question' });
  const records = await hermesRecords(history);
  const request = records.find(record => record['event.name'] === 'llm.request')!;
  expect(request['agent.pilot.request_context.truncated']).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(request['gen_ai.input.messages']))).toBeLessThan(2 * 1024 * 1024);
  expect(JSON.stringify(request['gen_ai.input.messages'])).toContain('current question');
  const spans: any[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf', serviceName: 'request-context-bounds' }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, async shutdown() {},
  }));
  try { await flusher.sendBatch(records as any); } finally { await flusher.shutdown(); }
  expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')?.attributes['agent.pilot.request_context.truncated']).toBe(true);
});

it('masks newly captured history, system instructions and tools through the actual input path', async () => {
  const secret = 'sk-' + '1234567890abcdefghijklmnop';
  const history = [{ role: 'user', content: `previous ${secret}` },
    { role: 'assistant', content: 'previous answer' }, { role: 'user', content: 'current question' }];
  const records = await hermesRecords(history, [{ role: 'system', content: `system ${secret}` }, ...history], {
    body: { tools: [{ type: 'function', function: { name: 'fixture', description: `tool ${secret}`, parameters: {} } }] },
  });
  const root = await pilotRoot();
  const logDir = path.join(root, 'logs');
  await fs.mkdir(logDir);
  await fs.writeFile(path.join(logDir, 'hermes-agent-fixture.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const input = new HermesLogInput({ stateStore: new MockStateStore() as any, sessionDir: logDir, pollIntervalMs: 60_000 });
  const manager = new InputManager();
  const sink = new MockFlusher();
  manager.setFlusher(sink); manager.setMaskConfig({ mode: 'all', types: [], replacementMode: 'placeholder' });
  manager.registerInput(input);
  try { await manager.startInput(input.id); } finally { await manager.stopInput(input.id); }
  const captured = sink.batchCalls.flat();
  expect(captured.length).toBeGreaterThan(0);
  expect(JSON.stringify(captured)).not.toContain(secret);
  expect(JSON.stringify(captured)).toContain('[APIKEY_MASKED]');
  const spans = await llmSpans(captured.filter(record => record['event.name'] !== 'agent.input') as EventLogRecord[]);
  expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(secret);
  expect(JSON.stringify(spans.map(span => span.attributes))).toContain('[APIKEY_MASKED]');
});

it.each([false, true])('captures Hermes metadata before the host cap without changing its result (worker=%s)', async worker => {
  const root = await pilotRoot();
  const plugin = process.env.PILOT_HERMES_TEST_PLUGIN || path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');
  const run = spawnSync('python3', ['-c', `
import contextvars, importlib.util, json, os, sys, types
from concurrent.futures import ThreadPoolExecutor
class Agent:
    session_id = 'metadata-session'
    calls = 0
    result = {'_truncated': True, 'preview': 'incomplete JSON'}
    failure = None
    def _api_request_payload_for_hook(self, api_kwargs):
        self.calls += 1
        if self.failure: raise self.failure
        return self.result
sys.modules['run_agent'] = types.SimpleNamespace(AIAgent=Agent)
spec = importlib.util.spec_from_file_location('pilot_metadata', os.environ['PILOT_CONTEXT_PLUGIN_PATH'])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
class Context:
    hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Context()
plugin.register(ctx)
agent = Agent()
body = {'messages': [{'role': 'system', 'content': 'native system'}, {'role': 'user', 'content': 'question'}],
        'tools': [{'type': 'function', 'function': {'name': 'fixture_' + str(i),
                   'description': 'x' * 1500, 'parameters': {'type': 'object'}}} for i in range(32)]}
request = agent._api_request_payload_for_hook(body)
assert request is agent.result and agent.calls == 1
# Metadata is captured at the boundary, independent of subsequent mutations.
body['tools'][0]['function']['name'] = 'mutated-after-boundary'
payload = dict(session_id=agent.session_id, task_id='fixture-task', api_call_count=1,
               model='fixture-model', provider='openai', request=request,
               conversation_history=[{'role': 'user', 'content': 'question'}])
if sys.argv[1] == 'true':
    copied = contextvars.copy_context()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(copied.run, lambda: ctx.hooks['pre_api_request'](**payload)).result()
else:
    ctx.hooks['pre_api_request'](**payload)
assert plugin._take_request_metadata(payload) == {}, 'snapshot consumed across copied contexts'
agent._api_request_payload_for_hook(body)
assert plugin._take_request_metadata(dict(payload, request=dict(request))) == {}, 'request identity'
assert plugin._take_request_metadata(dict(payload, session_id='other-session')) == {}, 'session isolation'
plugin._REQUEST_METADATA.get()['created'] -= 6
assert plugin._take_request_metadata(payload) == {}, 'expiry'
failure = RuntimeError('native failure')
agent.failure = failure
try: agent._api_request_payload_for_hook(body)
except RuntimeError as actual: assert actual is failure
else: raise AssertionError('native exception swallowed')
assert agent.calls == 3
`, String(worker)], { env: { ...process.env, PILOT_CONTEXT_PLUGIN_PATH: plugin,
    LOONGSUITE_PILOT_DATA_DIR: root, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8' });
  expect(run.status, run.error?.message || run.stderr || run.signal || '').toBe(0);
  const records = await recordsIn(root, 'hermes-agent');
  const request = records.find(record => record['event.name'] === 'llm.request')!;
  expect(request['gen_ai.tool.definitions']).toHaveLength(32);
  expect(request['gen_ai.tool.definitions']?.[0]).toMatchObject({ name: 'fixture_0' });
  expect(request['gen_ai.system_instructions']).toEqual([{ type: 'text', content: 'native system' }]);
  expect(request['agent.pilot.request_context.truncated']).toBeUndefined();
});
