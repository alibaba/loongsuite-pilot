import { describe, expect, it } from 'vitest';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';
import {
  extractText,
  getTurnIdForRows,
  isSystemInjection,
  isToolResult,
  processTranscript,
  splitIntoTurns,
} from '../../../assets/hooks/qoderwork-hook-processor.mjs';

describe('extractText', () => {
  it('returns string content directly', () => {
    expect(extractText({ message: { content: 'hello' } })).toBe('hello');
  });

  it('returns empty string for missing message', () => {
    expect(extractText({})).toBe('');
  });

  it('extracts single text block', () => {
    const row = { message: { content: [{ type: 'text', text: 'user query' }] } };
    expect(extractText(row)).toBe('user query');
  });

  it('concatenates multiple text blocks with newline', () => {
    const row = {
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', id: 't1', name: 'shell', input: {} },
          { type: 'text', text: 'second' },
        ],
      },
    };
    expect(extractText(row)).toBe('first\nsecond');
  });

  it('handles plain string blocks in content array', () => {
    const row = { message: { content: ['plain string'] } };
    expect(extractText(row)).toBe('plain string');
  });

  it('skips text blocks with empty text', () => {
    const row = {
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'actual' },
        ],
      },
    };
    expect(extractText(row)).toBe('actual');
  });
});

describe('isSystemInjection', () => {
  it('detects <command-message> prefix', () => {
    const row = { message: { content: [{ type: 'text', text: '<command-message>do something</command-message>' }] } };
    expect(isSystemInjection(row)).toBe(true);
  });

  it('detects <command-name> prefix', () => {
    const row = { message: { content: [{ type: 'text', text: '<command-name>run</command-name>' }] } };
    expect(isSystemInjection(row)).toBe(true);
  });

  it('detects [Request interrupted prefix', () => {
    const row = { message: { content: [{ type: 'text', text: '[Request interrupted by user for new message]' }] } };
    expect(isSystemInjection(row)).toBe(true);
  });

  it('detects injection with leading whitespace', () => {
    const row = { message: { content: [{ type: 'text', text: '  [Request interrupted by user]' }] } };
    expect(isSystemInjection(row)).toBe(true);
  });

  it('keeps pure system-reminders in the current turn without hiding mixed prompts', () => {
    const systemOnly = {
      message: { content: [{ type: 'text', text: '<system-reminder>runtime context</system-reminder>' }] },
    };
    const systemAndPrompt = {
      message: {
        content: [
          { type: 'text', text: '<system-reminder>runtime context</system-reminder>' },
          { type: 'text', text: 'implement the requested change' },
        ],
      },
    };

    expect(isSystemInjection(systemOnly)).toBe(true);
    expect(isSystemInjection(systemAndPrompt)).toBe(false);
    expect(extractText(systemAndPrompt)).toBe(
      '<system-reminder>runtime context</system-reminder>\nimplement the requested change',
    );
  });

  it('returns false for normal user text', () => {
    const row = { message: { content: [{ type: 'text', text: 'how do I build a multi-turn scenario?' }] } };
    expect(isSystemInjection(row)).toBe(false);
  });
});

describe('getTurnIdForRows', () => {
  it('uses the same real prompt row as turn event construction', () => {
    const systemReminder = {
      type: 'user',
      uuid: 'system-row-id',
      message: { content: [{ type: 'text', text: '<system-reminder>runtime context</system-reminder>' }] },
    };
    const prompt = {
      type: 'user',
      uuid: 'prompt-row-id',
      promptId: 'real-prompt-id',
      message: { content: [{ type: 'text', text: 'implement the requested change' }] },
    };

    expect(getTurnIdForRows([systemReminder, prompt])).toBe('real-prompt-id');
  });
});

