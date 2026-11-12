import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { expandAgentInputEvents } from '../../src/normalization/agent-input-dual-write.js';
import { InputManager } from '../../src/core/input-manager.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../src/inputs/codex-transcript/codex-transcript-input.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { HttpFlusher } from '../../src/flushers/http-flusher.js';
import { SlsFlusher } from '../../src/flushers/sls-flusher.js';
import { ClientType, type AgentActivityEntry, type AgentEventName, type SlsFlusherConfig } from '../../src/types/index.js';

// Exercise the real flusher's serialization and SDK boundary without cloud credentials.
const { postLogs } = vi.hoisted(() => ({ postLogs: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@alicloud/log', () => ({
  default: vi.fn().mockImplementation(() => ({ postLogStoreLogs: postLogs })),
}));

const names: AgentEventName[] = [
  'llm.request', 'llm.response', 'tool.call', 'tool.result',
  'gen_ai.model.request', 'gen_ai.model.response', 'gen_ai.tool.call', 'gen_ai.tool.result',
  'gen_ai.agent.invoke', 'gen_ai.agent.result',
];
const traceId = 'a'.repeat(32);
const spanId = 'b'.repeat(16);
const parentSpanId = 'c'.repeat(16);
const relationFields = {
  'gen_ai.session.id': 'child-session',
  'gen_ai.turn.id': 'child-turn',
  'gen_ai.step.id': 'child-step',
  'gen_ai.agent.id': 'child-agent',
  'gen_ai.agent.parent.id': 'parent-agent',
  'gen_ai.agent.peer.id': 'grandchild-agent',
  'gen_ai.agent.peer.name': 'Grandchild',
  'gen_ai.agent.invocation.id': 'outgoing-work',
  'gen_ai.agent.parent.invocation.id': 'incoming-work',
  'gen_ai.tool.call.id': 'native-tool-call',
  trace_id: traceId,
  span_id: spanId,
  parent_span_id: parentSpanId,
};
const contentFields = [
  'gen_ai.input.messages', 'gen_ai.input.messages_delta', 'gen_ai.output.messages',
  'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
  'gen_ai.system_instructions', 'gen_ai.tool.definitions',
];

async function nativeAgentEvents(directory: string): Promise<AgentActivityEntry[]> {
  const input = new CodexTranscriptInput({
    stateStore: new StateStore(path.join(directory, 'state.json')),
    sessionDir: directory, wakeupDir: path.join(directory, 'wakeups'),
    spanContextDir: path.join(directory, 'contexts'),
  });
  const collected: AgentActivityEntry[] = [];
  input.on('entries', batch => collected.push(...batch));
  const file = path.join(directory, 'rollout-parent.jsonl');
  const records = [
    ['session_meta', { id: 'native-parent', timestamp: '2026-08-07T02:00:00Z', model_provider: 'openai' }],
    ['turn_context', { turn_id: 'native-turn', model: 'gpt-test' }],
    ['event_msg', { type: 'task_started', turn_id: 'native-turn' }],
    ['response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent input' }] }],
    ['response_item', { type: 'function_call', call_id: 'spawn-batch', name: 'spawn_agent',
      arguments: JSON.stringify({ agents: [{ message: 'task A' }, { prompt: 'task B' }] }) }],
    ['response_item', { type: 'function_call_output', call_id: 'spawn-batch',
      output: JSON.stringify({ agents: [{ agent_id: 'child-A', nickname: 'Newton' }, { agent_id: 'child-B', nickname: 'Curie' }] }) }],
    ['response_item', { type: 'function_call', call_id: 'wait-batch', name: 'wait',
      arguments: JSON.stringify({ ids: ['child-A', 'child-B'] }) }],
    ['response_item', { type: 'function_call_output', call_id: 'wait-batch',
      output: JSON.stringify({ status: { 'child-A': { completed: 'result A' }, 'child-B': { completed: 'result B' } } }) }],
    ['event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
    ['event_msg', { type: 'task_complete', turn_id: 'native-turn', last_agent_message: 'done' }],
  ];
  await writeFile(file, records.map(([type, payload], i) => JSON.stringify({
    timestamp: new Date(Date.parse('2026-08-07T02:00:00Z') + i * 1000).toISOString(), type, payload,
  })).join('\n') + '\n');
  await (input as unknown as { processFile(file: string): Promise<void> }).processFile(file);
  const audit = collected.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke' || entry['event.name'] === 'gen_ai.agent.result');
  expect(audit.map(entry => entry['event.name'])).toEqual([
    'gen_ai.agent.invoke', 'gen_ai.agent.invoke', 'gen_ai.agent.result', 'gen_ai.agent.result',
  ]);
  expect(audit.slice(0, 2).map(entry => entry['gen_ai.input.messages'])).toEqual(['task A', 'task B'].map(content => [
    { role: 'user', parts: [{ type: 'text', content }] },
  ]));
  expect(audit.slice(2).map(entry => entry['gen_ai.output.messages'])).toEqual(['result A', 'result B'].map(content => [
    { role: 'assistant', parts: [{ type: 'text', content }] },
  ]));
  expect(audit.map(entry => entry['gen_ai.agent.peer.name'])).toEqual(['Newton', 'Curie', 'Newton', 'Curie']);
  for (const entry of audit) expect(entry).not.toHaveProperty('gen_ai.tool.call.arguments');
  return audit;
}

