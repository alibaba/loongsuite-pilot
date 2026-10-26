import { describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine, doubaoToolLine } from '../../../helpers/doubao-work-fixture.js';
import { DOUBAO_NATIVE_FILES } from '../../../helpers/doubao-work-fixture.js';
import { buildNativeToolFragment, parseNativeGraph } from '../../../../src/inputs/doubao-work/doubao-work-native.js';
import { doubaoRootAgentSpanId } from '../../../../src/inputs/doubao-work/doubao-work-log.js';

describe('Doubao Work task-level OTLP', () => {
  it('exports late nested AGENT fragments with precise real tool intervals and native parents', async () => {
    const root = { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH,
      terminal: parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)! };
    const pair = {
      start: parseDoubaoLogLine(doubaoToolLine({ agent_id: 's_nativeLeaf', tcid: 'late-call' }, 6000, 111).trimEnd(), DOUBAO_FILE)!,
      end: parseDoubaoLogLine(doubaoToolLine({ toolCallID: 'late-call', status: 'success', phase: 'execution_settled' }, 6000, 777).trimEnd(), DOUBAO_FILE)!,
    };
    const events = buildDoubaoTaskEvents('native-scope', root, root.terminal, Date.now());
    const child = buildNativeToolFragment('native-scope', root, parseNativeGraph(DOUBAO_NATIVE_FILES)!, pair, Date.now());
    const spans: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }], serviceName: 'doubao-native-unit' }, undefined, () => ({
      export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(events); await vi.waitFor(() => expect(spans).toHaveLength(2));
      await flusher.sendBatch(child); await vi.waitFor(() => expect(spans).toHaveLength(5));
      const rootAgent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT' && span.attributes['gen_ai.agent.id'] === 'doubao-work')!;
      const leaf = spans.find(span => span.attributes['gen_ai.agent.id'] === 's_nativeLeaf' && span.attributes['gen_ai.span.kind'] === 'AGENT')!;
      const organizer = spans.find(span => span.attributes['gen_ai.agent.id'] === 'o_nativeOrg' && span.attributes['gen_ai.span.kind'] === 'AGENT')!;
      const tool = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL')!;
      expect(rootAgent.spanContext().spanId).toBe(doubaoRootAgentSpanId(events[0].trace_id!));
      expect(organizer.parentSpanId).toBe(rootAgent.spanContext().spanId);
      expect(leaf.parentSpanId).toBe(organizer.spanContext().spanId);
      expect(tool.parentSpanId).toBe(leaf.spanContext().spanId);
      const nanos = (time: number[]) => BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
      for (const span of [organizer, leaf, tool]) {
        expect(span.spanContext().traceId).toBe(events[0].trace_id);
        expect(nanos(span.startTime).toString()).toBe(pair.start.timeNano);
        expect(nanos(span.endTime).toString()).toBe(pair.end.timeNano);
        expect(nanos(span.duration)).toBe(666000n);
      }
      expect(nanos(rootAgent.endTime)).toBeLessThan(nanos(leaf.startTime));
      expect(leaf.attributes['loongsuite.doubao_work.timing_basis']).toBe('own_local_tool');
      expect(organizer.attributes['loongsuite.doubao_work.timing_basis']).toBe('descendant_local_tool');
      expect(leaf.attributes['loongsuite.doubao_work.native_creation_call_id']).toBe('native-child-create');
      expect(JSON.stringify(spans.map(span => span.attributes))).not.toMatch(/SYNTHETIC_PRIVATE|gen_ai\.request\.model|gen_ai\.usage/);
    } finally { await flusher.shutdown(); }
  });
  it('exports precise parallel TOOL children with no inferred STEP or LLM and no payload', async () => {
    const terminal = parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!;
    const tool = (data: Record<string, unknown>, ms: number, micros = 123) => parseDoubaoLogLine(doubaoToolLine(data, ms, micros).trimEnd(), DOUBAO_FILE)!;
    const pairs = [
      { start: tool({ tcid: 'parallel-a' }, 200), end: tool({ toolCallID: 'parallel-a', status: 'success', phase: 'execution_settled' }, 200, 456) },
      { start: tool({ tcid: 'parallel-b', name: 'Bash' }, 199), end: tool({ toolCallID: 'parallel-b', name: 'Bash', status: 'error', phase: 'execution_settled', error_message: 'PRIVATE' }, 220) },
    ];
    const events = buildDoubaoTaskEvents('synthetic-profile', {
      turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH,
      selectedSkills: ['synthetic-analysis'],
    }, terminal, Date.now(), pairs).map(entry => ({ ...entry, 'user.id': 'synthetic-user' }));
    const exported: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }], serviceName: 'doubao-unit' }, undefined, () => ({
      export: (spans, callback) => { exported.push(...spans); callback({ code: 0 }); }, shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(events);
      await vi.waitFor(() => expect(exported).toHaveLength(4));
      await flusher.flush();
      expect(exported).toHaveLength(4);
      expect(exported.map(s => s.attributes['gen_ai.span.kind']).sort()).toEqual(['AGENT', 'ENTRY', 'TOOL', 'TOOL']);
      const agent = exported.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
      expect(agent.attributes['loongsuite.doubao_work.selected_skills']).toEqual(['synthetic-analysis']);
      const nano = (time: number[]) => BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]);
      for (const pair of pairs) {
        const span = exported.find(s => s.attributes['gen_ai.tool.call.id'] === pair.start.tool!.id)!;
        expect(span.parentSpanId).toBe(agent.spanContext().spanId);
        expect(nano(span.startTime).toString()).toBe(pair.start.timeNano);
        expect(nano(span.endTime).toString()).toBe(pair.end.timeNano);
        expect(nano(span.duration)).toBe(BigInt(pair.end.timeNano) - BigInt(pair.start.timeNano));
        expect(span.attributes['loongsuite.doubao_work.tool_boundary']).toBe('client_received_to_execution_settled');
        expect(span.status.code).toBe(pair.end.tool!.status === 'success' ? 0 : 2);
      }
      expect(exported.find(s => s.attributes['gen_ai.tool.call.id'] === 'parallel-a')!.attributes['gen_ai.tool.call.duration']).toBe(0.333);
      expect(JSON.stringify(exported.map(s => s.attributes))).not.toMatch(/PRIVATE|gen_ai\.usage|gen_ai\.request\.model|gen_ai\.tool\.call\.(arguments|result)/);
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
