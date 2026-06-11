import { describe, expect, it } from 'vitest';
import {
  convertEventLogToTrace,
  ExtendedTelemetryHandler,
  type EventLogRecord,
} from '@loongsuite/otel-util-genai';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

function ns(ms: number): string {
  return `${ms}000000`;
}

function outputMessages(parts: Array<{ type: string; content?: string }>) {
  return [{ role: 'assistant', parts, finish_reason: parts[0]?.type === 'text' ? 'stop' : 'tool_calls' }];
}

describe('OTLP trace subagent output aggregation', () => {
  it('uses the parent final response for ENTRY and AGENT output when child records follow it', async () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    const base = {
      trace_id: '1234567890abcdef1234567890abcdef',
      'gen_ai.session.id': 'parent-conv',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.agent.type': 'cursor',
      'user.id': 'user-1',
    };
    const records: EventLogRecord[] = [
      {
        ...base,
        'event.name': 'llm.request',
        time_unix_nano: ns(0),
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'prompt' }] }],
      },
      {
        ...base,
        'event.name': 'tool.call',
        time_unix_nano: ns(10),
        'gen_ai.step.id': 'turn-1:s1',
        'gen_ai.tool.name': 'Subagent',
        'gen_ai.tool.call.id': 'call-subagent',
      },
      {
        ...base,
        'event.name': 'llm.request',
        time_unix_nano: ns(20),
        'gen_ai.step.id': 'turn-1:s2',
        'gen_ai.input.messages': [{ role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-subagent', response: 'done' }] }],
      },
      {
        ...base,
        'event.name': 'llm.response',
        time_unix_nano: ns(30),
        'gen_ai.step.id': 'turn-1:s2',
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.output.messages': outputMessages([{ type: 'text', content: 'parent final answer' }]),
      },
      {
        ...base,
        'event.name': 'llm.request',
        time_unix_nano: ns(40),
        'gen_ai.step.id': 'turn-1:sub:child:s1',
        'gen_ai.agent.scope': 'subagent',
        'gen_ai.agent.id': 'child-conv',
        'gen_ai.subagent.parent_tool_call.id': 'call-subagent',
      },
      {
        ...base,
        'event.name': 'llm.response',
        time_unix_nano: ns(50),
        'gen_ai.step.id': 'turn-1:sub:child:s1',
        'gen_ai.agent.scope': 'subagent',
        'gen_ai.agent.id': 'child-conv',
        'gen_ai.subagent.parent_tool_call.id': 'call-subagent',
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.output.messages': outputMessages([{ type: 'reasoning', content: 'child reasoning should not become parent overview' }]),
      },
    ] as EventLogRecord[];

    convertEventLogToTrace(records, { handler, strict: false });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const overviewSpans = spans.filter(span => {
      const kind = span.attributes['gen_ai.span.kind'];
      return kind === 'ENTRY' || kind === 'AGENT';
    });

    expect(overviewSpans.length).toBeGreaterThanOrEqual(2);
    const parentOverviewSpans = overviewSpans.filter(span =>
      span.name === 'invoke_agent cursor' ||
      span.name === 'enter_ai_application_system'
    );
    expect(parentOverviewSpans.length).toBe(2);
    for (const span of parentOverviewSpans) {
      const output = JSON.parse(String(span.attributes['gen_ai.output.messages']));
      expect(output[0].parts).toEqual([{ type: 'text', content: 'parent final answer' }]);
    }
  });
});
