// Integration test: verifies AgentSpanEnrichingHandler injects AGENT span
// aggregation attributes that the upstream library does not pull from records.
//
// The real @loongsuite/otel-util-genai library's buildInvokeAgentInvocation
// does not read gen_ai.agent.description / gen_ai.data_source.id from records,
// and only sets gen_ai.usage.cache_creation.input_tokens on the AGENT span when
// the sum across llm.response records is > 0 (null otherwise — triggers
// validate-trace SHOULD WARN). This test confirms the flusher's wrapper fills
// those gaps via invocation mutation before stopInvokeAgent applies attributes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { AgentSpanEnrichingHandler } from '../../../../src/flushers/otlp-trace-flusher.js';
import { convertEventLogToTrace } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

describe('AgentSpanEnrichingHandler — AGENT span attribute injection', () => {
  let inMem: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let handler: AgentSpanEnrichingHandler;

  beforeEach(() => {
    inMem = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(inMem)],
    });
    handler = new AgentSpanEnrichingHandler({ tracerProvider: provider });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  function makeTurnRecords(opts: {
    agentDescription?: string;
    dataSourceId?: string;
    cacheCreation?: number;
  } = {}): AgentActivityEntry[] {
    const recs: AgentActivityEntry[] = [
      {
        'time_unix_nano': '1700000000000000000',
        'event.id': 'evt-1',
        'event.name': 'other',
        'gen_ai.session.id': 's-test',
        'gen_ai.turn.id': 's-test:t1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.id': 's-test',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'user.id': 'u-test',
        ...(opts.agentDescription ? { 'gen_ai.agent.description': opts.agentDescription } : {}),
        ...(opts.dataSourceId ? { 'gen_ai.data_source.id': opts.dataSourceId } : {}),
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }],
      } as unknown as AgentActivityEntry,
      {
        'time_unix_nano': '1700000000000000001',
        'event.id': 'evt-2',
        'event.name': 'llm.request',
        'gen_ai.session.id': 's-test',
        'gen_ai.turn.id': 's-test:t1',
        'gen_ai.step.id': 's-test:t1:s1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.id': 's-test',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'gen_ai.request.model': 'grok-3',
        'gen_ai.response.id': 'r1',
        'user.id': 'u-test',
        'gen_ai.input.messages_hash': 'h1',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }],
      } as unknown as AgentActivityEntry,
      {
        'time_unix_nano': '1700000000000000002',
        'event.id': 'evt-3',
        'event.name': 'llm.response',
        'gen_ai.session.id': 's-test',
        'gen_ai.turn.id': 's-test:t1',
        'gen_ai.step.id': 's-test:t1:s1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.id': 's-test',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'gen_ai.request.model': 'grok-3',
        'gen_ai.response.model': 'grok-3',
        'gen_ai.response.id': 'r1',
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 20,
        'gen_ai.usage.cache_read.input_tokens': 5,
        'gen_ai.usage.cache_creation.input_tokens': opts.cacheCreation ?? 0,
        'gen_ai.usage.total_tokens': 120,
        'gen_ai.output.messages': [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
        'user.id': 'u-test',
      } as unknown as AgentActivityEntry,
    ];
    return recs;
  }

  function findAgentSpan() {
    const spans = inMem.getFinishedSpans();
    return spans.find((s) => s.attributes['gen_ai.span.kind'] === 'AGENT');
  }

  it('injects gen_ai.agent.description + gen_ai.data_source.id from records', () => {
    const records = makeTurnRecords({
      agentDescription: 'Grok Build coding agent',
      dataSourceId: 'grok-build',
    });
    // Flusher sets currentExtraAttrs before convertEventLogToTrace; simulate here
    handler.currentExtraAttrs = {
      'gen_ai.agent.description': 'Grok Build coding agent',
      'gen_ai.data_source.id': 'grok-build',
      'gen_ai.usage.cache_creation.input_tokens': 0,
    };
    convertEventLogToTrace(records as any, { handler, strict: false });

    const agentSpan = findAgentSpan();
    expect(agentSpan).toBeDefined();
    expect(agentSpan!.attributes['gen_ai.agent.description']).toBe('Grok Build coding agent');
    expect(agentSpan!.attributes['gen_ai.data_source.id']).toBe('grok-build');
    // AGENT aggregation: cache_creation sum from llm.response = 0; wrapper injects 0
    expect(agentSpan!.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(0);
  });

  it('does not override non-null cache_creation when sum > 0 (library already set)', () => {
    const records = makeTurnRecords({ cacheCreation: 50 });
    handler.currentExtraAttrs = {
      'gen_ai.agent.description': 'Grok Build coding agent',
      'gen_ai.data_source.id': 'grok-build',
      'gen_ai.usage.cache_creation.input_tokens': 50,
    };
    convertEventLogToTrace(records as any, { handler, strict: false });

    const agentSpan = findAgentSpan();
    expect(agentSpan).toBeDefined();
    // Library sums 50 (from llm.response) and sets it. Wrapper sees non-null, skips.
    expect(agentSpan!.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(50);
  });

  it('no extra attrs (empty currentExtraAttrs) — library behavior preserved (no crash, attrs absent)', () => {
    const records = makeTurnRecords({});
    handler.currentExtraAttrs = {};
    convertEventLogToTrace(records as any, { handler, strict: false });

    const agentSpan = findAgentSpan();
    expect(agentSpan).toBeDefined();
    // Without injection, library returns null for cache_creation (sum=0), so attribute absent
    expect(agentSpan!.attributes['gen_ai.agent.description']).toBeUndefined();
    expect(agentSpan!.attributes['gen_ai.data_source.id']).toBeUndefined();
    expect(agentSpan!.attributes['gen_ai.usage.cache_creation.input_tokens']).toBeUndefined();
  });
});
