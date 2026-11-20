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
import { loadDatabaseSync } from '../../src/utils/node-sqlite.js';
import * as sqliteTokenReader from '../../src/inputs/qoder-trace/sqlite-token-reader.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
describe('IDE native delegation through durable input and final spans', () => {
  it('exports a child request with more than 256 SQLite messages and survives restart', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-ide-long-')));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'transcript'); await fs.mkdir(directory);
    const epoch = Date.now() - 60000; const at = (ms: number) => new Date(epoch + ms).toISOString();
    const parent = path.join(directory, 'parent.jsonl');
    await fs.writeFile(parent, [
      { type: 'user', sessionId: 'parent', uuid: 'prompt', timestamp: at(0), message: { role: 'user', content: 'delegate' } },
      { type: 'assistant', sessionId: 'parent', uuid: 'root-1', timestamp: at(100), message: { id: 'root-1', role: 'assistant', model: 'native-model', content: [{ type: 'tool_use', id: 'delegate', name: 'Agent', input: { prompt: 'read files', subagent_type: 'reader' } }] } },
      { type: 'user', sessionId: 'parent', timestamp: at(10000), toolUseResult: 'delivered result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'delegate', content: 'delivered result' }] } },
      { type: 'assistant', sessionId: 'parent', uuid: 'root-2', timestamp: at(11000), message: { id: 'root-2', role: 'assistant', model: 'native-model', content: [{ type: 'text', text: 'done' }] } },
      { type: 'progress', timestamp: at(12000), data: { hookEvent: 'Stop' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const Database = loadDatabaseSync(); if (!Database) throw new Error('node:sqlite required');
    const dbPath = path.join(root, 'fixture.db'); const db = new Database(dbPath); cleanups.push(async () => { db.close(); });
    db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, parent_session_id TEXT, parent_tool_call_id TEXT, extra TEXT);
      CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, tool_result TEXT, session_id TEXT, request_id TEXT)`);
    vi.spyOn(sqliteTokenReader, 'resolveAllQoderDbPaths').mockReturnValue([dbPath]);
    db.prepare('INSERT INTO chat_record VALUES (?, ?, ?, ?, ?)').run('child', 'request', 'parent', 'delegate', null);
    const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const put = (id: string, role: string, time: number, tool?: string) => insert.run(id, role, epoch + time,
      role === 'assistant' ? JSON.stringify({ prompt_tokens: 10, completion_tokens: 2, cached_tokens: 1 }) : null,
      null, tool ? JSON.stringify({ toolCallId: tool }) : null, 'child', 'request');
    put('user', 'user', 110);
    const childRows: object[] = [];
    for (let i = 0; i < 128; i++) {
      const tool = `read-${i}`; const time = 120 + i * 10;
      put(`assistant-${i}`, 'assistant', time); put(`tool-${i}`, 'tool', time + 1, tool);
      childRows.push({ type: 'assistant', sessionId: 'child', timestamp: at(time), message: { role: 'assistant', content: [{ type: 'tool_use', id: tool, name: 'Read', input: { file_path: 'fixture.txt' } }] } });
      childRows.push({ type: 'user', sessionId: 'child', timestamp: at(time + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'file content' }] } });
    }
    put('assistant-final', 'assistant', 2000);
    await fs.writeFile(path.join(directory, 'child.jsonl'), childRows.map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(publishQoderWakeup({ session_id: 'parent', transcript_path: parent, cwd: root, hook_event_name: 'Stop' }, { dataDir: root, agentId: 'qoder' })).toBe(true);
    const output = new MockFlusher();
    const start = async () => {
      const state = new StateStore(path.join(root, 'state.json')); await state.load();
      const manager = new InputManager(); manager.setFlusher(output); manager.setConfiguredUserId('synthetic-user');
      manager.setAgentsConfig({ qoder: { enabled: true, captureMessageContent: true } });
      const input = new QoderTraceInput({ dataDir: root, stateStore: state, logDir: path.join(root, 'history'), pollIntervalMs: 60000 });
      const collector = (input as any).transcriptSource.collector; collector.stableMs = 0; collector.settleMs = 0;
      vi.spyOn(input as any, 'readIdeSqliteTokens').mockResolvedValue({ rows: [], matchedDbPath: null });
      manager.registerInput(input); await input.start(); await (input as any).cyclePromise;
      for (let i = 0; i < 3; i++) await (input as any).runCycle();
      await manager.stopAll(); await state.save();
    };
    await start();
    const entries = output.batchCalls.flat(); const child = entries.filter(row => row['gen_ai.session.id'] === 'child');
    expect(child.filter(row => row['event.name'] === 'llm.response')).toHaveLength(129);
    expect(child.filter(row => row['event.name'] === 'tool.call')).toHaveLength(128);
    expect(new Set(child.filter(row => row['event.name'] === 'tool.call').map(row => row['gen_ai.tool.call.id'])).size).toBe(128);
    expect(entries.filter(row => row['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(1);
    expect(entries.filter(row => row['event.name'] === 'gen_ai.agent.result')).toHaveLength(1);
    const count = entries.length; await start(); expect(output.batchCalls.flat()).toHaveLength(count);
    const spans: ReadableSpan[] = [];
    const otlp = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'ide-test', captureMessageContent: true,
      endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }] }, undefined,
    () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
    try { await otlp.sendBatch(entries); await otlp.flush(); } finally { await otlp.shutdown(); }
    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT' && span.attributes['gen_ai.session.id'] === 'child');
    expect(agent).toBeDefined();
    expect(spans.find(span => span.spanContext().spanId === agent!.parentSpanId)?.attributes['gen_ai.tool.name']).toBe('Agent');
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM' && span.attributes['gen_ai.session.id'] === 'child')).toHaveLength(129);
  });

  it('recovers late SQLite relationships and growing tool inventory across durable restarts', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-ide-late-')));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'transcript'); await fs.mkdir(directory);
    const epoch = Date.now() - 60000; const at = (s: number) => new Date(epoch + s * 1000).toISOString();
    const parent = path.join(directory, 'parent.jsonl');
    await fs.writeFile(parent, [
      { type: 'user', sessionId: 'parent', uuid: 'prompt', timestamp: at(0), message: { role: 'user', content: 'delegate' } },
      { type: 'assistant', sessionId: 'parent', uuid: 'model-1', timestamp: at(1), message: { id: 'model-1', role: 'assistant', model: 'native-model', content: [{ type: 'tool_use', id: 'delegate', name: 'Agent', input: { prompt: 'read file', subagent_type: 'reader' } }] } },
      { type: 'user', sessionId: 'parent', timestamp: at(5), toolUseResult: 'delivered result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'delegate', content: 'delivered result' }] } },
      { type: 'assistant', sessionId: 'parent', uuid: 'model-2', timestamp: at(6), message: { id: 'model-2', role: 'assistant', model: 'native-model', content: [{ type: 'text', text: 'done' }] } },
      { type: 'progress', timestamp: at(7), data: { hookEvent: 'Stop' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await fs.writeFile(path.join(directory, 'child.jsonl'), [
      ...['read-1', 'read-2'].flatMap(id => [
        { type: 'assistant', sessionId: 'child', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'fixture.txt' } }] } },
        { type: 'user', sessionId: 'child', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'file content' }] } },
      ]),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const Database = loadDatabaseSync(); if (!Database) throw new Error('node:sqlite required');
    const dbPath = path.join(root, 'fixture.db'); const db = new Database(dbPath);
    cleanups.push(async () => { db.close(); });
    db.exec(`CREATE TABLE chat_record (session_id TEXT, request_id TEXT, parent_session_id TEXT, parent_tool_call_id TEXT, extra TEXT);
      CREATE TABLE chat_message (id TEXT, role TEXT, gmt_create INTEGER, token_info TEXT, model_info TEXT, tool_result TEXT, session_id TEXT, request_id TEXT)`);
    vi.spyOn(sqliteTokenReader, 'resolveAllQoderDbPaths').mockReturnValue([dbPath]);
    const insert = db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const put = (id: string, role: string, time: number, tool?: string) => insert.run(id, role, epoch + time,
      role === 'assistant' ? JSON.stringify({ prompt_tokens: 10, completion_tokens: 2, cached_tokens: 1 }) : null,
      null, tool ? JSON.stringify({ toolCallId: tool }) : null, 'child', 'request');
    expect(publishQoderWakeup({ session_id: 'parent', transcript_path: parent, cwd: root, hook_event_name: 'Stop' }, { dataDir: root, agentId: 'qoder' })).toBe(true);
    const output = new MockFlusher();
    const start = async () => {
      const state = new StateStore(path.join(root, 'state.json')); await state.load();
      const manager = new InputManager(); manager.setFlusher(output); manager.setConfiguredUserId('synthetic-user');
      manager.setAgentsConfig({ qoder: { enabled: true, captureMessageContent: true } });
      const input = new QoderTraceInput({ dataDir: root, stateStore: state, logDir: path.join(root, 'history'), pollIntervalMs: 60000 });
      const collector = (input as any).transcriptSource.collector; collector.stableMs = 0; collector.settleMs = 0;
      vi.spyOn(input as any, 'readIdeSqliteTokens').mockResolvedValue({ rows: [], matchedDbPath: null });
      manager.registerInput(input); await input.start(); await (input as any).cyclePromise;
      for (let i = 0; i < 3; i++) await (input as any).runCycle();
      await manager.stopAll(); await state.save();
    };
    const spans: ReadableSpan[] = [];
    const otlp = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'ide-test', captureMessageContent: true,
      endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }] }, undefined,
    () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
    try {
      await start();
      const first = output.batchCalls.flat();
      await otlp.sendBatch(first); await otlp.flush();
      const parentTool = spans.find(span => span.attributes['gen_ai.tool.name'] === 'Agent');
      expect(parentTool).toBeDefined();
      expect(spans.some(span => span.attributes['gen_ai.session.id'] === 'child')).toBe(false);
      db.prepare('INSERT INTO chat_record VALUES (?, ?, ?, ?, ?)').run('child', 'request', 'parent', 'delegate', null);
      put('user', 'user', 1100); put('assistant-1', 'assistant', 2000); put('tool-1', 'tool', 3000, 'read-1');
      await start();
      const second = output.batchCalls.flat();
      await otlp.sendBatch(second.slice(first.length)); await otlp.flush();
      expect(spans.some(span => span.attributes['gen_ai.session.id'] === 'child')).toBe(false);
      put('assistant-2', 'assistant', 3500); put('tool-2', 'tool', 4000, 'read-2'); put('assistant-3', 'assistant', 4500);
      await start();
      await otlp.sendBatch(output.batchCalls.flat().slice(second.length)); await otlp.flush();
      const child = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT' && span.attributes['gen_ai.session.id'] === 'child');
      expect(child).toBeDefined();
      expect(child!.parentSpanId).toBe(parentTool!.spanContext().spanId);
      expect(spans.filter(span => span.attributes['gen_ai.session.id'] === 'child' && span.attributes['gen_ai.span.kind'] === 'TOOL')
        .map(span => span.attributes['gen_ai.tool.call.id']).sort()).toEqual(['read-1', 'read-2']);
      expect(spans.filter(span => span.attributes['gen_ai.session.id'] === 'child' && span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(3);
    } finally { await otlp.shutdown(); }
  });

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
      { type: 'user', sessionId: 'parent', timestamp: at(5), toolUseResult: 'delivered child result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'delegate', content: 'delivered child result' }] } },
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
