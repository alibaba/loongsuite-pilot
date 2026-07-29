import { describe, it, expect } from 'vitest';
import { buildAgentActivityEntry, serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1700000000000000000',
    'event.id': 'test-uuid',
    'event.name': 'other',
    'user.id': 'user-1',
    'gen_ai.session.id': 'sess-1',
    'gen_ai.agent.type': ClientType.Qoder,
    'gen_ai.provider.name': 'qwen',
    'agent.file_path': '/src/app.ts',
    ...overrides,
  };
}

describe('serialiseLogEntry', () => {
  it('serializes basic fields', () => {
    const out = serialiseLogEntry(makeEntry());
    expect(out['gen_ai.session.id']).toBe('sess-1');
    expect(out['event.id']).toBe('test-uuid');
    expect(out['user.id']).toBe('user-1');
    expect(out['gen_ai.agent.type']).toBe('qoder');
    expect(out['event.name']).toBe('other');
  });

  it('serializes standard extra fields', () => {
    const out = serialiseLogEntry(makeEntry({
      'agent.custom_key': 'customVal',
    }));
    expect(out['agent.custom_key']).toBe('customVal');
  });

  it('drops agent-scoped extension fields when requested', () => {
    const out = serialiseLogEntry(makeEntry({
      'agent.qoder.cwd': '/workspace/project',
      'agent.cursor.hook_event_name': 'preToolUse',
      'agent.qoderwork.promptId': 'prompt-1',
      'agent.custom_key': 'customVal',
    }), { dropAgentScopedFields: true });

    expect(out).not.toHaveProperty('agent.qoder.cwd');
    expect(out).not.toHaveProperty('agent.cursor.hook_event_name');
    expect(out).not.toHaveProperty('agent.qoderwork.promptId');
    expect(out['agent.custom_key']).toBe('customVal');
    expect(out['agent.file_path']).toBe('/src/app.ts');
    expect(out['gen_ai.agent.type']).toBe('qoder');
  });

  it('converts scalar values to strings', () => {
    const out = serialiseLogEntry(makeEntry({
      'gen_ai.usage.input_tokens': 42,
    }));
    expect(out['gen_ai.usage.input_tokens']).toBe('42');
  });

  it('JSON.stringifies JSON object values', () => {
    const nested = { a: 1 };
    const out = serialiseLogEntry(makeEntry({
      'gen_ai.tool.call.arguments': nested,
    }));
    expect(out['gen_ai.tool.call.arguments']).toBe(JSON.stringify(nested));
  });

  it('keeps content fields before endpoint redaction', () => {
    const out = serialiseLogEntry(makeEntry({
      'gen_ai.tool.call.result': { output: 'visible' },
    }));
    expect(out['gen_ai.tool.call.result']).toBe(JSON.stringify({ output: 'visible' }));
  });

  it('keeps tool result status as a serialized field', () => {
    const out = serialiseLogEntry(makeEntry({ 'tool.result.status': 'cancelled' }));

    expect(out['tool.result.status']).toBe('cancelled');
  });

  it('normalizes completed tool results before serializing the global status field', () => {
    const entry = buildAgentActivityEntry({
      ...makeEntry({ 'event.name': 'tool.result' }),
      'tool.result.status': 'completed',
    });

    expect(serialiseLogEntry(entry)['tool.result.status']).toBe('success');
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
    const out = serialiseLogEntry(makeEntry({ 'gen_ai.input.messages_delta': [{ role: 'user', content: 'hi' }] }));
    expect(out['gen_ai.input.messages_delta']).toBe(JSON.stringify([{ role: 'user', content: 'hi' }]));
  });

  it('includes output messages when present', () => {
    const out = serialiseLogEntry(makeEntry({ 'gen_ai.output.messages': [{ type: 'text', content: 'ok' }] }));
    expect(out['gen_ai.output.messages']).toBe(JSON.stringify([{ type: 'text', content: 'ok' }]));
  });

  it('serializes canonical source contract fields', () => {
    const out = serialiseLogEntry(makeEntry({
      'git.repo': 'sls/loongsuite-pilot',
      'git.branch': 'feature/source-contract',
      'workspace.current_root': '/Users/yutao/workspace/sls/loongsuite-pilot',
    }));

    expect(out['git.repo']).toBe('sls/loongsuite-pilot');
    expect(out['git.branch']).toBe('feature/source-contract');
    expect(out['workspace.current_root']).toBe('/Users/yutao/workspace/sls/loongsuite-pilot');
  });

  it('omits optional message fields when undefined', () => {
    const out = serialiseLogEntry(makeEntry());
    expect(out).not.toHaveProperty('gen_ai.input.messages_delta');
    expect(out).not.toHaveProperty('gen_ai.output.messages');
  });

  it('omits legacy aliases from new output', () => {
    const out = serialiseLogEntry(makeEntry({
      'session.id': 'legacy-session',
      'agent.type': ClientType.Cursor,
      'usage.input_tokens': 42,
      'tool.arguments': { legacy: true },
      'gen_ai.message.role': 'user',
      is_error: true,
      attributes: { legacy: true },
    }));
    expect(out).not.toHaveProperty('session.id');
    expect(out).not.toHaveProperty('agent.type');
    expect(out).not.toHaveProperty('usage.input_tokens');
    expect(out).not.toHaveProperty('tool.arguments');
    expect(out).not.toHaveProperty('gen_ai.message.role');
    expect(out).not.toHaveProperty('is_error');
    expect(out).not.toHaveProperty('attributes');
  });
});