describe('isToolResult', () => {
  it('returns true for tool_result content', () => {
    const row = { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
    expect(isToolResult(row)).toBe(true);
  });

  it('returns false for text content', () => {
    const row = { message: { content: [{ type: 'text', text: 'hello' }] } };
    expect(isToolResult(row)).toBe(false);
  });
});

describe('splitIntoTurns', () => {
  it('splits on user messages, keeps tool_results and injections in current turn', () => {
    const rows = [
      { type: 'user', message: { content: [{ type: 'text', text: 'question 1' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer 1' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'question 2' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'answer 2' }] } },
    ];
    const turns = splitIntoTurns(rows);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveLength(4);
    expect(turns[1]).toHaveLength(2);
  });
});

describe('QoderWork OTLP message semantics', () => {
  it('uses stop for the final response and keeps tool call/result in assistant/tool messages', async () => {
    const rows = [
      {
        type: 'user',
        uuid: 'user-1',
        promptId: 'turn-1',
        timestamp: '2026-08-25T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'inspect a file' }] },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tool-1',
        parentUuid: 'user-1',
        timestamp: '2026-08-25T01:00:01.000Z',
        message: {
          role: 'assistant',
          id: 'response-1',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.txt' } }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-result-1',
        parentUuid: 'assistant-tool-1',
        timestamp: '2026-08-25T01:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-final-1',
        parentUuid: 'tool-result-1',
        timestamp: '2026-08-25T01:00:03.000Z',
        message: {
          role: 'assistant',
          id: 'response-2',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ];

    const events = processTranscript(
      rows,
      'session-1',
      'qoder-work',
      { userId: 'user-1' },
      '/workspace',
      { rangeReason: 'incremental' },
    );

    const responses = events.filter(event => event['event.name'] === 'llm.response');
    expect(responses.map(event => event['gen_ai.response.finish_reasons'])).toEqual([
      ['tool_calls'],
      ['stop'],
    ]);
    expect(responses[1]['gen_ai.output.messages'][0].finish_reason).toBe('stop');

    const secondRequest = events.find(event =>
      event['event.name'] === 'llm.request' && event['gen_ai.step.id'] === 'turn-1:s2');
    const firstRequest = events.find(event =>
      event['event.name'] === 'llm.request' && event['gen_ai.step.id'] === 'turn-1:s1');
    expect(firstRequest['gen_ai.input.messages']).toBeUndefined();
    expect(secondRequest['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call',
          id: 'call-1',
          name: 'Read',
          arguments: { file_path: 'a.txt' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: 'file contents' }],
      },
    ]);
    expect(secondRequest['gen_ai.input.messages']).toBeUndefined();

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(events);
      expect(conversion.warnings).toEqual([]);
      const llmSpans = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
        .sort((left, right) => left.startTime[0] - right.startTime[0]
          || left.startTime[1] - right.startTime[1]);
      expect(llmSpans).toHaveLength(2);

      const convertedInput = JSON.parse(llmSpans[1].attributes['gen_ai.input.messages']);
      expect(convertedInput.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
      expect(convertedInput[1].parts.map(part => part.type)).toEqual(['tool_call']);
      expect(convertedInput[2].parts.map(part => part.type)).toEqual(['tool_call_response']);
      expect(convertedInput[1].parts[0].id).toBe('call-1');
      expect(convertedInput[2].parts[0].id).toBe('call-1');
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });

  it('carries the complete previous assistant output and keeps parallel tool results separate', async () => {
    const rows = [
      {
        type: 'user',
        uuid: 'user-1',
        promptId: 'turn-1',
        timestamp: '2026-08-25T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'run both tools' }] },
      },
      {
        type: 'assistant',
        uuid: 'assistant-thinking-1',
        parentUuid: 'user-1',
        timestamp: '2026-08-25T01:00:01.000Z',
        message: {
          role: 'assistant',
          id: 'response-1',
          content: [{ type: 'thinking', thinking: 'I need both results.' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tool-1',
        parentUuid: 'user-1',
        timestamp: '2026-08-25T01:00:01.100Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.txt' } }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tool-2',
        parentUuid: 'user-1',
        timestamp: '2026-08-25T01:00:01.200Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'b.txt' } }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-result-1',
        timestamp: '2026-08-25T01:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a contents' }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-result-2',
        timestamp: '2026-08-25T01:00:02.100Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'b contents' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-final-1',
        timestamp: '2026-08-25T01:00:03.000Z',
        message: {
          role: 'assistant',
          id: 'response-2',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ];

    const events = processTranscript(
      rows,
      'session-1',
      'qoder-work',
      { userId: 'user-1' },
      '/workspace',
      { rangeReason: 'incremental' },
    );
    const firstResponse = events.find(event =>
      event['event.name'] === 'llm.response' && event['gen_ai.step.id'] === 'turn-1:s1');
    const secondRequest = events.find(event =>
      event['event.name'] === 'llm.request' && event['gen_ai.step.id'] === 'turn-1:s2');

    expect(firstResponse['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [
        { type: 'reasoning', content: 'I need both results.' },
        { type: 'tool_call', id: 'call-1', name: 'Read', arguments: { file_path: 'a.txt' } },
        { type: 'tool_call', id: 'call-2', name: 'Read', arguments: { file_path: 'b.txt' } },
      ],
      finish_reason: 'tool_calls',
    }]);
    expect(secondRequest['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: firstResponse['gen_ai.output.messages'][0].parts,
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: 'a contents' }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-2', response: 'b contents' }],
      },
    ]);
    expect(secondRequest['gen_ai.input.messages']).toBeUndefined();

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(events);
      expect(conversion.warnings).toEqual([]);
      const llmSpans = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
        .sort((left, right) => left.startTime[0] - right.startTime[0]
          || left.startTime[1] - right.startTime[1]);
      const convertedInput = JSON.parse(llmSpans[1].attributes['gen_ai.input.messages']);
      expect(convertedInput.map(message => message.role)).toEqual([
        'user', 'assistant', 'tool', 'tool',
      ]);
      expect(convertedInput[1].parts.map(part => part.type)).toEqual([
        'reasoning', 'tool_call', 'tool_call',
      ]);
      expect(convertedInput.slice(2).map(message => message.parts[0].id)).toEqual([
        'call-1', 'call-2',
      ]);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });

  it('keeps assistant content but excludes parallel tool calls without results', async () => {
    const rows = [
      {
        type: 'user',
        uuid: 'user-1',
        promptId: 'turn-1',
        timestamp: '2026-08-25T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'run available tools' }] },
      },
      {
        type: 'assistant',
        uuid: 'assistant-thinking-1',
        timestamp: '2026-08-25T01:00:01.000Z',
        message: {
          role: 'assistant',
          id: 'response-1',
          content: [{ type: 'thinking', thinking: 'I will inspect both files.' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-text-1',
        timestamp: '2026-08-25T01:00:01.050Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Reading both files.' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tool-1',
        timestamp: '2026-08-25T01:00:01.100Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.txt' } }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tool-2',
        timestamp: '2026-08-25T01:00:01.200Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: 'b.txt' } }],
        },
      },
      {
        type: 'user',
        uuid: 'tool-result-1',
        timestamp: '2026-08-25T01:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a contents' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-final-1',
        timestamp: '2026-08-25T01:00:03.000Z',
        message: {
          role: 'assistant',
          id: 'response-2',
          content: [{ type: 'text', text: 'Only one result was available.' }],
        },
      },
    ];

    const events = processTranscript(
      rows,
      'session-1',
      'qoder-work',
      { userId: 'user-1' },
      '/workspace',
      { rangeReason: 'incremental' },
    );
    const secondRequest = events.find(event =>
      event['event.name'] === 'llm.request' && event['gen_ai.step.id'] === 'turn-1:s2');

    expect(secondRequest['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'I will inspect both files.' },
          { type: 'text', content: 'Reading both files.' },
          { type: 'tool_call', id: 'call-1', name: 'Read', arguments: { file_path: 'a.txt' } },
        ],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call-1', response: 'a contents' }],
      },
    ]);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(events);
      expect(conversion.warnings).toEqual([
        'Orphan tool.call (tool.call.id=call-2): no matching tool.result in step',
      ]);
      const llmSpans = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
        .sort((left, right) => left.startTime[0] - right.startTime[0]
          || left.startTime[1] - right.startTime[1]);
      const convertedInput = JSON.parse(llmSpans[1].attributes['gen_ai.input.messages']);
      expect(convertedInput.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
      expect(convertedInput[1].parts).toEqual(secondRequest['gen_ai.input.messages_delta'][0].parts);
      expect(convertedInput[2].parts[0].id).toBe('call-1');
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });
});
