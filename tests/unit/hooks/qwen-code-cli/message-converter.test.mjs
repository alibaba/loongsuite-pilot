import { describe, expect, test } from 'vitest';
import {
  convertQwenPart,
  convertQwenParts,
  buildOutputMessages,
  buildInputMessagesDelta,
  inferAssistantFinishReason,
} from '../../../../assets/hooks/qwen-code-cli/message-converter.mjs';

describe('convertQwenPart', () => {
  test('text part → text', () => {
    expect(convertQwenPart({ text: 'hello' })).toEqual({ type: 'text', content: 'hello' });
  });

  test('thought-tagged text → reasoning (not text)', () => {
    expect(convertQwenPart({ text: 'thinking...', thought: true })).toEqual({
      type: 'reasoning',
      content: 'thinking...',
    });
  });

  test('thought=false → text (not reasoning)', () => {
    expect(convertQwenPart({ text: 'hi', thought: false })).toEqual({
      type: 'text',
      content: 'hi',
    });
  });

  test('functionCall with id → tool_call', () => {
    const p = { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'call_123' } };
    expect(convertQwenPart(p)).toEqual({
      type: 'tool_call',
      id: 'call_123',
      name: 'Bash',
      arguments: { cmd: 'ls' },
    });
  });

  test('functionCall without id → tool_call with null id', () => {
    const p = { functionCall: { name: 'Bash', args: {} } };
    expect(convertQwenPart(p)).toEqual({
      type: 'tool_call',
      id: null,
      name: 'Bash',
      arguments: {},
    });
  });

  test('functionResponse → tool_call_response with externally-provided id', () => {
    const p = { functionResponse: { name: 'Bash', response: { stdout: 'ok' } } };
    expect(convertQwenPart(p, 'call_456')).toEqual({
      type: 'tool_call_response',
      id: 'call_456',
      response: { stdout: 'ok' },
    });
  });

  test('functionResponse without id arg → null id', () => {
    const p = { functionResponse: { name: 'Bash', response: 'ok' } };
    expect(convertQwenPart(p)).toEqual({
      type: 'tool_call_response',
      id: null,
      response: 'ok',
    });
  });

  test('unknown part shape → null', () => {
    expect(convertQwenPart({})).toBeNull();
    expect(convertQwenPart(null)).toBeNull();
    expect(convertQwenPart({ unknownField: 'x' })).toBeNull();
  });
});

describe('convertQwenParts', () => {
  test('preserves source order: reasoning + text + tool_call (C5 critical)', () => {
    const qwenParts = [
      { text: 'I should call ls.', thought: true },
      { text: 'Sure, here it is.' },
      { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } },
    ];
    const result = convertQwenParts(qwenParts);
    expect(result).toEqual([
      { type: 'reasoning', content: 'I should call ls.' },
      { type: 'text', content: 'Sure, here it is.' },
      { type: 'tool_call', id: 'c1', name: 'Bash', arguments: { cmd: 'ls' } },
    ]);
  });

  test('drops unknown parts', () => {
    const result = convertQwenParts([{ text: 'a' }, { weird: 1 }, { text: 'b' }]);
    expect(result).toEqual([
      { type: 'text', content: 'a' },
      { type: 'text', content: 'b' },
    ]);
  });

  test('empty / non-array input → []', () => {
    expect(convertQwenParts([])).toEqual([]);
    expect(convertQwenParts(null)).toEqual([]);
    expect(convertQwenParts('not-array')).toEqual([]);
  });

  test('multiple functionCalls all preserved', () => {
    const qwenParts = [
      { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } },
      { functionCall: { name: 'Bash', args: { cmd: 'pwd' }, id: 'c2' } },
      { functionCall: { name: 'Read', args: { path: '/tmp' }, id: 'c3' } },
    ];
    const result = convertQwenParts(qwenParts);
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.name)).toEqual(['Bash', 'Bash', 'Read']);
  });
});

describe('buildOutputMessages (C5: single message, multi-part)', () => {
  test('assistant with reasoning+text+tool_call → 1 message with 3 parts', () => {
    const record = {
      type: 'assistant',
      message: {
        role: 'model',
        parts: [
          { text: 'Let me think...', thought: true },
          { text: 'Here you go.' },
          { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } },
        ],
      },
    };
    const result = buildOutputMessages(record);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].parts).toHaveLength(3);
    expect(result[0].finish_reason).toBe('tool_call');
  });

  test('assistant with only text → finish_reason=stop', () => {
    const record = {
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'final answer' }] },
    };
    expect(buildOutputMessages(record)[0].finish_reason).toBe('stop');
  });

  test('empty parts → empty parts + finish_reason=stop', () => {
    const result = buildOutputMessages({ type: 'assistant', message: { parts: [] } });
    expect(result[0].parts).toEqual([]);
    expect(result[0].finish_reason).toBe('stop');
  });
});

describe('inferAssistantFinishReason', () => {
  test('has functionCall → tool_call (singular per pilot convention)', () => {
    const r = { message: { parts: [{ text: 'x' }, { functionCall: { name: 'F' } }] } };
    expect(inferAssistantFinishReason(r)).toBe('tool_call');
  });

  test('no functionCall → stop', () => {
    expect(inferAssistantFinishReason({ message: { parts: [{ text: 'x' }] } })).toBe('stop');
  });

  test('missing parts → stop', () => {
    expect(inferAssistantFinishReason({})).toBe('stop');
    expect(inferAssistantFinishReason({ message: {} })).toBe('stop');
  });
});

describe('buildInputMessagesDelta', () => {
  test('user record → role=user', () => {
    const records = [
      {
        uuid: 'u1', type: 'user',
        message: { role: 'user', parts: [{ text: 'hello' }] },
      },
    ];
    expect(buildInputMessagesDelta(records)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  test('tool_result record → role=tool with tool_call_response part (id from toolCallResult.callId)', () => {
    const records = [
      {
        uuid: 'tr1', type: 'tool_result',
        message: { role: 'user', parts: [{ functionResponse: { name: 'Bash', response: { stdout: 'ok' } } }] },
        toolCallResult: { callId: 'call_abc' },
      },
    ];
    expect(buildInputMessagesDelta(records)).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_abc', response: { stdout: 'ok' } }],
      },
    ]);
  });

  test('tool_result with explicit toolCallIdByResponseUuid map override', () => {
    const records = [
      {
        uuid: 'tr1', type: 'tool_result',
        message: { parts: [{ functionResponse: { name: 'B', response: 'x' } }] },
        toolCallResult: { callId: 'wrong' },
      },
    ];
    const idMap = new Map([['tr1', 'correct_call_id']]);
    const result = buildInputMessagesDelta(records, idMap);
    expect(result[0].parts[0].id).toBe('correct_call_id');
  });

  test('mixed user + tool_result preserves order', () => {
    const records = [
      { uuid: 'u1', type: 'user', message: { parts: [{ text: 'q1' }] } },
      {
        uuid: 'tr1', type: 'tool_result',
        message: { parts: [{ functionResponse: { response: 'r1' } }] },
        toolCallResult: { callId: 'c1' },
      },
      { uuid: 'u2', type: 'user', subtype: 'mid_turn_user_message', message: { parts: [{ text: 'q2' }] } },
    ];
    const result = buildInputMessagesDelta(records);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('tool');
    expect(result[2].role).toBe('user');
  });

  test('records with no parts are skipped', () => {
    const records = [
      { uuid: 'x', type: 'user', message: { parts: [] } },
      { uuid: 'y', type: 'user', message: {} },
    ];
    expect(buildInputMessagesDelta(records)).toEqual([]);
  });
});
