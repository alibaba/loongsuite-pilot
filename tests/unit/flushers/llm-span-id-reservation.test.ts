import { describe, it, expect } from 'vitest';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { convertEventLogToTrace, ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import type { EventLogRecord } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import {
  attachReservedLlmSpanIds,
  ReservedSpanIdGenerator,
} from '../../../src/flushers/span-id-reservation.js';

// The claude-code fetch preload advertises a minted span id to the LLM gateway
// as traceparent parent-id. The converter therefore has to export the LLM span
// under that exact id, or the gateway's spans parent to nothing.

const SID = 'ses_llm_reservation';
const RESERVED = 'd0d0d0d0d0d0d0d0';

function buildTurn(opts: { responseId?: string; spanId?: string } = {}): AgentActivityEntry[] {
  const { responseId = 'msg_reserved', spanId = RESERVED } = opts;
  const base = {
    trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
    'gen_ai.session.id': SID,
    'gen_ai.turn.id': `${SID}:t1`,
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.provider.name': 'anthropic',
  };
  const t0 = Date.now() * 1e6;
  return [
    {
      ...base,
      time_unix_nano: String(t0),
      'event.id': 'e-other',
      'event.name': 'other',
      span_id: 'a1a1a1a1a1a1a1a1',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }],
    },
    {
      ...base,
      time_unix_nano: String(t0 + 1e6),
      'event.id': 'e-req',
      'event.name': 'llm.request',
      'gen_ai.step.id': `${SID}:t1:s1`,
      span_id: spanId,
      parent_span_id: 'c3c3c3c3c3c3c3c3',
      'gen_ai.response.id': responseId,
      'gen_ai.request.model': 'claude',
    },
    {
      ...base,
      time_unix_nano: String(t0 + 2e6),
      'event.id': 'e-resp',
      'event.name': 'llm.response',
      'gen_ai.step.id': `${SID}:t1:s1`,
      span_id: spanId,
      parent_span_id: 'c3c3c3c3c3c3c3c3',
      'gen_ai.response.id': responseId,
      'gen_ai.request.model': 'claude',
      'gen_ai.response.model': 'claude',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
    },
  ] as unknown as AgentActivityEntry[];
}

async function convert(records: AgentActivityEntry[]) {
  const inMem = new InMemorySpanExporter();
  const idGenerator = new ReservedSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(inMem)],
  });
  const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
  const llmSpanIds = attachReservedLlmSpanIds(handler, idGenerator);
  llmSpanIds.prepare(records);
  convertEventLogToTrace(records as unknown as EventLogRecord[], { handler, strict: false });
  llmSpanIds.clear();
  await provider.forceFlush();
  const spans = inMem.getFinishedSpans();
  await provider.shutdown();
  return spans;
}

describe('LLM span id reservation against the real converter', () => {
  it('exports the LLM span under the reserved id', async () => {
    const spans = await convert(buildTurn());
    const llm = spans.filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llm).toHaveLength(1);
    expect(llm[0].spanContext().spanId).toBe(RESERVED);
  });

  it('leaves every other span on a random id', async () => {
    const spans = await convert(buildTurn());
    const others = spans
      .filter((s) => s.attributes['gen_ai.span.kind'] !== 'LLM')
      .map((s) => s.spanContext().spanId);
    expect(others.length).toBeGreaterThan(0);
    expect(others).not.toContain(RESERVED);
    expect(new Set(others).size).toBe(others.length);
  });

  it('falls back to a random id when the record carries no response id', async () => {
    const records = buildTurn().map((r) => {
      const copy = { ...r } as Record<string, unknown>;
      delete copy['gen_ai.response.id'];
      return copy;
    }) as unknown as AgentActivityEntry[];
    const spans = await convert(records);
    const llm = spans.filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llm).toHaveLength(1);
    expect(llm[0].spanContext().spanId).not.toBe(RESERVED);
  });

  it('refuses an invalid reserved span id rather than exporting it', async () => {
    const spans = await convert(buildTurn({ spanId: '0'.repeat(16) }));
    const llm = spans.filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llm).toHaveLength(1);
    expect(llm[0].spanContext().spanId).not.toBe('0'.repeat(16));
    expect(llm[0].spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not leak a reservation to the next unrelated span', async () => {
    // Two calls, only the first reserved: the second must not inherit it.
    const first = buildTurn({ responseId: 'msg_a', spanId: RESERVED });
    const second = buildTurn({ responseId: 'msg_b', spanId: 'not-a-span-id' })
      .filter((r) => r['event.name'] !== 'other')
      .map((r, i) => ({ ...r, 'event.id': `e-second-${i}`, 'gen_ai.step.id': `${SID}:t1:s2` }));
    const spans = await convert([...first, ...second] as unknown as AgentActivityEntry[]);
    const llmIds = spans
      .filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM')
      .map((s) => ({ rid: s.attributes['gen_ai.response.id'], id: s.spanContext().spanId }));
    expect(llmIds).toHaveLength(2);
    expect(llmIds.find((x) => x.rid === 'msg_a')?.id).toBe(RESERVED);
    expect(llmIds.find((x) => x.rid === 'msg_b')?.id).not.toBe(RESERVED);
  });
});
