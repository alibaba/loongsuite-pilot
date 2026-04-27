import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
import { ClientType, ActionType } from '../../../src/types/index.js';

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid'),
}));

import { v4 as mockUuidV4 } from 'uuid';

describe('buildAgentActivityEntry', () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

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
    expect(a.uuid).toBe('uuid-aaa');
    expect(b.uuid).toBe('uuid-bbb');
    expect(a.uuid).not.toBe(b.uuid);
  });

  it('auto-fills timestamp with Date.now when not provided', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's1', userId: 'u1',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
    });
    expect(entry.timestamp).toBe(1700000000000);
  });

  it('uses explicit timestamp when provided', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's1', userId: 'u1',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
      timestamp: 9999,
    });
    expect(entry.timestamp).toBe(9999);
  });

  it('includes all required fields', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 'sess-abc', userId: 'user-42',
      agentType: ClientType.Cursor, actionType: ActionType.Create,
      filePath: '/src/main.ts',
    });
    expect(entry).toMatchObject({
      sessionId: 'sess-abc',
      userId: 'user-42',
      agentType: ClientType.Cursor,
      actionType: ActionType.Create,
      filePath: '/src/main.ts',
    });
    expect(entry.uuid).toBe('mock-uuid');
    expect(entry.timestamp).toBe(1700000000000);
  });

  it('carries optional content field', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts', content: 'hello world',
    });
    expect(entry.content).toBe('hello world');
  });

  it('carries optional git context', () => {
    const git = { repoId: 'org/repo', branchName: 'main', commitHash: 'abc123' };
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts', git,
    });
    expect(entry.git).toEqual(git);
  });

  it('carries optional extra record', () => {
    const extra = { foo: 'bar', num: 42 };
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts', extra,
    });
    expect(entry.extra).toEqual(extra);
  });

  it('leaves optional fields undefined when not provided', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 's', userId: 'u',
      agentType: ClientType.Qoder, actionType: ActionType.Edit,
      filePath: '/a.ts',
    });
    expect(entry.content).toBeUndefined();
    expect(entry.inlineDiffMessage).toBeUndefined();
    expect(entry.git).toBeUndefined();
    expect(entry.extra).toBeUndefined();
  });
});
