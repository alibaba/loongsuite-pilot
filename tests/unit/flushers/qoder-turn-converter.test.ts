import { describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import { BasicTracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { convertEventLogToReadableSpans, ExtendedTelemetryHandler, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { convertQoderTurn, QODER_TRANSCRIPT_AGENT_TYPES } from '../../../src/flushers/qoder-turn-converter.js';
import { ReservedSpanIdGenerator } from '../../../src/flushers/span-id-reservation.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

const TRACE = '1234567890abcdef1234567890abcdef';
const UPSTREAM = 'abcdef1234567890';
const START = BigInt(Date.now() - 60_000) * 1_000_000n;
function records(agentType: string, parent?: string): AgentActivityEntry[] {
  const base = { trace_id: TRACE, 'gen_ai.agent.type': agentType, 'gen_ai.provider.name': 'qoder',
    'gen_ai.session.id': 'root-test-session', 'gen_ai.turn.id': 'root-test-turn', 'user.id': 'test-user' };
  const event = (name: string, ms: number, extra = {}) => ({ ...base, 'event.id': `${name}-${ms}`,
    'event.name': name, time_unix_nano: String(START + BigInt(ms) * 1_000_000n), ...extra });
  return [
    event('other', 0, { ...(parent ? { parent_span_id: parent } : {}),
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'Read the demo' }] }] }),
    event('llm.request', 10, { 'gen_ai.step.id': 's1', 'gen_ai.response.id': 'r1', 'gen_ai.request.model': 'test-model' }),
    event('llm.response', 20, { 'gen_ai.step.id': 's1', 'gen_ai.response.id': 'r1', 'gen_ai.request.model': 'test-model',
      'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2, 'gen_ai.usage.cache_read.input_tokens': 4,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'Read', arguments: { path: 'demo.txt' } }] }],
      'gen_ai.response.finish_reasons': ['tool_use'] }),
    event('tool.call', 21, { 'gen_ai.step.id': 's1', 'gen_ai.tool.call.id': 't1', 'gen_ai.tool.name': 'Read',
      span_id: 'aaaaaaaaaaaaaaaa', 'gen_ai.tool.call.arguments': { path: 'demo.txt' } }),
    event('tool.result', 30, { 'gen_ai.step.id': 's1', 'gen_ai.tool.call.id': 't1', 'gen_ai.tool.name': 'Read',
      span_id: 'aaaaaaaaaaaaaaaa', 'gen_ai.tool.call.result': 'demo content' }),
    event('llm.request', 31, { 'gen_ai.step.id': 's2', 'gen_ai.response.id': 'r2', 'gen_ai.request.model': 'test-model',
      parent_span_id: 'bbbbbbbbbbbbbbbb' }),
    event('llm.response', 40, { 'gen_ai.step.id': 's2', 'gen_ai.response.id': 'r2', 'gen_ai.request.model': 'test-model',
      'gen_ai.usage.input_tokens': 20, 'gen_ai.usage.output_tokens': 3, 'gen_ai.usage.cache_read.input_tokens': 5,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'demo read' }] }],
      'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.turn.end': true }),
  ] as unknown as AgentActivityEntry[];
}

async function flush(input: AgentActivityEntry[]) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'qoder-root-test',
    endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }], protocol: 'http/protobuf',
  }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
  }));
  try {
    await flusher.sendBatch(input);
    await flusher.flush();
    return spans;
  } finally { await flusher.shutdown(); }
}

describe.each([...QODER_TRANSCRIPT_AGENT_TYPES])('%s roots through the real flusher and SDK', agentType => {
  it('exports a complete root without changing source trace, messages, tools or per-LLM tokens', async () => {
    const input = records(agentType);
    const before = structuredClone(input);
    const spans = await flush(input);
    const entry = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(entry).toHaveLength(1);
    expect(entry[0].parentSpanId).toBeUndefined();
    expect(spans.every(s => s.spanContext().traceId === TRACE)).toBe(true);
    const ids = new Set(spans.map(s => s.spanContext().spanId));
    expect(ids.size).toBe(spans.length);
    for (const span of spans.filter(s => s !== entry[0])) expect(ids.has(span.parentSpanId!)).toBe(true);
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
    const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llms).toHaveLength(2);
    expect(llms.map(s => s.attributes['gen_ai.usage.input_tokens']).sort()).toEqual([10, 20]);
    expect(llms.map(s => s.attributes['gen_ai.usage.output_tokens']).sort()).toEqual([2, 3]);
    expect(llms.map(s => s.attributes['gen_ai.usage.cache_read.input_tokens']).sort()).toEqual([4, 5]);
    const agent = spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(30);
    expect(agent.attributes['gen_ai.usage.output_tokens']).toBe(5);
    const tool = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(tool).toHaveLength(1);
    expect(tool[0].spanContext().spanId).toBe('aaaaaaaaaaaaaaaa');
    expect(tool[0].attributes['gen_ai.tool.call.result']).toBe('demo content');
    expect(entry[0].attributes['gen_ai.input.messages']).toContain('Read the demo');
    expect(entry[0].attributes['gen_ai.output.messages']).toContain('demo read');
    expect(input).toEqual(before);
  });

  it.each([UPSTREAM, '0000000000000001'])('keeps an explicit upstream parent %s', async parent => {
    const spans = await flush(records(agentType, parent));
    const entry = spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')!;
    expect(entry.parentSpanId).toBe(parent);
    expect(entry.spanContext().traceId).toBe(TRACE);
  });

  it('keeps an upstream marker whose trace id arrives on a later record', async () => {
    const input = records(agentType, UPSTREAM);
    delete input[0].trace_id;
    const spans = await flush(input);
    expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')!.parentSpanId).toBe(UPSTREAM);
  });
});

describe('Qoder root converter compatibility', () => {
  it('reproduces the beta.13 synthetic parent separately from the patched production path', async () => {
    const result = await convertEventLogToReadableSpans(records('qoder-cli') as unknown as EventLogRecord[]);
    expect(result.spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')!.parentSpanId).toBe('0000000000000001');
  });

  it('does not change another Agent converter', async () => {
    const spans = await flush(records('claude-code'));
    expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')!.parentSpanId).toBe('0000000000000001');
  });

  it('restores the handler and consumes no reserved trace id after an SDK exception', async () => {
    const idGenerator = new ReservedSpanIdGenerator();
    const provider = new BasicTracerProvider({ idGenerator });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    const fail = () => { throw new Error('test startEntry failure'); };
    handler.startEntry = fail;
    try {
      expect(() => convertQoderTurn(records('qoder') as unknown as EventLogRecord[], { handler, idGenerator })).toThrow('test startEntry failure');
      expect(handler.startEntry).toBe(fail);
      expect(idGenerator.generateTraceId()).not.toBe(TRACE);
    } finally { await provider.shutdown(); }
  });
});
