import { describe, expect, it, vi } from 'vitest';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const secret = 'Confidential customer acquisition terms: discount 37 percent';

describe('OTLP guardrail reason content policy', () => {
  it.each([false, true])('enforces captureMessageContent=%s after span enrichment, including span events', async capture => {
    const captured: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({
      enabled: true, endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
      protocol: 'http/protobuf', serviceName: 'guardrail-content-test', captureMessageContent: capture,
    }, undefined, () => ({
      export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
        captured.push(...spans);
        done({ code: ExportResultCode.SUCCESS });
      },
      async shutdown() {},
    }));
    const metadata = { 'gen_ai.guardrail.action': 'block', 'gen_ai.guardrail.rule_id': 'business-policy',
      'gen_ai.guardrail.rule_version': '2' };
    vi.spyOn((flusher as any).spanEnrichers, 'enrich').mockImplementation(async (spans: unknown) => {
      for (const span of spans as ReadableSpan[]) {
        Object.assign(span.attributes, metadata, { 'gen_ai.guardrail.reason': secret });
        (span.events as Array<unknown>).push({ name: 'guardrail.result', time: span.endTime,
          attributes: { ...metadata, 'gen_ai.guardrail.reason': secret } });
      }
      return spans;
    });
    const common = { 'gen_ai.agent.type': 'claude-code', 'gen_ai.session.id': 'session',
      'gen_ai.turn.id': 'turn', 'gen_ai.step.id': 'step', 'gen_ai.response.id': 'response',
      'gen_ai.provider.name': 'anthropic', 'user.id': 'user' };
    try {
      await flusher.sendBatch([
        { ...common, time_unix_nano: '1700000000000000000', 'event.id': 'request', 'event.name': 'llm.request',
          'gen_ai.request.model': 'test-model', 'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'hello' }] }],
        },
        { ...common, time_unix_nano: '1700000001000000000', 'event.id': 'response', 'event.name': 'llm.response',
          'gen_ai.response.model': 'test-model', 'gen_ai.response.finish_reasons': ['stop'],
          'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'world' }] }],
        },
      ] as AgentActivityEntry[]);
      await flusher.flush();
      expect(captured.length).toBeGreaterThan(0);
      for (const span of captured) {
        expect(span.attributes).toMatchObject(metadata);
        const event = span.events.find(item => item.name === 'guardrail.result')!;
        expect(event.attributes).toMatchObject(metadata);
        if (capture) {
          expect(span.attributes['gen_ai.guardrail.reason']).toBe(secret);
          expect(event.attributes!['gen_ai.guardrail.reason']).toBe(secret);
        } else {
          expect(span.attributes).not.toHaveProperty('gen_ai.guardrail.reason');
          expect(event.attributes).not.toHaveProperty('gen_ai.guardrail.reason');
        }
      }
    } finally {
      await flusher.shutdown();
    }
  });
});
