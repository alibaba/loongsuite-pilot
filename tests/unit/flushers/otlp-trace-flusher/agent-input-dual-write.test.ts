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

async function convert(records: AgentActivityEntry[]): Promise<CapturedSpan[]> {
  const captured: CapturedSpan[] = [];
  const flusher = new OtlpTraceFlusher(
    makeConfig(),
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
