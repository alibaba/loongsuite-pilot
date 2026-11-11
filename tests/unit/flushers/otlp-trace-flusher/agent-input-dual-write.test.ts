import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { TraceExporterLike } from '../../../../src/flushers/otlp-trace-flusher.js';
import { expandAgentInputEvents } from '../../../../src/normalization/agent-input-dual-write.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

interface CapturedSpan extends ReadableSpan {
  attributes: Record<string, unknown>;
}

function makeConfig() {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf' as const,
    serviceName: 'agent-input-dual-write-test',
    debug: false,
  };
}

function makeCapturingExporter(captured: CapturedSpan[]): TraceExporterLike {
  return {
    export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
      captured.push(...spans as CapturedSpan[]);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  };
}

function makeLegacyTurn(): AgentActivityEntry[] {
  const common = {
    'user.id': 'user-1',
    'gen_ai.session.id': 'session-1',
    'gen_ai.turn.id': 'turn-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.provider.name': 'anthropic',
  } as const;

  return [
    {
      ...common,
      time_unix_nano: '1700000000000000000',
      'event.id': 'input-other',
      'event.name': 'other',
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
      ],
    },
    {
      ...common,
      time_unix_nano: '1700000000100000000',
      'event.id': 'request',
      'event.name': 'llm.request',
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'response-1',
      'gen_ai.request.model': 'claude-test',
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
      ],
    },
    {
      ...common,
      time_unix_nano: '1700000001000000000',
      'event.id': 'response',
      'event.name': 'llm.response',
      'gen_ai.step.id': 'step-1',
      'gen_ai.response.id': 'response-1',
      'gen_ai.response.model': 'claude-test',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.output.messages': [
        { role: 'assistant', parts: [{ type: 'text', content: 'world' }] },
      ],
    },
  ];
}

async function convert(records: AgentActivityEntry[], captureMessageContent?: boolean): Promise<CapturedSpan[]> {
  const captured: CapturedSpan[] = [];
  const flusher = new OtlpTraceFlusher(
    { ...makeConfig(), captureMessageContent },
    undefined,
    () => makeCapturingExporter(captured),
  );
  await flusher.sendBatch(records);
  await flusher.shutdown();
  return captured;
}

function semanticSnapshot(spans: CapturedSpan[]) {
  const kindBySpanId = new Map(
    spans.map(span => [
      span.spanContext().spanId,
      String(span.attributes['gen_ai.span.kind'] ?? 'UNKNOWN'),
    ]),
  );

  return spans
    .map(span => ({
      name: span.name,
      kind: String(span.attributes['gen_ai.span.kind'] ?? 'UNKNOWN'),
      parentKind: span.parentSpanId ? kindBySpanId.get(span.parentSpanId) ?? null : null,
      attributes: Object.fromEntries(
        Object.entries(span.attributes).sort(([left], [right]) => left.localeCompare(right)),
      ),
    }))
    .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
}

describe('OtlpTraceFlusher agent.input compatibility dual-write', () => {
  it('honors captureMessageContent=false despite pre-existing OTel capture environment', async () => {
    const stability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const capture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const source = makeLegacyTurn();
      const enabled = await convert(source);
      const disabled = await convert(source, false);
      const enabledAttributes = JSON.stringify(enabled.map(span => span.attributes));
      const disabledAttributes = JSON.stringify(disabled.map(span => span.attributes));
      expect(enabledAttributes).toContain('hello');
      expect(enabledAttributes).toContain('world');
      expect(disabled).toHaveLength(enabled.length);
      expect(disabledAttributes).not.toContain('hello');
      expect(disabledAttributes).not.toContain('world');
      for (const span of disabled) {
        expect(span.attributes).not.toHaveProperty('gen_ai.input.messages');
        expect(span.attributes).not.toHaveProperty('gen_ai.output.messages');
      }
      expect(source[0]['gen_ai.input.messages_delta']).toBeDefined();
    } finally {
      if (stability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = stability;
      if (capture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = capture;
    }
  });

  it('preserves real converter Span semantics at the compatibility boundary', async () => {
    const legacy = makeLegacyTurn();
    const expanded = expandAgentInputEvents(legacy);
    expect(expanded.map(entry => entry['event.name'])).toEqual([
      'other',
      'agent.input',
      'llm.request',
      'llm.response',
    ]);

    const legacySpans = await convert(legacy);
    const expandedSpans = await convert(expanded);

    expect(legacySpans.length).toBeGreaterThan(0);
    expect(expandedSpans).toHaveLength(legacySpans.length);
    expect(semanticSnapshot(expandedSpans)).toEqual(semanticSnapshot(legacySpans));

    const kinds = expandedSpans.map(span => span.attributes['gen_ai.span.kind']);
    expect(kinds.filter(kind => kind === 'ENTRY')).toHaveLength(1);
    expect(kinds.filter(kind => kind === 'AGENT')).toHaveLength(1);
    expect(new Set(expandedSpans.map(span => span.spanContext().spanId)).size)
      .toBe(expandedSpans.length);
  });
});
