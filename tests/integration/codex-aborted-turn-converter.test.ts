import { describe, expect, it } from 'vitest';
import {
  convertEventLogToReadableSpans,
  type EventLogRecord,
} from '@loongsuite/otel-util-genai';

function ns(milliseconds: number): string {
  return `${milliseconds}000000`;
}

describe('Codex aborted turn converter integration', () => {
  it('converts cancelled into finished LLM and ReAct-step spans without warnings', async () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';

    const base = {
      trace_id: '1234567890abcdef1234567890abcdef',
      'gen_ai.session.id': 'codex-session',
      'gen_ai.turn.id': 'codex-session:aborted:turn-1',
      'gen_ai.agent.type': 'codex',
      'agent.codex.turn_status': 'interrupted',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5.4-mini',
    };
    const result = await convertEventLogToReadableSpans([
      {
        ...base,
        'event.name': 'llm.request',
        time_unix_nano: ns(1_000),
        'gen_ai.step.id': 'codex-session:aborted:turn-1:s1',
        'gen_ai.input.messages_delta': [{
          role: 'user',
          parts: [{ type: 'text', content: 'stop this request' }],
        }],
      },
      {
        ...base,
        'event.name': 'llm.response',
        time_unix_nano: ns(1_100),
        'gen_ai.step.id': 'codex-session:aborted:turn-1:s1',
        'gen_ai.response.model': 'gpt-5.4-mini',
        'gen_ai.response.finish_reasons': ['cancelled'],
      },
    ] as EventLogRecord[], { strict: false });

    expect(result.warnings).toEqual([]);
    const llm = result.spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    const step = result.spans.find(span => span.attributes['gen_ai.span.kind'] === 'STEP');
    expect(llm?.attributes['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    expect(step?.attributes['gen_ai.react.finish_reason']).toBe('cancelled');
  });
});
