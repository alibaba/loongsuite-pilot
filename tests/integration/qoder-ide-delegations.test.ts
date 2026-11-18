import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
describe('IDE native delegation through durable input and final spans', () => {
  it.each([true, false])('keeps independent identity, privacy and final TOOL parentage (content=%s)', async capture => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-ide-pipeline-')));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'transcript'); await fs.mkdir(directory);
    const epoch = Date.now() - 60000; const at = (s: number) => new Date(epoch + s * 1000).toISOString();
    const secret = 'sk-' + 'qoderSynthetic'.repeat(3);
    const model = (id: string, second: number, content: object[]) => ({ type: 'assistant', sessionId: 'parent',
      uuid: id, timestamp: at(second), message: { id, role: 'assistant', model: 'native-test-model', content } });
    const parent = path.join(directory, 'parent.jsonl');
    await fs.writeFile(parent, [
      { type: 'user', sessionId: 'parent', uuid: 'prompt', timestamp: at(0), message: { role: 'user', content: `delegate ${secret}` } },
      model('root-call', 1, [{ type: 'tool_use', id: 'delegate', name: 'Agent', input: { prompt: `read ${secret}`, subagent_type: 'reader' } }]),
      { type: 'user', sessionId: 'parent', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'delegate', content: 'delivered child result' }] } },
      model('root-end', 6, [{ type: 'text', text: 'done' }]),
      { type: 'progress', timestamp: at(7), data: { hookEvent: 'Stop' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await fs.writeFile(path.join(directory, 'child.jsonl'), [
      { type: 'assistant', sessionId: 'child', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: secret } }] } },
      { type: 'user', sessionId: 'child', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-read', content: secret }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(publishQoderWakeup({ session_id: 'parent', transcript_path: parent, cwd: root, hook_event_name: 'Stop' }, { dataDir: root, agentId: 'qoder' })).toBe(true);
    const output = new MockFlusher(); let manager: InputManager;
    const start = async () => {
      const state = new StateStore(path.join(root, 'state.json')); await state.load();
      manager = new InputManager(); manager.setFlusher(output); manager.setConfiguredUserId('synthetic-user');
      manager.setAgentsConfig({ qoder: { enabled: true, captureMessageContent: capture } });
      manager.setMaskConfig({ mode: 'all', types: ['apiKey'] });
      const input = new QoderTraceInput({ dataDir: root, stateStore: state, logDir: path.join(root, 'history'), pollIntervalMs: 60000 });
      const collector = (input as any).transcriptSource.collector; collector.stableMs = 0; collector.settleMs = 0;
      vi.spyOn(input as any, 'readIdeSqliteTokens').mockResolvedValue({ rows: [], matchedDbPath: null });
      vi.spyOn((input as any).ideDelegations, 'resolve').mockResolvedValue({ session: 'child', request: 'child-native-request', messages: [
        { id: 'child-user', role: 'user', gmt_create: epoch + 1100 },
        { id: 'child-model-1', role: 'assistant', gmt_create: epoch + 2000 },
        { id: 'child-tool-result', role: 'tool', gmt_create: epoch + 3000, tool_call_id: 'child-read' },
        { id: 'child-model-2', role: 'assistant', gmt_create: epoch + 4000 },
      ], tokens: [1, 2].map(i => ({ messageId: `child-model-${i}`, gmtCreate: epoch + i * 2000,
        inputTokens: i * 100, outputTokens: i * 10, cacheReadTokens: 20, model: 'child-native-model' })) });
      manager.registerInput(input); await input.start(); await (input as any).cyclePromise;
      for (let i = 0; i < 3; i++) await (input as any).runCycle();
      await manager.stopAll(); await state.save();
    };
    await start();
    const entries = output.batchCalls.flat(); const count = entries.length;
    const invokes = entries.filter(row => row['event.name'] === 'gen_ai.agent.invoke');
    expect(invokes).toHaveLength(1);
    const child = entries.filter(row => row['gen_ai.session.id'] === 'child');
    expect(child.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
    expect(child.every(row => row['gen_ai.agent.parent.invocation.id'] === invokes[0]!['gen_ai.agent.invocation.id'])).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(secret);
    if (!capture) for (const row of entries) for (const key of ['gen_ai.input.messages', 'gen_ai.input.messages_delta', 'gen_ai.output.messages', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result']) expect(row[key]).toBeUndefined();
    expect(await fs.readFile(path.join(root, 'state.json'), 'utf8')).not.toContain(secret);
    await start(); expect(output.batchCalls.flat()).toHaveLength(count);
    const spans: ReadableSpan[] = [];
    const otlp = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'ide-test', captureMessageContent: capture,
      endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }] }, undefined,
    () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
    try { await otlp.sendBatch(entries); await otlp.flush(); } finally { await otlp.shutdown(); }
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(2);
    const childAgent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT' && span.attributes['gen_ai.session.id'] === 'child')!;
    expect(childAgent).toBeDefined();
    const parentTool = spans.find(span => span.spanContext().spanId === childAgent.parentSpanId)!;
    expect(parentTool.attributes['gen_ai.tool.name']).toBe('Agent');
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
    expect(new Set(spans.map(span => span.spanContext().spanId)).size).toBe(spans.length);
    expect(spans.every(span => span.resource.attributes['gen_ai.agent.system'] === 'qoder-ide')).toBe(true);
  });
});