describe('Codex standard event output boundaries', () => {
  it.each([true, false])('keeps content and identities across JSONL, HTTP and SLS despite legacy content=%s', async captureMessageContent => {
    postLogs.mockClear();
    const directory = await mkdtemp(path.join(tmpdir(), 'pilot-codex-output-'));
    const received: Record<string, string>[][] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).entries);
      response.writeHead(200).end('{}');
    });
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('Missing local receiver address');

    const jsonl = new JsonlFlusher({ enabled: true, outputDir: directory, rotateDaily: false });
    const http = new HttpFlusher({
      enabled: true, url: `http://127.0.0.1:${address.port}/events`,
      batchMaxSize: 100, flushIntervalMs: 60_000, requestTimeoutMs: 5000,
    });
    const slsConfig: SlsFlusherConfig = {
      enabled: true, mode: 'ak', endpoint: 'https://example.invalid',
      accessKeyId: '', accessKeySecret: '', apiKey: '', serviceNamePrefix: '',
      batchMaxSize: 100, flushIntervalMs: 60_000,
      endpoints: [false, true].map(redact => ({
        name: redact ? 'redacted' : 'activity',
        endpoint: 'https://example.invalid', project: 'test-project',
        logstore: redact ? 'redacted' : 'activity', kind: 'agentActivity' as const,
        mode: 'ak' as const, redact,
      })),
    };
    const sls = new SlsFlusher(slsConfig, directory, 'test-build');

    try {
      await jsonl.start();
      const native = await nativeAgentEvents(directory);
      const rawEntries = [...names.filter(name => !name.startsWith('gen_ai.agent.')).map((name, index) => buildAgentActivityEntry({
        ...relationFields,
        'event.name': name,
        'event.id': `codex-event-${index}`,
        time_unix_nano: '1700000000000000000',
        'user.id': 'test-user',
        'gen_ai.agent.type': ClientType.CodexCliHook,
        'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'prompt' }] }],
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'prompt' }] }],
        'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'result' }] }],
        'gen_ai.tool.call.arguments': { prompt: 'delegated task' },
        'gen_ai.tool.call.result': { output: 'delegated result' },
        'gen_ai.system_instructions': [{ type: 'text', content: 'instructions' }],
        'gen_ai.tool.definitions': [{ type: 'function', name: 'spawn_agent' }],
      })), ...native];
      const manager = new InputManager();
      manager.setAgentsConfig({ [ClientType.CodexCliHook]: { captureMessageContent } });
      const entries = manager.prepareRestoredEntries(rawEntries);
      for (const field of contentFields) expect(entries[0][field]).toEqual(rawEntries[0][field]);
      const expectedNames = entries.map(entry => entry['event.name']);
      // The existing agent.input compatibility path must not double-write standard events.
      const output = expandAgentInputEvents(entries);
      expect(output).toHaveLength(entries.length);
      await jsonl.sendBatch(output);
      await http.sendBatch(output);
      await sls.sendBatch(output);
      await http.flush();
      await sls.flush();

      const jsonLogs = (await readFile(path.join(directory, 'codex-all.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      expect(received).toHaveLength(1);
      expect(postLogs).toHaveBeenCalledTimes(2);
      const slsLogs = postLogs.mock.calls.map(call => call[2].logs.map(
        (log: { content: Record<string, string> }) => log.content,
      ));
      const groups = [jsonLogs, received[0], ...slsLogs];
      for (const logs of groups) {
        expect(logs.map((log: Record<string, unknown>) => log['event.name'])).toEqual(expectedNames);
        expect(logs.map((log: Record<string, unknown>) => log['event.id']))
          .toEqual(entries.map(entry => entry['event.id']));
        expect(new Set(logs.map((log: Record<string, unknown>) => log['event.id'])).size).toBe(entries.length);
        for (let i = 0; i < logs.length; i++) {
          for (const field of Object.keys(relationFields)) expect(logs[i][field]).toBe(entries[i][field]);
        }
      }
      // JSON-native JSONL and string-only transports retain content despite the legacy opt-out.
      const activityLogs = postLogs.mock.calls.find(call => call[1] === 'activity')![2].logs;
      for (const field of contentFields) {
        expect(jsonLogs[0][field]).toEqual(entries[0][field]);
        expect(JSON.parse(received[0][0][field])).toEqual(entries[0][field]);
        expect(JSON.parse(activityLogs[0].content[field])).toEqual(entries[0][field]);
      }
      for (const entry of native) {
        const index = entries.findIndex(item => item['event.id'] === entry['event.id']);
        const field = entry['event.name'] === 'gen_ai.agent.invoke' ? 'gen_ai.input.messages' : 'gen_ai.output.messages';
        expect(jsonLogs[index][field]).toEqual(entry[field]);
        expect(JSON.parse(received[0][index][field])).toEqual(entry[field]);
        expect(JSON.parse(activityLogs[index].content[field])).toEqual(entry[field]);
      }
      const redacted = postLogs.mock.calls.find(call => call[1] === 'redacted')![2].logs;
      for (const { content } of redacted) {
        expect(content).not.toHaveProperty('gen_ai.input.messages');
        expect(content).not.toHaveProperty('gen_ai.tool.call.arguments');
        expect(content).not.toHaveProperty('gen_ai.tool.call.result');
      }
    } finally {
      await Promise.all([jsonl.shutdown(), http.shutdown(), sls.shutdown()]);
      receiver.close();
      await once(receiver, 'close');
    }
  });
});
