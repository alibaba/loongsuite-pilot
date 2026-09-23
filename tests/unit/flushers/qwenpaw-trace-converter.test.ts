import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { SpanStatusCode } from '@opentelemetry/api';
import { convertQwenPawEvents } from '../../../src/flushers/qwenpaw-trace-converter.js';
import { ClientType, type AgentActivityEntry } from '../../../src/types/index.js';
import { transformHookRecord } from '../../../src/inputs/base/hook-record-transform.js';

const id = (value: number) => value.toString(16).padStart(16, '0');
const message = (role: string, text: string) => ({ role, parts: [{ type: 'text', content: text }] });

/** Synthetic lifecycle fixtures exercise the adapter contract, not QwenPaw runtime behavior. */
function pair(
  kind: 'entry' | 'agent' | 'step' | 'llm' | 'tool', value: number, parent?: number,
  fields: Partial<AgentActivityEntry> = {}, endFields: Partial<AgentActivityEntry> = {},
): AgentActivityEntry[] {
  const base: AgentActivityEntry = {
    time_unix_nano: '1700000000000000000', 'event.id': `start-${value}`,
    'event.name': 'other', 'user.id': 'user', 'gen_ai.session.id': 'session',
    'gen_ai.turn.id': 'turn', 'gen_ai.agent.type': 'qwenpaw', 'gen_ai.provider.name': 'dashscope',
    'agent.qwenpaw.span.id': id(value), 'agent.qwenpaw.parent.id': parent ? id(parent) : '',
    ...fields,
  };
  const startEvent = kind === 'llm' ? 'llm.request' : kind === 'tool' ? 'tool.call' : 'other';
  const endEvent = kind === 'llm' ? 'llm.response' : kind === 'tool' ? 'tool.result' : 'other';
  return [
    { ...base, 'event.name': startEvent, ...(startEvent === 'other' ? { 'agent.qwenpaw.boundary': `${kind}.start` } : {}) },
    { ...base, time_unix_nano: '1700000000200000000', 'event.id': `end-${value}`,
      'event.name': endEvent, ...(endEvent === 'other' ? { 'agent.qwenpaw.boundary': `${kind}.end` } : {}), ...endFields },
  ];
}

