import { describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../../../helpers/doubao-work-fixture.js';

describe('Doubao Work task-level OTLP', () => {
  it.each(['1', '0', 'cancelled'])('exports only one accurately timed ENTRY/AGENT pair (client=%s)', async result => {
    const terminal = parseDoubaoLogLine(doubaoLine('on_message_session_end', {
      session_success: result === '0' ? '0' : '1',
      ...(result === 'cancelled' ? { cancel_source: 'stop_button' } : {}),
    }), DOUBAO_FILE)!;
    const events = buildDoubaoTaskEvents('synthetic-profile', {
      turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH, conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH,
    }, terminal, Date.now()).map(entry => ({ ...entry, 'user.id': 'synthetic-user' }));
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
        expect(duration).toBe(3_000_000_000n); // util currently has millisecond precision.
        expect(span.resource.attributes['gen_ai.framework']).toBe('doubao-work');
        expect(span.resource.attributes['gen_ai.agent.system']).toBe('doubao');
        expect(span.resource.attributes['loongsuite.doubao_work.business_outcome']).toBe('unknown');
        expect(span.resource.attributes['loongsuite.doubao_work.observation_scope']).toBe('client_message');
        expect(Object.keys(span.attributes).filter(k => k.startsWith('gen_ai.usage.') || k === 'gen_ai.request.model')).toEqual([]);
        expect(span.status.code).toBe(result === '1' ? 0 : 2);
      }
      const root = exported.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')!;
      const agent = exported.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
      expect(agent.parentSpanId).toBe(root.spanContext().spanId);
      expect(root.spanContext().traceId).toBe(events[0].trace_id);
    } finally { await flusher.shutdown(); }
  });
});
