import { describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { buildDoubaoTaskEvents, doubaoRootAgentSpanId, parseDoubaoLogLine } from '../../../../src/inputs/doubao-work/doubao-work-log.js';
import { buildNativeExecutionEvents, nativeExecutionSpanId, type NativeExecution } from '../../../../src/inputs/doubao-work/doubao-work-execution.js';
import { parseNativeGraph } from '../../../../src/inputs/doubao-work/doubao-work-native.js';
import { nativeToolObservations } from '../../../../src/inputs/doubao-work/doubao-work-content.js';
import { createReadableSpanToOtlpSpanJsonArray } from '../../../../src/flushers/otlp-json-serializer.js';
import { maskAgentActivityEntry } from '../../../../src/mask/entry-masker.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, DOUBAO_NATIVE_FILES, doubaoFirstOutputLine, doubaoLine, doubaoToolLine } from '../../../helpers/doubao-work-fixture.js';

const nano = (t: number[]) => BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
function collector(spans: ReadableSpan[]) {
  return new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }], serviceName: 'doubao-semantics' }, undefined, () => ({
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
}
function localPair(actor = 'synthetic-turn', call = 'synthetic-call', start = 1000, end = 1100) {
  return {
    start: parseDoubaoLogLine(doubaoToolLine({ agent_id: actor, tcid: call }, start, 111).trimEnd(), DOUBAO_FILE)!,
    end: parseDoubaoLogLine(doubaoToolLine({ toolCallID: call, status: 'success', phase: 'execution_settled' }, end, 777).trimEnd(), DOUBAO_FILE)!,
  };
}

describe('Doubao Work truthful partial OTLP', () => {
  it('keeps local tool facts on the real request without fabricating LLM or ReAct spans', async () => {
    const pair = localPair();
    const firstOutput = parseDoubaoLogLine(doubaoFirstOutputLine(), DOUBAO_FILE)!;
    const records = buildDoubaoTaskEvents('scope', { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH,
      conversationId: '12345678', updatedMs: DOUBAO_EPOCH, firstOutput },
      parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!, Date.now(), [pair]);
    records[0]['gen_ai.input.messages_delta'] = [{ role: 'user', parts: [{ type: 'text', content: 'synthetic user input' }] }];
    records.at(-1)!['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: 'synthetic final answer' }] }];
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch(records); await vi.waitFor(() => expect(spans).toHaveLength(2));
      const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
      expect(agent.events.map(event => event.name)).toEqual(['gen_ai.tool.call', 'gen_ai.tool.result']);
      expect(agent.events.map(event => nano(event.time).toString())).toEqual([pair.start.timeNano, pair.end.timeNano]);
      expect(agent.attributes['gen_ai.input.messages']).toContain('synthetic user input');
      expect(agent.attributes['gen_ai.output.messages']).toContain('synthetic final answer');
      expect(agent.attributes['loongsuite.doubao_work.trace_completeness']).toBe('client_request_and_local_events');
      expect(agent.attributes['loongsuite.doubao_work.client_time_to_first_cot_ms']).toBe(1000);
      expect(spans.some(span => ['LLM', 'STEP', 'TOOL'].includes(String(span.attributes['gen_ai.span.kind'])))).toBe(false);
      expect(JSON.stringify(spans.map(span => span.attributes))).not.toMatch(/gen_ai.request.model|gen_ai.usage/);
      await flusher.flush(); expect(spans).toHaveLength(2);
    } finally { await flusher.shutdown(); }
  });

  it('exports one linked local TASK per execution, with child observations owned by the correct TASK', async () => {
    const conv = '12345678', query = '00000000-0000-4000-8000-000000000002';
    const root = { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: conv, localMessageId: query, updatedMs: DOUBAO_EPOCH,
      terminal: { ...parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!, conversationId: conv } };
    const parent: NativeExecution = { executionKey: '00000000-0000-4000-8000-000000000001', conversationId: conv, queryMessageId: query,
      agentId: 'o_nativeOrg', agentType: 'organizer', sandboxId: 'synthetic-sandbox', startedAtMs: DOUBAO_EPOCH + 4000, endedAtMs: DOUBAO_EPOCH + 9000 };
    const leaf: NativeExecution = { ...parent, executionKey: '00000000-0000-4000-8000-000000000003', agentId: 's_nativeLeaf', agentType: 'sub_agent',
      startedAtMs: DOUBAO_EPOCH + 5000, endedAtMs: DOUBAO_EPOCH + 8000 };
    const pair = localPair(leaf.agentId, 'child-tool', 6000, 6500);
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch(buildDoubaoTaskEvents('scope', root, root.terminal, Date.now()));
      for (const execution of [parent, leaf]) {
        const records = buildNativeExecutionEvents('scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, execution, [parent, leaf], Date.now());
        if (execution === leaf) records[0]['agent.doubao_work.tool_observations'] = nativeToolObservations([pair]);
        await flusher.sendBatch(records);
      }
      await vi.waitFor(() => expect(spans).toHaveLength(4));
      const tasks = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TASK');
      expect(tasks).toHaveLength(2);
      expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
      const owner = tasks.find(span => span.attributes['gen_ai.agent.id'] === leaf.agentId)!;
      const organizer = tasks.find(span => span.attributes['gen_ai.agent.id'] === parent.agentId)!;
      expect(organizer.parentSpanId).toBeUndefined();
      expect(organizer.links[0].context.spanId).toBe(doubaoRootAgentSpanId(organizer.spanContext().traceId));
      expect(owner.parentSpanId).toBe(nativeExecutionSpanId('scope', parent.executionKey));
      expect(owner.events.map(event => event.attributes?.['gen_ai.tool.call.id'])).toEqual(['child-tool', 'child-tool']);
      expect(organizer.events).toHaveLength(0);
      const diagnostics = createReadableSpanToOtlpSpanJsonArray([organizer, owner]).map(line => JSON.parse(line));
      expect(diagnostics[0].links[0].spanId).toBe(organizer.links[0].context.spanId);
      expect(diagnostics[1].events[0].timeUnixNano).toBe(pair.start.timeNano);
      expect(diagnostics[1].events[1].attributes['gen_ai.tool.call.id']).toBe('child-tool');
      for (const e of [parent, leaf]) {
        const task = tasks.find(span => span.attributes['loongsuite.doubao_work.native_execution_id'] === e.executionKey)!;
        expect(nano(task.startTime)).toBe(BigInt(e.startedAtMs) * 1_000_000n);
        expect(nano(task.endTime)).toBe(BigInt(e.endedAtMs) * 1_000_000n);
        expect(task.status.code).toBe(0);
      }
      await flusher.flush(); expect(spans).toHaveLength(4);
    } finally { await flusher.shutdown(); }
  });

  it('does not let a late local execution or log-only tools truncate an active request in the same session', async () => {
    const query = '00000000-0000-4000-8000-000000000002';
    const root = { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: '12345678', localMessageId: query, updatedMs: DOUBAO_EPOCH,
      terminal: parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)! };
    const records = buildDoubaoTaskEvents('scope', root, root.terminal, Date.now());
    const execution: NativeExecution = { executionKey: '00000000-0000-4000-8000-000000000001', conversationId: '12345678', queryMessageId: query,
      agentId: 'o_nativeOrg', agentType: 'organizer', sandboxId: 'synthetic-sandbox', startedAtMs: DOUBAO_EPOCH + 4000, endedAtMs: DOUBAO_EPOCH + 9000 };
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch(records.slice(0, 1));
      await flusher.sendBatch([{ ...records[0], 'event.id': 'audit-tool', 'event.name': 'tool.call', 'loongsuite.doubao_work.trace_role': 'log_only' }]);
      await flusher.sendBatch(buildNativeExecutionEvents('scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, execution, [execution], Date.now()));
      expect(spans.map(span => span.attributes['gen_ai.span.kind'])).toEqual(['TASK']);
      await flusher.sendBatch(records.slice(1));
      await vi.waitFor(() => expect(spans).toHaveLength(3));
      expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
    } finally { await flusher.shutdown(); }
  });

  it('bounds tool Span events and reports the collected facts omitted from the Span', async () => {
    const pairs = Array.from({ length: 65 }, (_, i) => localPair('synthetic-turn', `bounded-${i}`, 1000 + i * 2, 1001 + i * 2));
    const records = buildDoubaoTaskEvents('scope', { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH,
      conversationId: '12345678', updatedMs: DOUBAO_EPOCH },
      parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!, Date.now(), pairs);
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    try {
      await flusher.sendBatch(records);
      const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
      expect(agent.events).toHaveLength(128);
      expect(agent.attributes['loongsuite.doubao_work.tool_observations_count']).toBe(64);
      expect(agent.attributes['loongsuite.doubao_work.tool_observations_not_in_span']).toBe(1);
      expect(records.filter(record => record['event.name'] === 'tool.call')).toHaveLength(65);
    } finally { await flusher.shutdown(); }
  });

  it('masks native TASK I/O and nested tool content before Span event projection', () => {
    const key = 'sk-' + 'x'.repeat(24);
    const masked = maskAgentActivityEntry({ time_unix_nano: String(BigInt(DOUBAO_EPOCH) * 1_000_000n),
      'event.id': 'synthetic-mask', 'event.name': 'other', 'user.id': 'test',
      'agent.doubao_work.task_input': key, 'agent.doubao_work.task_output': key,
      'agent.doubao_work.tool_observations': [{ callId: 'call', arguments: JSON.stringify({ key }), result: key }],
    }, { mode: 'all', types: [] });
    expect(JSON.stringify(masked)).not.toContain(key);
    expect(masked['agent.doubao_work.tool_observations']).toBeDefined();
  });

  it('does not reinterpret legacy tool fragments or log-only records as Agent invocations', async () => {
    const spans: ReadableSpan[] = [], flusher = collector(spans);
    const records = buildDoubaoTaskEvents('scope', { turnId: 'legacy-fragment', queryMs: DOUBAO_EPOCH,
      conversationId: '12345678', updatedMs: DOUBAO_EPOCH },
      parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!, Date.now())
      .map(event => ({ ...event, 'loongsuite.doubao_work.observation_scope': 'native_local_tool_fragment' }));
    try {
      await flusher.sendBatch(records); await flusher.flush();
      expect(spans).toHaveLength(0);
      await flusher.sendBatch(records.map(record => ({ ...record, 'loongsuite.doubao_work.trace_role': 'log_only' })));
      await flusher.flush(); expect(spans).toHaveLength(0);
    } finally { await flusher.shutdown(); }
  });
  it.each([
    ['1', undefined], ['0', undefined], ['cancelled', undefined], ['1', '1234567890abcdef'],
  ])('exports only one accurately timed ENTRY/AGENT pair (client=%s, parent=%s)', async (result, parent) => {
    const terminal = parseDoubaoLogLine(doubaoLine('on_message_session_end', {
      session_success: result === '0' ? '0' : '1',
      ...(result === 'cancelled' ? { cancel_source: 'stop_button' } : {}),
    }), DOUBAO_FILE)!;
    const events = buildDoubaoTaskEvents('synthetic-profile', {
      turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH,
    }, terminal, Date.now()).map(entry => ({ ...entry, 'user.id': 'synthetic-user', ...(parent ? { parent_span_id: parent } : {}) }));
    const exported: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({
      enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
      protocol: 'http/protobuf', serviceName: 'doubao-unit',
    }, undefined, () => ({
      export: (spans, callback) => { exported.push(...spans); callback({ code: 0 }); },
      shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(events);
      // An explicit client terminal must schedule export without an idle timeout.
      await vi.waitFor(() => expect(exported).toHaveLength(2));
      await flusher.flush();
      expect(exported).toHaveLength(2);
      expect(exported.map(s => s.attributes['gen_ai.span.kind']).sort()).toEqual(['AGENT', 'ENTRY']);
      for (const span of exported) {
        const duration = BigInt(span.duration[0]) * 1_000_000_000n + BigInt(span.duration[1]);
        expect(duration).toBe(3_000_123_000n); // Preserve the source header's microseconds after conversion.
        expect(span.resource.attributes['gen_ai.framework']).toBe('doubao-work');
        expect(span.attributes['gen_ai.framework']).toBe('doubao-work');
        expect(span.resource.attributes['gen_ai.agent.system']).toBe('doubao');
        expect(span.resource.attributes['loongsuite.doubao_work.business_outcome']).toBe('unknown');
        expect(span.resource.attributes['loongsuite.doubao_work.observation_scope']).toBe('client_message');
        expect(Object.keys(span.attributes).filter(k => k.startsWith('gen_ai.usage.') || k === 'gen_ai.request.model')).toEqual([]);
        expect(span.status.code).toBe(result === '1' ? 0 : 2);
      }
      const root = exported.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')!;
      const agent = exported.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
      expect(agent.parentSpanId).toBe(root.spanContext().spanId);
      expect(root.parentSpanId).toBe(parent);
      expect(root.spanContext().traceId).toBe(events[0].trace_id);
    } finally { await flusher.shutdown(); }
  });
});
