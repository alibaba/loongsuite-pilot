import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFromCodeGenerationEvent } from '../../../src/normalization/entry-builder.js';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { CodeGenerationEvent } from '../../../src/types/index.js';

vi.mock('uuid', () => ({ v4: vi.fn().mockReturnValue('mock-uuid') }));

describe('buildFromCodeGenerationEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps agentType from event', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Cursor,
      filePath: '/a.ts',
      actionType: ActionType.Create,
      sourceTimestamp: 1700000000000,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.agentType).toBe(ClientType.Cursor);
  });

  it('maps actionType from event', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/a.ts',
      actionType: ActionType.Delete,
      sourceTimestamp: 1700000000000,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.actionType).toBe(ActionType.Delete);
  });

  it('maps filePath from event', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/src/foo.ts',
      actionType: ActionType.Edit,
      sourceTimestamp: 1700000000000,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.filePath).toBe('/src/foo.ts');
  });

  it('maps content from event', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/a.ts',
      actionType: ActionType.Edit,
      content: 'the content',
      sourceTimestamp: 1700000000000,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.content).toBe('the content');
  });

  it('maps diff to inlineDiffMessage', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/a.ts',
      actionType: ActionType.Edit,
      diff: '--- a\n+++ b',
      sourceTimestamp: 1700000000000,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.inlineDiffMessage).toBe('--- a\n+++ b');
  });

  it('maps rawData to extra', () => {
    const rawData = { key1: 'val1', key2: 123 };
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/a.ts',
      actionType: ActionType.Edit,
      sourceTimestamp: 1700000000000,
      rawData,
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.extra).toEqual(rawData);
  });

  it('uses sourceTimestamp as entry timestamp', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/a.ts',
      actionType: ActionType.Edit,
      sourceTimestamp: 1234567890,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'u1', 's1');
    expect(entry.timestamp).toBe(1234567890);
  });

  it('sets userId and sessionId from arguments', () => {
    const event: CodeGenerationEvent = {
      agentType: ClientType.Qoder,
      filePath: '/a.ts',
      actionType: ActionType.Edit,
      sourceTimestamp: 1700000000000,
      rawData: {},
    };
    const entry = buildFromCodeGenerationEvent(event, 'user-X', 'session-Y');
    expect(entry.userId).toBe('user-X');
    expect(entry.sessionId).toBe('session-Y');
  });
});
