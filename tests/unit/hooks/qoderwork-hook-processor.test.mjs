import { describe, expect, it } from 'vitest';
import {
  extractText,
  getTurnIdForRows,
  isSystemInjection,
  isToolResult,
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
