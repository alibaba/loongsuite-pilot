import { describe, it, expect } from 'vitest';
import { serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1700000000000000000',
    'event.id': 'test-uuid',
    'event.name': 'event',
    'user.id': 'user-1',
    'session.id': 'sess-1',
    'agent.type': ClientType.Qoder,
    attributes: { filePath: '/src/app.ts' },
    ...overrides,
  };
}

describe('serialiseLogEntry', () => {
  it('serializes basic fields', () => {
    const out = serialiseLogEntry(makeEntry());
    expect(out['session.id']).toBe('sess-1');
    expect(out['event.id']).toBe('test-uuid');
    expect(out['user.id']).toBe('user-1');
    expect(out['agent.type']).toBe('qoder');
    expect(out['event.name']).toBe('event');
  });

  it('serializes standard extra attributes as JSON', () => {
    const out = serialiseLogEntry(makeEntry({
      attributes: { customKey: 'customVal' },
    }));
    expect(out.attributes).toBe(JSON.stringify({ customKey: 'customVal' }));
  });

  it('converts scalar values to strings', () => {
    const out = serialiseLogEntry(makeEntry({
      'usage.input_tokens': 42,
      is_error: true,
    }));
    expect(out['usage.input_tokens']).toBe('42');
    expect(out.is_error).toBe('true');
  });

  it('JSON.stringifies JSON object values', () => {
    const nested = { a: 1 };
    const out = serialiseLogEntry(makeEntry({
      'tool.arguments': nested,
    }));
    expect(out['tool.arguments']).toBe(JSON.stringify(nested));
  });

  it('keeps content fields before endpoint redaction', () => {
    const out = serialiseLogEntry(makeEntry({
      'tool.result.payload': { output: 'visible' },
    }));
    expect(out['tool.result.payload']).toBe(JSON.stringify({ output: 'visible' }));
  });

  it('skips null and undefined values', () => {
    const out = serialiseLogEntry(makeEntry({
      'provider.name': undefined,
      'tool.arguments': null as any,
    }));
    expect(out).not.toHaveProperty('provider.name');
    expect(out).not.toHaveProperty('tool.arguments');
  });

  it('serializes nanosecond timestamp as-is', () => {
    const out = serialiseLogEntry(makeEntry({ time_unix_nano: '1700000000000000000' }));
    expect(out.time_unix_nano).toBe('1700000000000000000');
  });

  it('includes input messages when present', () => {
    const out = serialiseLogEntry(makeEntry({ 'input.messages_delta': [{ role: 'user', content: 'hi' }] }));
    expect(out['input.messages_delta']).toBe(JSON.stringify([{ role: 'user', content: 'hi' }]));
  });

  it('includes output messages when present', () => {
    const out = serialiseLogEntry(makeEntry({ 'output.messages': [{ type: 'text', content: 'ok' }] }));
    expect(out['output.messages']).toBe(JSON.stringify([{ type: 'text', content: 'ok' }]));
  });

  it('omits optional message fields when undefined', () => {
    const out = serialiseLogEntry(makeEntry());
    expect(out).not.toHaveProperty('input.messages_delta');
    expect(out).not.toHaveProperty('output.messages');
  });
});
