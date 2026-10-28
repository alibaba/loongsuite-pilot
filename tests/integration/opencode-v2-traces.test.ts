import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { setupV2 } from '../../assets/plugins/opencode/v2.mjs';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { maskAgentActivityEntry } from '../../src/mask/entry-masker.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { prepareTraceEvents } from '../../src/flushers/trace-event-compat.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';

describe('OpenCode V2 event-to-trace contract', () => {
  it.each([
    { label: 'complete', cache: { read: 2, write: 0 }, input: 12 },
    { label: 'missing', cache: undefined, input: 10 },
    { label: 'null', cache: null, input: 10 },
    { label: 'partial', cache: { read: 2 }, input: 12 },
  ])('converts two model steps and parallel tools with $label cache into one trace', async ({ cache, input }) => {
    const raw: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const now = Date.now() - 20000;
    const model = { id: 'gpt-test', providerID: 'openai' };
    const secret = 'sk-1234567890abcdefghijklmnop';
    const add = (type: string, data: Record<string, unknown> = {}) => events.push({
      id: `evt_synthetic_${events.length}`, type, created: now + events.length * 100,
      data: { sessionID: 'ses_synthetic', ...data },
    });
    add('session.execution.started');
    add('session.step.started', { assistantMessageID: 'msg_first', model, agent: 'build', started: now + 100 });
    for (const id of ['tool_a', 'tool_b']) {
      add('session.tool.input.started', { assistantMessageID: 'msg_first', id, name: 'read' });
      add('session.tool.called', { assistantMessageID: 'msg_first', id, input: { path: 'synthetic.txt' } });
    }
    add('session.step.streamed', { assistantMessageID: 'msg_first' });
    for (const id of ['tool_b', 'tool_a']) add('session.tool.success', { assistantMessageID: 'msg_first', id, content: [{ type: 'text', text: `synthetic result ${secret}` }] });
    const tokens = { input: 10, output: 5, reasoning: 0, ...(cache === undefined ? {} : { cache }) };
    add('session.step.ended', { assistantMessageID: 'msg_first', finish: 'tool-calls', tokens, cost: 0 });
    add('session.step.started', { assistantMessageID: 'msg_last', model, agent: 'build', started: now + events.length * 100 });
    add('session.text.ended', { assistantMessageID: 'msg_last', ordinal: 0, text: `synthetic answer ${secret}` });
    add('session.step.ended', { assistantMessageID: 'msg_last', finish: 'stop', tokens, cost: 0 });
    add('session.execution.succeeded');
    let done!: () => void;
    const drained = new Promise<void>(resolve => { done = resolve; });
    const cleanup = await setupV2({
      location: { directory: '/synthetic/project' },
      session: { hook: async (_name: string, cb: (event: unknown) => void) => { cb({ sessionID: 'ses_synthetic', system: [{ text: 'synthetic system' }], messages: [{ role: 'user', content: 'synthetic input' }] }); } },
      event: { async *subscribe() { for (const event of events) yield event; done(); } },
    }, {
      common: (id: string, state: { currentTurn?: { turnId: string; traceId: string } }) => ({
        'user.id': 'synthetic-user', 'gen_ai.agent.type': 'opencode', 'gen_ai.session.id': id,
        'gen_ai.turn.id': state.currentTurn?.turnId, trace_id: state.currentTurn?.traceId,
      }),
      writeRecord: (record: Record<string, unknown>) => raw.push(record), writeError: (where: string, error: unknown) => { throw new Error(`${where}: ${error}`); },
      inferProviderName: (id: string) => id, recordUpstreamEnvOnce() {},
    });
    await drained; cleanup();
    const normalized = (await Promise.all(raw.map(record => transformHookRecord(record, ClientType.OpenCode, 'opencode')))).filter((r): r is AgentActivityEntry => r !== null);
    expect(normalized.every(r => r['agent.opencode.collection'] === 'v2')).toBe(true);
    const masked = normalized.map(r => maskAgentActivityEntry(r, { mode: 'all', types: [], replacementMode: 'placeholder' }));
    expect(JSON.stringify(masked)).toContain('synthetic answer');
    expect(JSON.stringify(masked)).toContain('synthetic result');
    expect(JSON.stringify(masked)).not.toContain(secret);
    const nextRequest = masked.filter(r => r['event.name'] === 'llm.request')[1];
    const deltas = nextRequest['gen_ai.input.messages_delta'] as Array<{ role: string; parts: Array<{ id?: string; response?: unknown }> }>;
    for (const message of deltas.filter(m => m.role === 'tool')) {
      const part = message.parts[0];
      const result = masked.find(r => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === part.id);
      expect(part.response).toEqual(result!['gen_ai.tool.call.result']);
      expect(Array.isArray(part.response)).toBe(true);
    }
    expect(deltas.filter(m => m.role === 'tool')).toHaveLength(2);
    const spans: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true,
      endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }], protocol: 'http/protobuf', serviceName: 'synthetic-v2',
    }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(masked);
      expect(JSON.stringify(spans.map(s => s.attributes))).toContain('synthetic answer');
      expect(JSON.stringify(spans.map(s => s.attributes))).not.toContain(secret);
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
      const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llms).toHaveLength(2);
      const tools = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
      expect(tools).toHaveLength(2);
      expect(tools.map(s => s.attributes['gen_ai.tool.call.id']).sort()).toEqual(['tool_a', 'tool_b']);
      expect(llms.every(s => s.attributes['gen_ai.usage.input_tokens'] === input)).toBe(true);
      expect([...llms, ...tools].every(s => s.duration[0] * 1e9 + s.duration[1] > 0)).toBe(true);
      const ids = new Set(spans.map(s => s.spanContext().spanId));
      expect(ids.size).toBe(spans.length);
      // ENTRY may retain an incoming/external parent; every descendant must
      // resolve inside the exported tree.
      for (const span of spans) if (span.attributes['gen_ai.span.kind'] !== 'ENTRY' && span.parentSpanId) {
        expect(ids.has(span.parentSpanId), JSON.stringify(spans.map(s => ({ kind: s.attributes['gen_ai.span.kind'], id: s.spanContext().spanId, parent: s.parentSpanId })))).toBe(true);
      }
      const count = spans.length;
      await flusher.sendBatch(masked);
      expect(spans).toHaveLength(count);
    } finally { await flusher.shutdown(); }
  });

  it.each(['session.execution.interrupted', 'session.execution.failed', 'session.deleted'])(
    'keeps both parallel tool pairs through real trace preparation/conversion on %s', async terminal => {
      const raw: Record<string, unknown>[] = [];
      const events: Record<string, unknown>[] = [];
      const now = Date.now() - 20000;
      const add = (type: string, data: Record<string, unknown> = {}) => events.push({
        id: `evt_parallel_${events.length}`, type, created: now + events.length * 100,
        data: { sessionID: 'ses_parallel', ...data },
      });
      add('session.execution.started');
      add('session.step.started', { assistantMessageID: 'msg_parallel', model: { id: 'gpt-test', providerID: 'openai' }, agent: 'build', started: now + 100 });
      for (const id of ['tool_a', 'tool_b']) {
        add('session.tool.input.started', { assistantMessageID: 'msg_parallel', id, name: 'read' });
        add('session.tool.called', { assistantMessageID: 'msg_parallel', id, input: { path: 'synthetic.txt' } });
      }
      add(terminal, terminal.endsWith('failed') ? { error: { name: 'APIError' } } : { reason: 'user' });
      let done!: () => void;
      const drained = new Promise<void>(resolve => { done = resolve; });
      const cleanup = await setupV2({
        location: { directory: '/synthetic/project' },
        session: { hook: async () => ({ dispose() {} }) },
        event: { async *subscribe() { for (const event of events) yield event; done(); } },
      }, {
        common: (id: string, state: { currentTurn?: { turnId: string; traceId: string } }) => ({
          'user.id': 'synthetic-user', 'gen_ai.agent.type': 'opencode', 'gen_ai.session.id': id,
          'gen_ai.turn.id': state.currentTurn?.turnId, trace_id: state.currentTurn?.traceId,
        }),
        writeRecord: (record: Record<string, unknown>) => raw.push(record),
        writeError: (where: string, error: unknown) => { throw new Error(`${where}: ${error}`); },
        inferProviderName: (id: string) => id, recordUpstreamEnvOnce() {},
      });
      await drained; cleanup();
      const normalized = (await Promise.all(raw.map(r => transformHookRecord(r, ClientType.OpenCode, 'opencode'))))
        .filter((r): r is AgentActivityEntry => r !== null);
      const prepared = prepareTraceEvents(normalized);
      expect(prepared.filter(r => r['event.name'] === 'tool.result')).toHaveLength(2);
      expect(new Set(normalized.map(r => r['event.id'])).size).toBe(normalized.length);
      const spans: ReadableSpan[] = [];
      const flusher = new OtlpTraceFlusher({ enabled: true,
        endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }], protocol: 'http/protobuf', serviceName: 'parallel-v2',
      }, undefined, () => ({
        export(batch, callback) { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {},
      }));
      try {
        await flusher.sendBatch(normalized);
        const tools = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
        expect(tools.map(s => s.attributes['gen_ai.tool.call.id']).sort()).toEqual(['tool_a', 'tool_b']);
        expect(tools.every(s => s.duration[0] * 1e9 + s.duration[1] > 0)).toBe(true);
        expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
        expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
        expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
        const count = spans.length;
        await flusher.sendBatch(normalized);
        expect(spans).toHaveLength(count);
      } finally { await flusher.shutdown(); }
    },
  );
});
