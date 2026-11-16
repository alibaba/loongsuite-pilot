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
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine, doubaoToolLine } from '../helpers/doubao-work-fixture.js';

class ProbeInput extends DoubaoWorkInput { baseline() { return this.collect(); } }

it('keeps both products isolated through shared identity, masking, JSONL and LLM/tool conversion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-dual-pipeline-'));
  const store = new StateStore(path.join(root, 'state.json'));
  const spans: ReadableSpan[] = [];
  const trace = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:1' }], serviceName: 'doubao-dual-test' }, undefined, () => ({
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
  const outputDir = path.join(root, 'output');
  const output = new MultiFlusher([new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false }), trace]);
  const manager = new InputManager(); manager.setFlusher(output); manager.setConfiguredUserId('synthetic-user');
  manager.setMaskConfig({ mode: 'all', types: [] });
  const inputs: ProbeInput[] = [];
  const secret = 'sk-' + 'x'.repeat(24);
  try {
    for (const client of ['doubao', 'doubao-work'] as const) {
      const logs = path.join(root, client, 'logs'), sessions = path.join(root, client, 'sessions');
      await mkdir(logs, { recursive: true }); await writeFile(path.join(logs, DOUBAO_FILE), '');
      const system = path.join(sessions, '12345678', 'agents', 'm_main', 'system');
      await mkdir(system, { recursive: true });
      await writeFile(path.join(system, 'assignment.md'), `## [${new Date(DOUBAO_EPOCH).toISOString()}] 需求\n${client}_INPUT ${secret}\n`);
      await writeFile(path.join(system, 'trajectory.jsonl'), [
        { role: 'assistant', tool_calls: [{ id: 'same-call', function: { name: 'Read', arguments: { path: client, key: secret } } }] },
        { role: 'tool', tool_call_id: 'same-call', content: `${client}_RESULT ${secret}` },
        { role: 'assistant', content: `${client}_FINAL ${secret}` },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const input = new ProbeInput({ stateStore: store, inputId: client, sessionsRoot: sessions, logDir: logs, resourceShare: 2, pollIntervalMs: 100 });
      inputs.push(input); manager.registerInput(input);
    }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await Promise.all(inputs.map(input => input.baseline())); clock.mockRestore();
    await output.start(); await Promise.all(inputs.map(input => manager.startInput(input.id)));
    for (const input of inputs) {
      const meta = { conversation_id: '12345678' };
      await appendFile(path.join(root, input.id, 'logs', DOUBAO_FILE), doubaoLine('on_message_session_start', meta, 10)
        + doubaoToolLine({ tcid: 'same-call' }, 1000)
        + doubaoToolLine({ toolCallID: 'same-call', phase: 'execution_settled', status: 'success' }, 2000)
        + doubaoLine('on_message_session_end', meta, 3000));
    }
    await vi.waitFor(() => expect(spans).toHaveLength(14));
    await manager.stopAll(); await output.flush();
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(2);
    expect(new Set(spans.map(span => `${span.spanContext().traceId}:${span.spanContext().spanId}`)).size).toBe(14);
    for (const client of ['doubao', 'doubao-work']) {
      const own = spans.filter(span => span.attributes['loongsuite.doubao_work.client'] === client);
      expect(own).toHaveLength(7);
      expect(own.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(2);
      expect(own.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
      expect(own.every(span => span.attributes['gen_ai.framework'] === client)).toBe(true);
      const agent = own.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
      expect(agent.attributes['gen_ai.agent.id']).toBe('m_main');
      for (const span of own.filter(span => span.parentSpanId)) {
        expect(own.some(parent => parent.spanContext().spanId === span.parentSpanId)).toBe(true);
      }
      const events = (await readFile(path.join(outputDir, `${client}-all.jsonl`), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
      expect(events.every(event => event['gen_ai.agent.type'] === client)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(secret);
    }
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(secret);
  } finally { vi.restoreAllMocks(); await manager.stopAll(); await output.shutdown(); await rm(root, { recursive: true, force: true }); }
});
