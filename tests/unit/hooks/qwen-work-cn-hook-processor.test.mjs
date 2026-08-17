import { describe, expect, it } from 'vitest';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';
import {
  extractText,
  processTranscript,
} from '../../../assets/hooks/qwen-work-cn-hook-processor.mjs';

const common = {
  sessionId: 'sess-qwen-1',
  cwd: '/workspace',
  version: '0.1.5',
  isSidechain: false,
};

function realShapeRows() {
  return [
    {
      ...common,
      type: 'user',
      uuid: 'user-1',
      promptId: 'prompt-turn-1',
      timestamp: '2026-08-06T03:44:58.934Z',
      message: { role: 'user', content: [
        { type: 'text', text: '<system-reminder>workspace context</system-reminder>' },
        { type: 'text', text: 'inspect package.json' },
      ] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'thinking-1',
      parentUuid: 'user-1',
      timestamp: '2026-08-06T03:45:03.994Z',
      message: { role: 'assistant', id: 'response-1', model: 'qwork-advanced', content: [{ type: 'thinking', thinking: 'reason 1' }] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'tool-call-row-1',
      parentUuid: 'thinking-1',
      timestamp: '2026-08-06T03:45:03.994Z',
      message: { role: 'assistant', id: 'response-1', model: 'qwork-advanced', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'call-1', name: 'Glob', input: { pattern: 'package.json' } },
      ] },
    },
    {
      ...common,
      type: 'user',
      uuid: 'tool-result-row-1',
      parentUuid: 'tool-call-row-1',
      promptId: 'prompt-turn-1',
      timestamp: '2026-08-06T03:45:04.099Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: ['package.json'] }] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'thinking-2',
      parentUuid: 'tool-result-row-1',
      timestamp: '2026-08-06T03:45:08.673Z',
      message: { role: 'assistant', id: 'response-2', model: 'qwork-advanced', content: [{ type: 'thinking', thinking: 'reason 2' }] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'tool-call-row-2',
      parentUuid: 'thinking-2',
      timestamp: '2026-08-06T03:45:08.673Z',
      message: { role: 'assistant', id: 'response-2', model: 'qwork-advanced', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'package.json' } },
      ] },
    },
    {
      ...common,
      type: 'user',
      uuid: 'tool-result-row-2',
      parentUuid: 'tool-call-row-2',
      promptId: 'prompt-turn-1',
      timestamp: '2026-08-06T03:45:08.776Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: '{"name":"pilot"}' }] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'thinking-3',
      parentUuid: 'tool-result-row-2',
      timestamp: '2026-08-06T03:45:14.512Z',
      message: { role: 'assistant', id: 'response-3', model: 'qwork-advanced', content: [{ type: 'thinking', thinking: 'reason 3' }] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'text-3',
      parentUuid: 'thinking-3',
      timestamp: '2026-08-06T03:45:14.512Z',
      message: { role: 'assistant', id: 'response-3', model: 'qwork-advanced', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    },
  ];
}

describe('QwenWorkCN hook processor', () => {
  it('joins every text block in the user prompt', () => {
    expect(extractText(realShapeRows()[0])).toBe(
      '<system-reminder>workspace context</system-reminder>\ninspect package.json',
    );
  });

  it('skips a copied session when an automated background review is appended', () => {
    const reviewCopyRows = [
      ...realShapeRows(),
      {
        ...common,
        type: 'user',
        uuid: 'review-task',
        parentUuid: 'text-3',
        timestamp: '2026-08-06T03:45:15.000Z',
        message: { role: 'user', content: [
          { type: 'text', text: '[SYSTEM: This is an automated background review task. Review the preceding conversation.]' },
        ] },
      },
      {
        ...common,
        type: 'assistant',
        uuid: 'review-response',
        parentUuid: 'review-task',
        timestamp: '2026-08-06T03:45:16.000Z',
        message: { role: 'assistant', id: 'review-response', model: 'qwork-advanced', content: [
          { type: 'text', text: 'The review is complete.' },
        ] },
      },
    ];

    for (const rangeReason of ['incremental', 'missing-cursor']) {
      expect(processTranscript(
        reviewCopyRows,
        'sess-review-copy',
        { userId: 'user-1' },
        '/fallback',
        { rangeReason },
      )).toEqual([]);
    }
  });

  it('uses the QoderWork-compatible turn/step algorithm with independent Qwen fields', async () => {
    const events = processTranscript(
      realShapeRows(),
      'fallback-session',
      { userId: 'user-1' },
      '/fallback',
      { rangeReason: 'incremental' },
    );

    expect(events.map(event => event['event.name'])).toEqual([
      'other',
      'llm.request', 'llm.response', 'tool.call', 'tool.result',
      'llm.request', 'llm.response', 'tool.call', 'tool.result',
      'llm.request', 'llm.response',
    ]);
    expect(events.every(event => event['gen_ai.agent.type'] === 'qwen-work-cn')).toBe(true);
    expect(events.every(event => event['gen_ai.turn.id'] === 'prompt-turn-1')).toBe(true);
    expect(events.filter(event => event['event.name'] !== 'other').map(event => event['gen_ai.step.id'])).toEqual([
      'prompt-turn-1:s1', 'prompt-turn-1:s1', 'prompt-turn-1:s1', 'prompt-turn-1:s1',
      'prompt-turn-1:s2', 'prompt-turn-1:s2', 'prompt-turn-1:s2', 'prompt-turn-1:s2',
      'prompt-turn-1:s3', 'prompt-turn-1:s3',
    ]);
    expect(events.filter(event => event['event.name'] === 'llm.request')).toHaveLength(3);
    expect(events.filter(event => event['event.name'] === 'llm.response')).toHaveLength(3);
    expect(events.filter(event => event['event.name'] === 'llm.response').map(event =>
      event['gen_ai.output.messages'][0].parts.map(part => part.type))).toEqual([
      ['reasoning', 'tool_call'],
      ['reasoning', 'tool_call'],
      ['reasoning', 'text'],
    ]);
    expect(events.filter(event => event['event.name'] === 'llm.request').map(event =>
      (event['gen_ai.input.messages_delta'] || []).map(message => message.role))).toEqual([
      ['user'],
      ['assistant', 'tool'],
      ['assistant', 'tool'],
    ]);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(events);
      expect(conversion.warnings).toEqual([]);
      const kinds = conversion.spans.map(span => span.attributes['gen_ai.span.kind']);
      expect(kinds.filter(kind => kind === 'STEP')).toHaveLength(3);
      expect(kinds.filter(kind => kind === 'LLM')).toHaveLength(3);
      expect(kinds.filter(kind => kind === 'TOOL')).toHaveLength(2);
      expect(conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
        .every(span => span.duration[0] > 0 || span.duration[1] > 0)).toBe(true);
      const convertedInputs = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
        .map(span => JSON.parse(span.attributes['gen_ai.input.messages']));
      expect(convertedInputs.map(messages => messages.map(message => message.role))).toEqual([
        ['user'],
        ['user', 'assistant', 'tool'],
        ['user', 'assistant', 'tool', 'assistant', 'tool'],
      ]);
      expect(convertedInputs[1][1].parts[0]).toMatchObject({
        type: 'tool_call',
        id: 'call-1',
        name: 'Glob',
      });
      expect(convertedInputs[1][2].parts[0]).toMatchObject({
        type: 'tool_call_response',
        id: 'call-1',
      });
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });
});
