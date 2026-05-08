import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
import { ClientType, ActionType } from '../../../src/types/index.js';

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid'),
}));

import { v4 as mockUuidV4 } from 'uuid';

describe('buildAgentActivityEntry', () => {
  let nowSpy: MockInstance<[], number>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    nowSpy.mockRestore();
    vi.mocked(mockUuidV4).mockClear();
  });

  it('generates unique UUIDs per call', () => {
    vi.mocked(mockUuidV4)
      .mockReturnValueOnce('uuid-aaa')
      .mockReturnValueOnce('uuid-bbb');

    const a = buildAgentActivityEntry({
      sessionId: 's1', userId: 'u1',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
    });
    const b = buildAgentActivityEntry({
      sessionId: 's1', userId: 'u1',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/b.ts',
    });
    expect(a['event.id']).toBe('uuid-aaa');
    expect(b['event.id']).toBe('uuid-bbb');
    expect(a['event.id']).not.toBe(b['event.id']);
  });

  it('auto-fills timestamp with Date.now when not provided', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's1', userId: 'u1',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
    });
    expect(entry.time_unix_nano).toBe('1700000000000000000');
  });

  it('uses explicit timestamp when provided', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's1', userId: 'u1',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
      timestamp: 9999,
    });
    expect(entry.time_unix_nano).toBe('9999000000000');
  });

  it('includes all required fields', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 'sess-abc', userId: 'user-42',
      agentType: ClientType.Cursor, actionType: ActionType.Create,
      filePath: '/src/main.ts',
    });
    expect(entry).toMatchObject({
      'gen_ai.session.id': 'sess-abc',
      'user.id': 'user-42',
      'gen_ai.agent.type': ClientType.Cursor,
      'gen_ai.provider.name': 'unknown',
    });
    expect(entry['event.id']).toBe('mock-uuid');
    expect(entry['agent.action_type']).toBe(ActionType.Create);
    expect(entry['agent.file_path']).toBe('/src/main.ts');
  });

  it('carries optional content field', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts', content: 'hello world',
    });
    expect(entry['agent.content']).toBe('hello world');
  });

  it('carries optional extra record', () => {
    const extra = { foo: 'bar', num: 42 };
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts', extra,
    });
    expect(entry).toMatchObject({ 'agent.foo': 'bar', 'agent.num': 42 });
  });

  it('does not let extra agent fields override legacy option fields', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.QoderWork, actionType: ActionType.Edit,
      filePath: '/source.ts', content: 'from option',
      extra: {
        type: 'user',
        'agent.type': 'user',
        file_path: '/extra.ts',
        action_type: ActionType.Other,
        content: 'from extra',
      },
    });

    expect(entry['gen_ai.agent.type']).toBe(ClientType.QoderWork);
    expect(entry['agent.file_path']).toBe('/source.ts');
    expect(entry['agent.action_type']).toBe(ActionType.Edit);
    expect(entry['agent.content']).toBe('from option');
  });

  it('leaves optional fields undefined when not provided', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
    });
    expect(entry['agent.content']).toBeUndefined();
    expect(entry['agent.inline_diff_message']).toBeUndefined();
  });
});
