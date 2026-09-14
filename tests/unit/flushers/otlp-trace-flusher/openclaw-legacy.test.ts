import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';

describe('legacy OpenClaw exported diagnostics', () => {
  it('preserves inference/incomplete flags on final spans without contaminating another turn', async () => {
    const exported: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf',
      serviceName: 'openclaw-test', endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    }, undefined, () => ({ export(spans, callback) { exported.push(...spans); callback({ code: 0 }); }, shutdown: async () => {} }));
    const entries: AgentActivityEntry[] = [];
    for (const incomplete of [true, false]) {
      const base = { trace_id: incomplete ? '1234567890abcdef1234567890abcdef' : 'abcdef1234567890abcdef1234567890',
        'gen_ai.turn.id': incomplete ? 'incomplete' : 'complete', 'gen_ai.agent.type': 'openclaw',
        'agent.openclaw.compatibility': 'legacy', 'gen_ai.session.id': 'session', 'user.id': 'test' };
      const event = (name: string, offset: number, fields = {}) => ({ ...base, 'event.name': name,
        time_unix_nano: `${Date.parse('2026-09-01T00:00:00Z') + offset}000000`, ...fields } as AgentActivityEntry);
      entries.push(event('other', 0, { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'test' }] }] }),
        event('llm.request', 1, { 'gen_ai.step.id': 's', 'gen_ai.response.id': 'r', 'gen_ai.request.model': 'test',
          'agent.openclaw.timing.inferred': true, 'agent.openclaw.timing.quantized_ms': 1 }),
        event('llm.response', 2, { 'gen_ai.step.id': 's', 'gen_ai.response.id': 'r', 'gen_ai.response.model': 'test' }),
        event('other', 3, incomplete ? { 'agent.openclaw.hook': 'legacy_cleanup', 'gen_ai.turn.end': true,
          'agent.openclaw.collection.incomplete': true, 'agent.openclaw.collection.end_reason': 'capacity_evicted' }
          : { 'agent.openclaw.hook': 'llm_output' }));
    }
    try { await flusher.sendBatch(entries); } finally { await flusher.shutdown(); }
    expect(exported.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(2);
    for (const span of exported) {
      const incomplete = span.spanContext().traceId === '1234567890abcdef1234567890abcdef';
      expect(span.attributes['agent.openclaw.collection.incomplete']).toBe(incomplete ? true : undefined);
      expect(span.attributes['agent.openclaw.success']).toBeUndefined();
      expect(span.attributes['error.type']).toBeUndefined();
      if (span.attributes['gen_ai.span.kind'] === 'LLM') {
        expect(span.attributes['agent.openclaw.timing.inferred']).toBe(true);
        expect(span.attributes['agent.openclaw.timing.quantized_ms']).toBe(1);
      }
    }
    expect(entries[0]['agent.openclaw.collection.incomplete']).toBeUndefined();
  });
});