describe('QwenPaw explicit lifecycle converter', () => {
  let provider: BasicTracerProvider;
  let exporter: InMemorySpanExporter;
  let handler: ExtendedTelemetryHandler;
  beforeEach(() => {
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental');
    vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'SPAN_ONLY');
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
  });
  afterEach(async () => { await provider.shutdown(); vi.unstubAllEnvs(); });

  it('preserves explicit helper Agent, real STEP and LLM/TOOL parentage without synthetic roots', () => {
    const records = [
      ...pair('entry', 1, undefined, { 'gen_ai.input.messages': [message('user', 'hello')] }, { 'gen_ai.output.messages': [message('assistant', 'done')] }),
      ...pair('agent', 2, 1, { 'gen_ai.agent.name': 'main' }),
      ...pair('step', 3, 2, { 'agent.qwenpaw.reasoning.id': 'reason-1', 'agent.qwenpaw.reasoning.round': 1 }),
      ...pair('llm', 4, 3, { 'gen_ai.step.id': 'model-call-1', 'gen_ai.request.model': 'qwen' }),
      ...pair('tool', 5, 3, { 'gen_ai.tool.name': 'delegate', 'gen_ai.tool.call.id': 'call-1' }),
      ...pair('agent', 6, 5, { 'gen_ai.agent.name': 'helper' }),
      ...pair('step', 7, 6), ...pair('llm', 8, 7),
    ];
    const result = convertQwenPawEvents(records.reverse().map(record => ({
      ...record, 'example.source_id': record['agent.qwenpaw.span.id'],
    })), handler, ['example.source_id']);
    expect(result).toEqual({ spanCount: 8, warnings: [] });
    const spans = exporter.getFinishedSpans();
    const bySource = new Map(spans.map(span => [span.attributes['example.source_id'], span]));
    for (const [child, parent] of [[2, 1], [3, 2], [4, 3], [5, 3], [6, 5], [7, 6], [8, 7]]) {
      expect(bySource.get(id(child))?.parentSpanId).toBe(bySource.get(id(parent))?.spanContext().spanId);
    }
    for (const span of spans) {
      expect(Object.keys(span.attributes).filter(key => key.startsWith('agent.qwenpaw.'))).toEqual([]);
    }
    expect(records.every(record => record['agent.qwenpaw.span.id'])).toBe(true);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
    expect(spans.filter(span => !span.parentSpanId)).toHaveLength(1);
    expect(bySource.get(id(3))?.attributes['gen_ai.react.round']).toBe(1);
    expect(bySource.get(id(6))?.attributes['gen_ai.agent.name']).toBe('helper');
    expect(bySource.get(id(1))?.attributes['gen_ai.output.messages']).toContain('done');
  });

  it('maps content, tokens, TTFT, model settings, system/tools and custom attributes through public APIs', () => {
    const records = [ ...pair('entry', 1), ...pair('agent', 2, 1), ...pair('step', 3, 2),
      ...pair('llm', 4, 3, {
        'gen_ai.request.model': 'qwen', 'gen_ai.request.temperature': 0.5,
        'gen_ai.input.messages': [message('user', 'question')],
        'gen_ai.system_instructions': [{ type: 'text', content: 'Be concise' }],
        'gen_ai.tool.definitions': [{ type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object' } } }],
        'example.request_id': 'request-a',
      }, {
        'gen_ai.output.messages': [{ ...message('assistant', 'answer'), finish_reason: 'stop' }],
        'gen_ai.response.model': 'qwen-actual', 'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 4,
        'gen_ai.usage.cache_read.input_tokens': 2, 'gen_ai.usage.cache_creation.input_tokens': 3,
        'gen_ai.response.time_to_first_token': 50_000_000,
      }),
      ...pair('tool', 5, 3, { 'gen_ai.tool.name': 'search', 'gen_ai.tool.call.id': 'call', 'gen_ai.tool.call.arguments': { q: 'hello' } }, { 'gen_ai.tool.call.result': { answer: 42 } }),
    ];
    convertQwenPawEvents(records, handler, ['example.request_id']);
    const spans = exporter.getFinishedSpans();
    const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
    expect(llm.attributes).toMatchObject({
      'gen_ai.request.model': 'qwen', 'gen_ai.response.model': 'qwen-actual',
      'gen_ai.request.temperature': 0.5, 'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 4, 'gen_ai.usage.total_tokens': 16,
      'gen_ai.usage.cache_read.input_tokens': 2, 'gen_ai.usage.cache_creation.input_tokens': 3,
      'gen_ai.response.time_to_first_token': 50_000_000, 'example.request_id': 'request-a',
    });
    expect(llm.duration).toEqual([0, 200_000_000]);
    expect(llm.attributes['gen_ai.input.messages']).toContain('question');
    expect(llm.attributes['gen_ai.output.messages']).toContain('"finish_reason":"stop"');
    expect(llm.attributes['gen_ai.system_instructions']).toContain('Be concise');
    expect(llm.attributes['gen_ai.tool.definitions']).toContain('search');
    const tool = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL')!;
    expect(tool.attributes['gen_ai.tool.call.arguments']).toContain('hello');
    expect(tool.attributes['gen_ai.tool.call.result']).toContain('42');
  });

  it('keeps failed attempts separate from successful retries within the same real STEP', () => {
    const records = [ ...pair('entry', 1), ...pair('agent', 2, 1), ...pair('step', 3, 2),
      ...pair('llm', 4, 3, { 'gen_ai.step.id': 'attempt-1' }, { 'error.type': 'TimeoutError', 'error.message': 'request timed out' }),
      ...pair('llm', 5, 3, { 'gen_ai.step.id': 'attempt-2' }, { 'gen_ai.output.messages': [message('assistant', 'ok')] }),
    ];
    expect(convertQwenPawEvents(records, handler).warnings).toEqual([]);
    const spans = exporter.getFinishedSpans();
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'STEP')).toHaveLength(1);
    const attempts = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(attempts[0].attributes['error.type']).toBe('TimeoutError');
    expect(attempts[1].status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('converts no-model turns and failure boundaries without inventing an LLM', () => {
    const records = [ ...pair('entry', 1, undefined, {}, { 'error.type': 'CancelledError' }),
      ...pair('agent', 2, 1, {}, { 'error.type': 'CancelledError' }),
      ...pair('step', 3, 2, {}, { 'error.type': 'CancelledError' }),
      ...pair('tool', 4, 3, { 'gen_ai.tool.name': 'failing' }, { 'tool.result.status': 'error' }),
    ];
    expect(convertQwenPawEvents(records, handler).spanCount).toBe(4);
    expect(exporter.getFinishedSpans().every(span => span.status.code === SpanStatusCode.ERROR)).toBe(true);
    expect(exporter.getFinishedSpans().some(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toBe(false);
  });

  it('isolates interleaved turns even when source span IDs collide and does not inherit ambient context', () => {
    const a = [...pair('entry', 1), ...pair('agent', 2, 1)];
    const b = a.map(record => ({ ...record, 'gen_ai.turn.id': 'turn-b', 'gen_ai.session.id': 'session-b' }));
    convertQwenPawEvents(a.flatMap((record, index) => [record, b[index]]), handler);
    const spans = exporter.getFinishedSpans();
    const aSpans = spans.filter(span => span.attributes['gen_ai.session.id'] === 'session');
    const bSpans = spans.filter(span => span.attributes['gen_ai.session.id'] === 'session-b');
    expect(aSpans).toHaveLength(2); expect(bSpans).toHaveLength(2);
    expect(aSpans[0].spanContext().traceId).not.toBe(bSpans[0].spanContext().traceId);
    expect(aSpans[1].parentSpanId).toBe(aSpans[0].spanContext().spanId);
    expect(bSpans[1].parentSpanId).toBe(bSpans[0].spanContext().spanId);
  });

  it('preserves ENTRY TTFT, terminal STEP reason, stable identity and skill metadata', () => {
    const records = [
      ...pair('entry', 1, undefined, {}, { 'gen_ai.response.time_to_first_token': 75_000_000 }),
      ...pair('agent', 2, 1, { 'gen_ai.agent.id': 'stable-agent', 'gen_ai.request.model': 'qwen' }),
      ...pair('step', 3, 2, {}, { 'response.finish_reasons': 'tool_calls' }),
      ...pair('tool', 4, 3, {
        'gen_ai.tool.name': 'skill', 'gen_ai.tool.type': 'function', 'gen_ai.tool.description': 'Load skill',
        'gen_ai.skill.name': 'research', 'gen_ai.skill.id': 'skill-research',
        'gen_ai.skill.description': 'Research workflow', 'gen_ai.skill.version': '1.0',
      }),
    ].map(record => ({ ...record, 'gen_ai.conversation.id': 'business-conversation' }));
    convertQwenPawEvents(records, handler);
    const spans = exporter.getFinishedSpans();
    const byKind = new Map(spans.map(span => [span.attributes['gen_ai.span.kind'], span]));
    expect(byKind.get('ENTRY')?.attributes['gen_ai.response.time_to_first_token']).toBe(75_000_000);
    expect(byKind.get('AGENT')?.attributes['gen_ai.agent.id']).toBe('stable-agent');
    expect(byKind.get('AGENT')?.attributes['gen_ai.request.model']).toBe('qwen');
    expect(byKind.get('STEP')?.attributes['gen_ai.react.finish_reason']).toBe('tool_calls');
    expect(spans.every(span => span.attributes['gen_ai.conversation.id'] === 'business-conversation')).toBe(true);
    expect(byKind.get('TOOL')?.attributes).toMatchObject({
      'gen_ai.tool.type': 'function', 'gen_ai.tool.description': 'Load skill',
      'gen_ai.skill.name': 'research', 'gen_ai.skill.id': 'skill-research',
      'gen_ai.skill.description': 'Research workflow', 'gen_ai.skill.version': '1.0',
    });
  });

  it('honors remote parent context only for roots and never substitutes it for an internal parent', () => {
    const remote = { trace_id: '1234567890abcdef1234567890abcdef', parent_span_id: id(900) };
    const records = [
      ...pair('entry', 1, undefined, remote), ...pair('agent', 2, 1, remote),
      ...pair('step', 3, 2, remote), ...pair('llm', 4, 3, remote),
      ...pair('tool', 5, 99, remote),
    ];
    const result = convertQwenPawEvents(records, handler);
    expect(result.spanCount).toBe(4);
    const spans = exporter.getFinishedSpans();
    expect(spans[0].parentSpanId).toBe(id(900));
    expect(spans.every(span => span.spanContext().traceId === remote.trace_id)).toBe(true);
    expect(spans[1].parentSpanId).toBe(spans[0].spanContext().spanId);
    expect(spans[2].parentSpanId).toBe(spans[1].spanContext().spanId);
    expect(spans[3].parentSpanId).toBe(spans[2].spanContext().spanId);
  });

  it('rejects invalid external IDs and out-of-range TTFT without fabricating a synthetic parent', () => {
    const records = [
      ...pair('entry', 1, undefined, { trace_id: '1234567890abcdef1234567890abcdef' }, { 'gen_ai.response.time_to_first_token': 300_000_000 }),
      ...pair('entry', 2, undefined, { trace_id: '0'.repeat(32), parent_span_id: id(900) }, { 'gen_ai.response.time_to_first_token': -1 }),
    ];
    convertQwenPawEvents(records, handler);
    for (const span of exporter.getFinishedSpans()) {
      expect(span.parentSpanId).toBeUndefined();
      expect(span.attributes['gen_ai.response.time_to_first_token']).toBeUndefined();
    }
  });

  it('maps extra model settings and keeps explicit terminal STEP reason over inferred finish reasons', () => {
    const records = [...pair('entry', 1), ...pair('agent', 2, 1),
      ...pair('step', 3, 2, {}, { 'gen_ai.react.finish_reason': 'interrupted', 'response.finish_reasons': 'stop', 'error.type': 'CancelledError' }),
      ...pair('llm', 4, 3, {
        'gen_ai.request.top_p': 0.9, 'gen_ai.request.top_k': 10, 'gen_ai.request.max_tokens': 128,
        'gen_ai.request.frequency_penalty': 0.5, 'gen_ai.request.presence_penalty': 0.2,
        'gen_ai.request.seed': 7, 'gen_ai.request.choice.count': 2, 'gen_ai.request.stop_sequences': ['END'],
        'server.address': 'model.example.test', 'server.port': 443,
      }),
    ];
    convertQwenPawEvents(records, handler);
    const spans = exporter.getFinishedSpans();
    expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'STEP')?.attributes['gen_ai.react.finish_reason']).toBe('cancelled');
    expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')?.attributes).toMatchObject({
      'gen_ai.request.top_p': 0.9, 'gen_ai.request.top_k': 10, 'gen_ai.request.max_tokens': 128,
      'gen_ai.request.frequency_penalty': 0.5, 'gen_ai.request.presence_penalty': 0.2,
      'gen_ai.request.seed': 7, 'gen_ai.request.choice.count': 2, 'gen_ai.request.stop_sequences': ['END'],
      'server.address': 'model.example.test', 'server.port': 443,
    });
  });

  it('normalizes native interruption and fills final message reasons from observed terminal status', () => {
    const partial = { 'gen_ai.output.messages': [message('assistant', 'partial')], 'error.type': 'CancelledError' };
    const records = [
      ...pair('entry', 1, undefined, {}, partial),
      ...pair('agent', 2, 1, {}, partial),
      ...pair('step', 3, 2, {}, { 'response.finish_reasons': 'interrupted', 'error.type': 'CancelledError' }),
      ...pair('llm', 4, 3, {}, {
        'response.finish_reasons': 'interrupted', 'error.type': 'CancelledError',
        'gen_ai.output.messages': [{ ...message('assistant', 'partial'), finish_reason: 'interrupted' }],
      }),
      ...pair('entry', 5, undefined, {}, { 'gen_ai.output.messages': [message('assistant', 'done')] }),
      ...pair('entry', 6, undefined, {}, { 'error.type': 'RuntimeError', 'gen_ai.output.messages': [message('assistant', 'failed')] }),
    ];
    convertQwenPawEvents(records, handler);
    const spans = exporter.getFinishedSpans();
    for (const span of spans.slice(0, 4)) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      const raw = span.attributes['gen_ai.output.messages'];
      if (raw) expect(JSON.parse(raw as string)[0].finish_reason).toBe('cancelled');
    }
    expect(spans[2].attributes['gen_ai.react.finish_reason']).toBe('cancelled');
    expect(spans[3].attributes['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    expect(JSON.parse(spans[4].attributes['gen_ai.output.messages'] as string)[0].finish_reason).toBe('stop');
    expect(JSON.parse(spans[5].attributes['gen_ai.output.messages'] as string)[0].finish_reason).toBe('error');
  });

  it('keeps QwenPaw protocol metadata local while preserving cancellation semantics', () => {
    const fields = {
      'agent.qwenpaw.agent.id': 'execution', 'agent.qwenpaw.entry.id': 'entry',
      'agent.qwenpaw.parent_agent.id': '', 'agent.qwenpaw.reasoning.id': 'reason',
      'agent.qwenpaw.runtime_agent.id': 'default', 'agent.qwenpaw.background': 'dream',
      'agent.qwenpaw.dream.owner': 'owner', 'agent.qwenpaw.cancelled': true,
      'example.request_id': 'must-not-export',
      'unrelated.private_value': 'must-not-export',
    };
    convertQwenPawEvents(pair('entry', 1, undefined, fields, {
      'gen_ai.output.messages': [message('assistant', 'partial')],
    }), handler);
    const attrs = exporter.getFinishedSpans()[0].attributes;
    for (const key of Object.keys(fields)) expect(attrs[key]).toBeUndefined();
    expect(Object.keys(attrs).filter(key => key.startsWith('agent.qwenpaw.'))).toEqual([]);
    expect(JSON.parse(attrs['gen_ai.output.messages'] as string)[0].finish_reason).toBe('cancelled');
  });

  it('uses the source ENTRY end name and STEP boundaries that include acting after reasoning', () => {
    const records = [
      ...pair('entry', 1, undefined, {}, { 'gen_ai.agent.name': 'Runtime agent' }),
      ...pair('agent', 2, 1, { 'gen_ai.agent.name': 'Runtime agent' }),
      ...pair('step', 3, 2),
      ...pair('llm', 4, 3, {}, { time_unix_nano: '1700000000050000000' }),
      ...pair('tool', 5, 3, { time_unix_nano: '1700000000100000000', 'gen_ai.tool.name': 'read' }, { time_unix_nano: '1700000000150000000' }),
    ];
    expect(convertQwenPawEvents(records, handler).warnings).toEqual([]);
    const spans = exporter.getFinishedSpans();
    const byKind = new Map(spans.map(span => [span.attributes['gen_ai.span.kind'], span]));
    expect(byKind.get('ENTRY')?.attributes['gen_ai.agent.name']).toBe('Runtime agent');
    expect(byKind.get('STEP')?.duration).toEqual([0, 200_000_000]);
    expect(byKind.get('LLM')?.duration).toEqual([0, 50_000_000]);
    expect(byKind.get('TOOL')?.duration).toEqual([0, 50_000_000]);
    expect(byKind.get('TOOL')?.parentSpanId).toBe(byKind.get('STEP')?.spanContext().spanId);
  });

  it('reports an early STEP end without changing recorded timestamps to hide the source error', () => {
    const records = [
      ...pair('entry', 1), ...pair('agent', 2, 1),
      ...pair('step', 3, 2, {}, { time_unix_nano: '1700000000050000000' }),
      ...pair('tool', 4, 3, { time_unix_nano: '1700000000100000000' }, { time_unix_nano: '1700000000150000000' }),
    ];
    const result = convertQwenPawEvents(records, handler);
    expect(result.spanCount).toBe(4);
    expect(result.warnings).toEqual([`QwenPaw child exceeds observed parent lifetime: ${id(4)}`]);
    const spans = exporter.getFinishedSpans();
    const step = spans.find(span => span.attributes['gen_ai.span.kind'] === 'STEP')!;
    const tool = spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL')!;
    expect(step.endTime).toEqual([1_700_000_000, 50_000_000]);
    expect(tool.startTime).toEqual([1_700_000_000, 100_000_000]);
    expect(tool.endTime).toEqual([1_700_000_000, 150_000_000]);
  });

  it('retains request-only system instructions and tools after the real hook normalization pipeline', async () => {
    const agent = pair('agent', 2, 1);
    agent[0]['gen_ai.system_instructions'] = [{ type: 'text', content: 'agent system' }];
    const model = pair('llm', 4, 3);
    model[0]['gen_ai.system_instructions'] = [{ type: 'text', content: 'model system' }];
    model[0]['gen_ai.tool.definitions'] = [{ type: 'function', function: { name: 'search', description: 'Search', parameters: { type: 'object' } } }];
    const raw = [...pair('entry', 1), ...agent, ...pair('step', 3, 2), ...model];
    const normalized = (await Promise.all(raw.map(record => transformHookRecord(record, ClientType.QwenPaw, 'qwenpaw')))) as AgentActivityEntry[];
    expect(Object.hasOwn(normalized[3], 'gen_ai.system_instructions')).toBe(true);
    expect(normalized[3]['gen_ai.system_instructions']).toBeUndefined();
    expect(Object.hasOwn(normalized[7], 'gen_ai.tool.definitions')).toBe(true);
    expect(normalized[7]['gen_ai.tool.definitions']).toBeUndefined();
    convertQwenPawEvents(normalized, handler);
    const spans = exporter.getFinishedSpans();
    const agentSpan = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
    const modelSpan = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
    expect(agentSpan.attributes['gen_ai.system_instructions']).toContain('agent system');
    expect(modelSpan.attributes['gen_ai.system_instructions']).toContain('model system');
    expect(modelSpan.attributes['gen_ai.tool.definitions']).toContain('search');
  });

  it('honors explicit terminal metadata replacement and empty arrays through normalization', async () => {
    const model = pair('llm', 4, 3);
    model[0]['gen_ai.system_instructions'] = [{ type: 'text', content: 'old system' }];
    model[0]['gen_ai.tool.definitions'] = [{ type: 'function', name: 'old-tool' }];
    model[1]['gen_ai.system_instructions'] = [{ type: 'text', content: 'new system' }];
    model[1]['gen_ai.tool.definitions'] = [];
    const raw = [...pair('entry', 1), ...pair('agent', 2, 1), ...pair('step', 3, 2), ...model];
    const normalized = (await Promise.all(raw.map(record => transformHookRecord(record, ClientType.QwenPaw, 'qwenpaw')))) as AgentActivityEntry[];
    convertQwenPawEvents(normalized, handler);
    const attrs = exporter.getFinishedSpans().find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!.attributes;
    expect(attrs['gen_ai.system_instructions']).toContain('new system');
    expect(attrs['gen_ai.system_instructions']).not.toContain('old system');
    expect(JSON.stringify(attrs)).not.toContain('old-tool');
  });

  it('does not resurrect content stripped before normalization when captureMessageContent is false', async () => {
    const content = {
      'gen_ai.input.messages': [message('user', 'private question')],
      'gen_ai.output.messages': [message('assistant', 'private answer')],
      'gen_ai.system_instructions': [{ type: 'text', content: 'private system' }],
      'gen_ai.tool.definitions': [{ type: 'function', name: 'private-tool' }],
      'gen_ai.tool.call.arguments': { text: 'private argument' },
      'gen_ai.tool.call.result': { text: 'private result' },
      'error.message': 'private error',
    };
    // Same producer policy as JsonlWriter.captureMessageContent=false: strip
    // every content field on every event before it reaches hook normalization.
    const records = [...pair('entry', 1, undefined, content), ...pair('agent', 2, 1, content),
      ...pair('step', 3, 2), ...pair('llm', 4, 3, content)];
    const stripped = records.map(record => Object.fromEntries(Object.entries(record).filter(([key]) => !Object.hasOwn(content, key))));
    const normalized = (await Promise.all(stripped.map(record => transformHookRecord(record, ClientType.QwenPaw, 'qwenpaw')))) as AgentActivityEntry[];
    convertQwenPawEvents(normalized, handler);
    for (const span of exporter.getFinishedSpans()) {
      expect(JSON.stringify(span.attributes)).not.toContain('private');
      for (const field of Object.keys(content)) expect(span.attributes[field]).toBeUndefined();
    }
  });

  it('omits missing ends and descendants, and deduplicates replayed event IDs', () => {
    const records = [...pair('entry', 1), pair('agent', 2, 1)[0], ...pair('step', 3, 2)];
    const result = convertQwenPawEvents([...records, ...records], handler);
    expect(result.spanCount).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it('rejects ambiguous pairs, unknown parents, timestamp reversal and parent cycles', () => {
    const records = [
      ...pair('entry', 1), ...pair('agent', 2, 99),
      ...pair('step', 3, 4), ...pair('step', 4, 3),
      ...pair('agent', 5, 1, {}, { time_unix_nano: '1699999999000000000' }),
      ...pair('agent', 6, 1), { ...pair('agent', 6, 1)[0], 'event.id': 'conflicting-start' },
    ];
    const result = convertQwenPawEvents(records, handler);
    expect(result.spanCount).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
