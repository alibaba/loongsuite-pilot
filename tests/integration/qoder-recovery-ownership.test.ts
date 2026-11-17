import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { loadDatabaseSync } from '../../src/utils/node-sqlite.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { QoderTranscriptSource } from '../../src/inputs/qoder-trace/transcript-source.js';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { QoderCnTraceInput } from '../../src/inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';

const discovery = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('../../src/inputs/qoder-trace/sqlite-token-reader.js', async original => ({
  ...await original<object>(), resolveAllQoderDbPaths: () => discovery.paths,
}));
vi.mock('../../src/inputs/qoder-cn-trace/sqlite-token-reader.js', async original => ({
  ...await original<object>(), resolveQoderCnDbPaths: () => discovery.paths,
}));

const epoch = Date.now() - 60_000;
const stamp = (ms: number) => new Date(epoch + ms).toISOString();
const secret = 'sk-' + 'synthetic'.repeat(4);
let root: string;
let source: QoderTranscriptSource | undefined;
let manager: InputManager | undefined;
let flusher: MultiFlusher | undefined;
afterEach(async () => {
  source?.stop(); source = undefined;
  await manager?.stopAll(); manager = undefined;
  await flusher?.shutdown(); flusher = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function seed(agentId: 'qoder' | 'qoder-cn', damaged: boolean) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-owner-pipeline-'));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ enabled: true, dataDir: root }));
  discovery.paths = Array.from({ length: 5 }, (_, i) => path.join(root, `cache-${i}.db`));
  const Database = loadDatabaseSync()!;
  for (let i = 0; i < discovery.paths.length; i++) {
    const db = new Database(discovery.paths[i]!);
    try {
      db.exec('CREATE TABLE chat_message (session_id TEXT, request_id TEXT, role TEXT, gmt_create INTEGER)');
      db.prepare('INSERT INTO chat_message VALUES (?, ?, ?, ?)').run(
        i === 4 ? 'synthetic-session' : 'other-session', 'owned-0', 'user', epoch + 10);
    } finally { db.close(); }
  }
  const file = path.join(root, 'native.jsonl');
  const rows = [
    { type: 'user', timestamp: stamp(10), message: { role: 'user', content: `read the fixture ${secret}` } },
    { type: 'assistant', timestamp: stamp(100), message: { id: 'response-0', model: 'synthetic-model', role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-0', name: 'Read',
        input: { path: secret, options: { enabled: true, counts: [2, 3] } } }], stop_reason: 'tool_use' } },
    { type: 'user', timestamp: stamp(200), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-0', content: `fixture result ${secret}` }] } },
    { type: 'assistant', timestamp: stamp(300), message: { id: 'response-1', model: 'synthetic-model', role: 'assistant',
      content: [{ type: 'text', text: `fixture read ${secret}` }], stop_reason: 'end_turn' } },
  ];
  const terminal = [{ type: 'progress', timestamp: stamp(400), data: { hookEvent: 'Stop' } }, { type: 'last-prompt' }];
  const jsonl = (value: object[]) => value.map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(file, jsonl(rows) + (damaged ? '{broken}\n' : '') + jsonl(terminal));
  expect(publishQoderWakeup({ session_id: 'synthetic-session', transcript_path: file, cwd: root,
    hook_event_name: 'UserPromptSubmit', request_set_id: 'owned-0', parent_business_info: { product: 'app' } }, { dataDir: root, agentId })).toBe(true);
  const store = new StateStore(path.join(root, 'input-state.json')); await store.load();
  return { file, store };
}

