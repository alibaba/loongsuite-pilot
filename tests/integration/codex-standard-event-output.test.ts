import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { expandAgentInputEvents } from '../../src/normalization/agent-input-dual-write.js';
import { applyAgentContentPolicy } from '../../src/normalization/agent-content-policy.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { HttpFlusher } from '../../src/flushers/http-flusher.js';
import { SlsFlusher } from '../../src/flushers/sls-flusher.js';
import { ClientType, type AgentEventName, type SlsFlusherConfig } from '../../src/types/index.js';

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

describe('Codex standard event output boundaries', () => {
  it.each([true, false])('keeps one event and the same identities across JSONL, HTTP and SLS (content=%s)', async captureMessageContent => {
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
      const entries = names.map((name, index) => applyAgentContentPolicy(buildAgentActivityEntry({
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
      }), { [ClientType.CodexCliHook]: { captureMessageContent } }));
      // The existing agent.input compatibility path must not double-write standard events.
      const output = expandAgentInputEvents(entries);
      expect(output).toHaveLength(names.length);
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
        expect(logs.map((log: Record<string, unknown>) => log['event.name'])).toEqual(names);
        expect(logs.map((log: Record<string, unknown>) => log['event.id']))
          .toEqual(entries.map(entry => entry['event.id']));
        expect(new Set(logs.map((log: Record<string, unknown>) => log['event.id'])).size).toBe(names.length);
        for (const log of logs) expect(log).toMatchObject(relationFields);
      }
      if (!captureMessageContent) {
        for (const logs of groups) {
          for (const log of logs) {
            for (const field of contentFields) expect(log).not.toHaveProperty(field);
          }
        }
      } else {
        // JSON-native JSONL and string-only transports retain the same structured payload.
        expect(JSON.parse(received[0][0]['gen_ai.input.messages']))
          .toEqual(jsonLogs[0]['gen_ai.input.messages']);
        const activity = postLogs.mock.calls.find(call => call[1] === 'activity')![2].logs[0].content;
        expect(JSON.parse(activity['gen_ai.tool.call.arguments']))
          .toEqual(jsonLogs[0]['gen_ai.tool.call.arguments']);
        const redacted = postLogs.mock.calls.find(call => call[1] === 'redacted')![2].logs;
        for (const { content } of redacted) {
          expect(content).not.toHaveProperty('gen_ai.input.messages');
          expect(content).not.toHaveProperty('gen_ai.tool.call.arguments');
          expect(content).not.toHaveProperty('gen_ai.tool.call.result');
        }
      }
    } finally {
      await Promise.all([jsonl.shutdown(), http.shutdown(), sls.shutdown()]);
      receiver.close();
      await once(receiver, 'close');
    }
  });
});
