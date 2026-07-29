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

  function makeToolTurnRecords(status: 'success' | 'failure' | 'cancelled'): AgentActivityEntry[] {
    return [
      {
        'time_unix_nano': '1700000000000000000',
        'event.id': 'evt-user',
        'event.name': 'other',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'user.id': 'u-test',
      },
      {
        'time_unix_nano': '1700000000001000000',
        'event.id': 'evt-request',
        'event.name': 'llm.request',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.step.id': 'step-1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'gen_ai.request.model': 'grok-3',
        'gen_ai.response.id': 'response-1',
        'user.id': 'u-test',
      },
      {
        'time_unix_nano': '1700000000002000000',
        'event.id': 'evt-response',
        'event.name': 'llm.response',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.step.id': 'step-1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'gen_ai.request.model': 'grok-3',
        'gen_ai.response.model': 'grok-3',
        'gen_ai.response.id': 'response-1',
        'gen_ai.response.finish_reasons': ['tool_call'],
        'user.id': 'u-test',
      },
      {
        'time_unix_nano': '1700000000003000000',
        'event.id': 'evt-tool-call',
        'event.name': 'tool.call',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.step.id': 'step-1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.tool.name': 'read_file',
        'gen_ai.tool.call.id': 'tool-1',
        'loongsuite.grok.match.strategy': 'id',
        'loongsuite.grok.timing.source': 'unified',
        'user.id': 'u-test',
      },
      {
        'time_unix_nano': '1700000000004000000',
        'event.id': 'evt-tool-result',
        'event.name': 'tool.result',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.step.id': 'step-1',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.tool.name': 'read_file',
        'gen_ai.tool.call.id': 'tool-1',
        'tool.result.status': status,
        ...(status === 'failure' ? { 'error.type': 'ToolError' } : {}),
        'loongsuite.grok.match.strategy': 'id',
        'loongsuite.grok.timing.source': 'unified',
        'user.id': 'u-test',
      },
      {
        'time_unix_nano': '1700000000005000000',
        'event.id': 'evt-final-request',
        'event.name': 'llm.request',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.step.id': 'step-2',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'gen_ai.request.model': 'grok-3',
        'gen_ai.response.id': 'response-2',
        'user.id': 'u-test',
      },
      {
        'time_unix_nano': '1700000000006000000',
        'event.id': 'evt-final-response',
        'event.name': 'llm.response',
        'gen_ai.session.id': 's-tool',
        'gen_ai.turn.id': 't-tool',
        'gen_ai.step.id': 'step-2',
        'gen_ai.agent.type': 'grok-build',
        'gen_ai.agent.name': 'grok-build',
        'gen_ai.provider.name': 'x_ai',
        'gen_ai.request.model': 'grok-3',
        'gen_ai.response.model': 'grok-3',
        'gen_ai.response.id': 'response-2',
        'gen_ai.response.finish_reasons': ['stop'],
        'user.id': 'u-test',
      },
    ] as unknown as AgentActivityEntry[];
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

  it.each([
    ['failure', 'ToolError'],
    ['cancelled', 'ToolCancelled'],
  ] as const)('maps %s tool results to an OTLP error TOOL span', (status, errorType) => {
    handler.currentToolOutcomes = new Map([
      ['tool-1', { status, errorType }],
    ]);
    convertEventLogToTrace(makeToolTurnRecords(status) as any, {
      handler,
      strict: false,
      passthroughKeys: [
        'loongsuite.grok.match.strategy',
        'loongsuite.grok.timing.source',
      ],
    });

    const toolSpan = inMem.getFinishedSpans()
      .find((span) => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.status.code).toBe(2);
    expect(toolSpan!.attributes['error.type']).toBe(errorType);
    expect(toolSpan!.attributes['loongsuite.grok.match.strategy']).toBe('id');
    expect(toolSpan!.attributes['loongsuite.grok.timing.source']).toBe('unified');
  });

  it('keeps successful tool spans non-error', () => {
    convertEventLogToTrace(makeToolTurnRecords('success') as any, { handler, strict: false });

    const toolSpan = inMem.getFinishedSpans()
      .find((span) => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.status.code).not.toBe(2);
    expect(toolSpan!.attributes['error.type']).toBeUndefined();
  });
});
