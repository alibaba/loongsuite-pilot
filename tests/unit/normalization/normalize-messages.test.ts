import { describe, it, expect } from 'vitest';
import {
  normalizeOutputMessages,
  normalizeInputMessagesDelta,
  normalizeInputMessages,
} from '../../../src/normalization/normalize-messages.js';

describe('normalizeOutputMessages', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeOutputMessages(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(normalizeOutputMessages(null)).toBeUndefined();
  });

  it('wraps bare parts array into {role, parts}', () => {
    const input = [{ type: 'text', content: 'hello' }];
    expect(normalizeOutputMessages(input)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  it('wraps bare reasoning part', () => {
    const input = [{ type: 'reasoning', content: 'thinking...' }];
    expect(normalizeOutputMessages(input)).toEqual([
      { role: 'assistant', parts: [{ type: 'reasoning', content: 'thinking...' }] },
    ]);
  });

  it('wraps multiple bare parts into a single message', () => {
    const input = [
      { type: 'reasoning', content: 'think' },
      { type: 'text', content: 'answer' },
    ];
    expect(normalizeOutputMessages(input)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'think' },
          { type: 'text', content: 'answer' },
        ],
      },
    ]);
  });

  it('renames camelCase finishReason to snake_case finish_reason', () => {
    const input = [
      { role: 'assistant', parts: [{ type: 'text', content: 'hi' }], finishReason: 'stop' },
    ];
    expect(normalizeOutputMessages(input)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hi' }], finish_reason: 'stop' },
    ]);
  });

  it('passes through already canonical format unchanged', () => {
    const input = [
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }], finish_reason: 'stop' },
    ];
    expect(normalizeOutputMessages(input)).toEqual(input);
  });

  it('passes through canonical format without finish_reason', () => {
    const input = [
      { role: 'assistant', parts: [{ type: 'text', content: 'hello' }] },
    ];
    expect(normalizeOutputMessages(input)).toEqual(input);
  });

  it('returns empty array as-is', () => {
    expect(normalizeOutputMessages([])).toEqual([]);
  });
});

describe('normalizeInputMessagesDelta', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeInputMessagesDelta(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(normalizeInputMessagesDelta(null)).toBeUndefined();
  });

  it('converts flat content to parts array', () => {
    const input = [{ role: 'user', content: 'hello' }];
    expect(normalizeInputMessagesDelta(input)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  it('passes through already canonical format unchanged', () => {
    const input = [
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ];
    expect(normalizeInputMessagesDelta(input)).toEqual(input);
  });

  it('returns empty array as-is', () => {
    expect(normalizeInputMessagesDelta([])).toEqual([]);
  });
});

describe('normalizeInputMessages', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeInputMessages(undefined)).toBeUndefined();
  });

  it('converts flat content to parts array', () => {
    const input = [{ role: 'user', content: 'hello' }];
    expect(normalizeInputMessages(input)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  it('passes through already canonical format unchanged', () => {
    const input = [
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ];
    expect(normalizeInputMessages(input)).toEqual(input);
  });
});
