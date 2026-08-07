import { describe, expect, it } from 'vitest';
import {
  convertEventLogToReadableSpans,
  type EventLogRecord,
} from '@loongsuite/otel-util-genai';

function ns(milliseconds: number): string {
  return `${milliseconds}000000`;
}

describe('Codex subagent converter integration', () => {
  it('nests three completed children under their spawn_agent tool spans in one trace', async () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';

    const base = {
      trace_id: '1234567890abcdef1234567890abcdef',
      'gen_ai.session.id': 'parent-session',
      'gen_ai.turn.id': 'parent-session:turn-1',
      'gen_ai.agent.type': 'codex',
      'gen_ai.agent.id': 'parent-session',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5.4',
    };
    const records: EventLogRecord[] = [
      {
        ...base,
        'event.name': 'other',
        time_unix_nano: ns(1_000),
        parent_span_id: '0000000000000001',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'delegate' }] }],
      },
      {
        ...base,
        'event.name': 'llm.request',
        time_unix_nano: ns(1_010),
        'gen_ai.step.id': 'parent-session:turn-1:s1',
      },
      {
        ...base,
        'event.name': 'llm.response',
        time_unix_nano: ns(1_020),
        'gen_ai.step.id': 'parent-session:turn-1:s1',
        'gen_ai.response.finish_reasons': ['tool_call'],
      },
    ];

    for (let index = 1; index <= 3; index += 1) {
      const callId = `call-child-${index}`;
      records.push(
        {
          ...base,
          'event.name': 'tool.call',
          time_unix_nano: ns(1_020 + index),
          'gen_ai.step.id': 'parent-session:turn-1:s1',
          'gen_ai.tool.name': 'spawn_agent',
          'gen_ai.tool.call.id': callId,
        },
        {
          ...base,
          'event.name': 'tool.result',
          time_unix_nano: ns(1_030 + index),
          'gen_ai.step.id': 'parent-session:turn-1:s1',
          'gen_ai.tool.name': 'spawn_agent',
          'gen_ai.tool.call.id': callId,
          'tool.result.status': 'success',
        },
        {
          ...base,
          'event.name': 'llm.request',
          time_unix_nano: ns(1_025 + index),
          'gen_ai.step.id': `child-${index}:turn:s1`,
          'gen_ai.agent.scope': 'subagent',
          'gen_ai.agent.id': `child-${index}`,
          'gen_ai.agent.parent.id': 'parent-session',
          'gen_ai.subagent.parent_tool_call.id': callId,
        },
        {
          ...base,
          'event.name': 'llm.response',
          time_unix_nano: ns(1_040 + index),
          'gen_ai.step.id': `child-${index}:turn:s1`,
          'gen_ai.agent.scope': 'subagent',
          'gen_ai.agent.id': `child-${index}`,
          'gen_ai.agent.parent.id': 'parent-session',
          'gen_ai.subagent.parent_tool_call.id': callId,
          'gen_ai.response.finish_reasons': ['stop'],
        },
      );
    }

    records.push(
      {
        ...base,
        'event.name': 'llm.request',
        time_unix_nano: ns(1_050),
        'gen_ai.step.id': 'parent-session:turn-1:s2',
      },
      {
        ...base,
        'event.name': 'llm.response',
        time_unix_nano: ns(1_060),
        'gen_ai.step.id': 'parent-session:turn-1:s2',
        'gen_ai.response.finish_reasons': ['stop'],
      },
      {
        ...base,
        'event.name': 'other',
        time_unix_nano: ns(1_061),
        parent_span_id: '0000000000000001',
        'gen_ai.turn.end': true,
        'agent.codex.turn_status': 'completed',
      },
    );

    const result = await convertEventLogToReadableSpans(records, {
      strict: false,
      passthroughKeys: [
        'gen_ai.agent.scope',
        'gen_ai.agent.id',
        'gen_ai.agent.parent.id',
        'gen_ai.subagent.parent_tool_call.id',
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(new Set(result.spans.map(span => span.spanContext().traceId))).toEqual(
      new Set([base.trace_id]),
    );
    const agents = result.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
    const tools = result.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(agents).toHaveLength(4);
    expect(tools).toHaveLength(3);

    for (let index = 1; index <= 3; index += 1) {
      const callId = `call-child-${index}`;
      const tool = tools.find(span => span.attributes['gen_ai.tool.call.id'] === callId);
      const child = agents.find(span => (
        span.attributes['gen_ai.subagent.parent_tool_call.id'] === callId
      ));
      expect(tool).toBeDefined();
      expect(child).toBeDefined();
      expect(child?.parentSpanId).toBe(tool?.spanContext().spanId);
    }
  });
});