describe.skipIf(!loadDatabaseSync()).each(['qoder', 'qoder-cn'] as const)('%s recovery across production layers', agentId => {
  it('persists the database rotation through StateStore and resumes the fifth database after source restart', async () => {
    const { store } = await seed(agentId, false);
    const id = agentId + '-trace';
    const create = () => new QoderTranscriptSource(path.join(root, 'logs', agentId, 'history'), agentId, () => null, () => {}, root);
    source = create();
    const first = await source.read(undefined, true);
    expect(first.records).toEqual([]);
    expect(Object.values(first.state).map((value: any) => value.initialOwnership.dbSearch.nextIndex)).toEqual([4]);
    store.update(id, { extra: { qoderTranscripts: first.state } }); await store.save();
    source.stop();
    const loaded = new StateStore(path.join(root, 'input-state.json')); await loaded.load();
    discovery.paths.reverse(); source = create();
    const second = await source.read(loaded.get(id).extra, loaded.isPersisted(id, 'qoderTranscripts'));
    expect(second.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
    store.update(id, { extra: { qoderTranscripts: second.state } }); await store.save();
    expect((await source.read(store.get(id).extra, store.isPersisted(id, 'qoderTranscripts'))).records).toEqual([]);
  });

  it('preserves recovered tool types, per-call usage, masking and incomplete semantics through InputManager and the real genai flusher', async () => {
    const { file, store } = await seed(agentId, true);
    const output = new MockFlusher(); const spans: ReadableSpan[] = [];
    const otlp = new OtlpTraceFlusher({ enabled: true, serviceName: 'synthetic-qoder-recovery',
      endpoints: [{ endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {} }], protocol: 'http/protobuf',
    }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); },
      shutdown: async () => {},
    }));
    flusher = new MultiFlusher([output, otlp]);
    const createInput = () => {
      const Ctor = agentId === 'qoder' ? QoderTraceInput : QoderCnTraceInput;
      const input = new Ctor({ dataDir: root, logDir: path.join(root, 'logs', agentId, 'history'),
        stateStore: store, pollIntervalMs: 60_000 });
      vi.spyOn(input as any, 'readIdeSqliteTokens').mockResolvedValue({ matchedDbPath: discovery.paths.find(p => p.endsWith('cache-4.db')),
        rows: [0, 1].map(step => ({ sessionId: 'synthetic-session', requestId: 'owned-0', messageId: `response-${step}`,
          gmtCreate: epoch + (step === 0 ? 100 : 300), model: 'synthetic-model', inputTokens: 100 + step * 10,
          outputTokens: 10 + step, cacheReadTokens: 50 })) });
      manager = new InputManager(); manager.setConfiguredUserId('synthetic-user');
      manager.setMaskConfig({ mode: 'all', types: [] }); manager.setFlusher(flusher!);
      manager.registerInput(input); return input;
    };
    let input = createInput(); await input.start(); await (input as any).cyclePromise;
    expect(output.batchCalls.flat()).toEqual([]);
    await (input as any).runCycle();
    // Collection queues output through InputManager; it does not await the
    // async fan-out for non-Codex inputs. Wait for the owner before inspecting it.
    await (manager as any).drainAllEntryQueues();
    await flusher.flush();
    const events = output.batchCalls.flat();
    expect(new Set(events.map(row => row['gen_ai.turn.id'])).size).toBe(1);
    expect(new Set(events.map(row => row['event.id'])).size).toBe(events.length);
    expect(events.filter(row => row['event.name'] === 'llm.request')).toHaveLength(2);
    expect(events.filter(row => row['event.name'] === 'llm.response').map(row => row['gen_ai.usage.input_tokens'])).toEqual([100, 110]);
    expect(events.filter(row => row['event.name'] === 'tool.call').map(row => row['gen_ai.tool.call.arguments']))
      .toEqual([{ path: '[APIKEY_MASKED]', options: { enabled: true, counts: [2, 3] } }]);
    expect(events.filter(row => row['event.name'] === 'tool.result')).toHaveLength(1);
    expect(events.filter(row => row['event.name'] === 'llm.response').every(row => row['agent.transcript_incomplete'] === true)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(await fs.readFile(file, 'utf8')).toContain('{broken}');
    const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(2);
    expect(llms.map(span => span.attributes['gen_ai.usage.input_tokens']).sort()).toEqual([100, 110]);
    expect(llms.map(span => span.attributes['gen_ai.usage.output_tokens']).sort()).toEqual([10, 11]);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
    const entry = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(entry).toHaveLength(1); expect(entry[0]!.parentSpanId).toBeUndefined();
    expect(entry[0]!.attributes['agent.transcript_incomplete']).toBe(true);
    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(210); expect(agent.attributes['gen_ai.usage.output_tokens']).toBe(21);
    const ids = new Set(spans.map(span => span.spanContext().spanId)); expect(ids.size).toBe(spans.length);
    expect(spans.filter(span => span !== entry[0]).every(span => ids.has(span.parentSpanId!))).toBe(true);
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(secret);
    await manager!.stopAll(); input = createInput(); await input.start(); await (input as any).cyclePromise;
    await flusher.flush();
    expect(output.batchCalls.flat()).toHaveLength(events.length); expect(spans).toHaveLength(7);
  });
});
