import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { DoubaoWorkInput } from '../../src/inputs/doubao-work/doubao-work-input.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, DOUBAO_NATIVE_FILES, doubaoCommandLine, doubaoFirstOutputLine, doubaoLine, doubaoToolLine } from '../helpers/doubao-work-fixture.js';

class ProbeInput extends DoubaoWorkInput {
  constructor(opts: ConstructorParameters<typeof DoubaoWorkInput>[0]) { super({ nativeScanIntervalMs: 0, ...opts }); }
  baseline() { return this.collect(); }
}

it('routes native first output and late execution snapshots through the masked pipeline without inventing child LLMs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-execution-pipeline-'));
  const logs = path.join(root, 'logs'), sessionsRoot = path.join(root, 'native'), snapshotRoot = path.join(root, 'snapshots');
  await mkdir(logs); const source = path.join(logs, DOUBAO_FILE); await writeFile(source, '');
  const stateStore = new StateStore(path.join(root, 'state.json'));
  const input = new ProbeInput({ stateStore, logDir: logs, sessionsRoot, snapshotRoot, pollIntervalMs: 100 });
  const spans: ReadableSpan[] = [];
  const trace = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }], serviceName: 'doubao-execution-pipeline' }, undefined, () => ({
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
  const outputDir = path.join(root, 'output'), output = new MultiFlusher([new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false }), trace]);
  const manager = new InputManager(); manager.setFlusher(output); manager.setConfiguredUserId('synthetic-employee');
  manager.setUserId('synthetic-host'); manager.setMaskConfig({ mode: 'all', types: [] }); manager.registerInput(input);
  const conv = '12345678', query = '00000000-0000-4000-8000-000000000002';
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1); await input.baseline(); clock.mockRestore();
    await output.start(); await manager.startInput('doubao-work');
    const meta = { conversation_id: conv, send_local_message_id: query };
    await appendFile(source, doubaoLine('on_message_session_start', meta, 10) + doubaoCommandLine('synthetic-turn', 'synthetic-sandbox')
      + doubaoCommandLine('o_nativeOrg', 'synthetic-sandbox', 3500)
      + doubaoFirstOutputLine({ prompt: 'SYNTHETIC_PRIVATE_PROMPT' })
      + doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox', 4000) + doubaoLine('on_message_session_end', meta));
    await vi.waitFor(() => expect(spans).toHaveLength(4));
    for (const [id, content] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const dir = path.join(sessionsRoot, conv, 'agents', id, 'system'); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'trajectory.jsonl'), content);
    }
    const execution = { executionKey: '00000000-0000-4000-8000-000000000001', conversationId: conv, queryMessageId: query,
      agentId: 's_nativeLeaf', agentType: 'sub_agent', sandboxId: 'synthetic-sandbox', startedAtMs: DOUBAO_EPOCH + 4000, endedAtMs: DOUBAO_EPOCH + 5000 };
    const dir = path.join(snapshotRoot, '123', conv, execution.executionKey); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${execution.agentId}.json`), JSON.stringify({ execution: { ...execution, userId: 'SYNTHETIC_PRIVATE_ACCOUNT' }, fileContents: 'SYNTHETIC_PRIVATE_BODY' }));
    const parent = { ...execution, executionKey: '00000000-0000-4000-8000-000000000003', agentId: 'o_nativeOrg',
      startedAtMs: DOUBAO_EPOCH + 3500, endedAtMs: DOUBAO_EPOCH + 5500 };
    const parentDir = path.join(snapshotRoot, '123', conv, parent.executionKey); await mkdir(parentDir, { recursive: true });
    await writeFile(path.join(parentDir, `${parent.agentId}.json`), JSON.stringify({ execution: parent }));
    await vi.waitFor(() => expect(spans).toHaveLength(6)); await manager.stopAll(); await output.flush();
    const native = spans.find(s => s.attributes['loongsuite.doubao_work.native_execution_id'] === execution.executionKey)!;
    const rootAgent = spans.find(s => s.attributes['gen_ai.agent.id'] === 'doubao-work' && s.attributes['gen_ai.span.kind'] === 'AGENT')!;
    const nativeParent = spans.find(s => s.attributes['loongsuite.doubao_work.native_execution_id'] === parent.executionKey)!;
    expect(native.parentSpanId).toBe(nativeParent.spanContext().spanId);
    expect(nativeParent.parentSpanId).toBe(rootAgent.spanContext().spanId);
    expect(native.spanContext().traceId).toBe(rootAgent.spanContext().traceId);
    expect(native.startTime).toEqual([Math.floor(execution.startedAtMs / 1000), (execution.startedAtMs % 1000) * 1_000_000]);
    const events = (await readFile(path.join(outputDir, 'doubao-work-all.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(11); expect(new Set(events.map(e => e['event.id'])).size).toBe(11);
    const step = spans.find(s => s.attributes['gen_ai.span.kind'] === 'STEP')!;
    const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM'); expect(llms).toHaveLength(1);
    expect(step.parentSpanId).toBe(rootAgent.spanContext().spanId);
    expect(llms[0].parentSpanId).toBe(step.spanContext().spanId);
    expect(llms[0].attributes['gen_ai.user.id']).toBe('synthetic-employee');
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
    expect(native.attributes['loongsuite.doubao_work.parent_resolution']).toBe('same_query_native_execution');
    expect(JSON.stringify({ events, attrs: spans.map(s => s.attributes) })).not.toContain('SYNTHETIC_PRIVATE');
  } finally { vi.restoreAllMocks(); await manager.stopAll(); await output.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it('routes watched native-shaped metadata through identity, mask, JSONL projection and real trace conversion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-pipeline-'));
  const logs = path.join(root, 'source');
  const outputDir = path.join(root, 'output');
  await mkdir(logs);
  const source = path.join(logs, DOUBAO_FILE);
  await writeFile(source, '');
  const stateStore = new StateStore(path.join(root, 'state.json'));
  const sessionsRoot = path.join(root, 'native');
  const input = new ProbeInput({ stateStore, logDir: logs, sessionsRoot, pollIntervalMs: 100 });
  const spans: ReadableSpan[] = [];
  const trace = new OtlpTraceFlusher({
    enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf', serviceName: 'doubao-integration',
  }, undefined, () => ({
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
  const output = new MultiFlusher([
    new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false, maxFileSizeMb: 1 }), trace,
  ]);
  const manager = new InputManager();
  manager.setFlusher(output);
  manager.setUserId('synthetic-host');
  manager.setConfiguredUserId('synthetic-employee');
  manager.setMaskConfig({ mode: 'all', types: [] });
  manager.registerInput(input);
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await input.baseline();
    clock.mockRestore();
    await output.start();
    await manager.startInput('doubao-work');
    await appendFile(source, doubaoLine('on_message_session_start', {}, 10)
      + doubaoCommandLine('synthetic-turn', 'synthetic-sandbox')
      + doubaoLine('on_message_session_end', {
        session_success: '1', agent_error: '0',
        content: 'SYNTHETIC_CAPACITY_NOTICE', prompt: 'SYNTHETIC_SECRET_PROMPT',
        error_message: 'SYNTHETIC_SECRET_ERROR',
      }));
    await vi.waitFor(() => expect(spans).toHaveLength(2), { timeout: 3000 });
    for (const [id, content] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const dir = path.join(sessionsRoot, 'synthetic-conversation', 'agents', id, 'system');
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'trajectory.jsonl'), content);
    }
    await appendFile(source, doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox', 4000)
      + doubaoCommandLine('o_nativeOrg', 'synthetic-sandbox', 4050)
      + doubaoToolLine({ agent_id: 's_nativeLeaf', tcid: 'pipeline-child', private: 'SYNTHETIC_SECRET' }, 4100)
      + doubaoToolLine({ toolCallID: 'pipeline-child', phase: 'execution_settled', status: 'success' }, 4200));
    await vi.waitFor(() => expect(spans).toHaveLength(5), { timeout: 3000 });
    await manager.stopAll();
    await output.flush();
    const events = (await readFile(path.join(outputDir, 'doubao-work-all.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(e => e['event.name'] === 'other')).toHaveLength(4);
    expect(events.every(e => e['user.id'] === 'synthetic-employee')).toBe(true);
    expect(events.every(e => e['loongsuite.doubao_work.business_outcome'] === 'unknown')).toBe(true);
    expect(events.filter(e => e['gen_ai.turn.start'] === true)).toHaveLength(2);
    expect(events.filter(e => e['gen_ai.turn.end'] === true)).toHaveLength(2);
    expect(events.filter(e => e['event.name'] === 'tool.call')).toHaveLength(1);
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(3);
    expect(new Set(events.map(e => e['event.id'])).size).toBe(events.length);
    expect(JSON.stringify({ events, spans: spans.map(s => ({ attributes: s.attributes, resource: s.resource.attributes })) }))
      .not.toMatch(/SYNTHETIC_SECRET|SYNTHETIC_CAPACITY_NOTICE/);
    expect(spans.every(s => s.status.code === 0)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await manager.stopAll();
    await output.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
