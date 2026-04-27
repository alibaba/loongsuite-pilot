import { describe, it, expect } from 'vitest';
import { AgentActivityEntrySchema } from './agent-activity-schema.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { ClientType, ActionType } from '../../src/types/index.js';

describe('AgentActivityEntry contract', () => {
  it('should validate a minimal entry from buildAgentActivityEntry', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 'sess-1',
      userId: 'user-1',
      agentType: ClientType.Qoder,
      actionType: ActionType.Edit,
      filePath: '/tmp/test.ts',
    });

    const result = AgentActivityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should validate an entry with all optional fields', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 'sess-2',
      userId: 'user-2',
      agentType: ClientType.Openclaw,
      actionType: ActionType.Create,
      filePath: '/tmp/new-file.ts',
      content: 'const x = 1;',
      inlineDiffMessage: '+const x = 1;',
      git: {
        repoId: 'https://github.com/test/repo',
        branchName: 'main',
        commitHash: 'abc123',
      },
      extra: { toolName: 'write_file', model: 'claude-3' },
    });

    const result = AgentActivityEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('should produce a valid uuid v4', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 'sess-3',
      userId: 'user-3',
      agentType: ClientType.QoderWork,
      actionType: ActionType.Other,
      filePath: '',
    });

    expect(entry.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('should default timestamp to a positive integer', () => {
    const entry = buildAgentActivityEntry({
      sessionId: 'sess-4',
      userId: 'user-4',
      agentType: ClientType.Qoder,
      actionType: ActionType.Edit,
      filePath: '/test.ts',
    });

    expect(entry.timestamp).toBeGreaterThan(0);
    expect(Number.isInteger(entry.timestamp)).toBe(true);
  });

  it('should reject an entry with invalid agentType', () => {
    const bad = {
      sessionId: 'sess',
      timestamp: Date.now(),
      uuid: '00000000-0000-4000-a000-000000000000',
      userId: 'u',
      agentType: 'invalid-agent' as ClientType,
      actionType: ActionType.Edit,
      filePath: '/test.ts',
    };

    const result = AgentActivityEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should reject an entry with invalid actionType', () => {
    const bad = {
      sessionId: 'sess',
      timestamp: Date.now(),
      uuid: '00000000-0000-4000-a000-000000000000',
      userId: 'u',
      agentType: ClientType.Qoder,
      actionType: 'invalid-action' as ActionType,
      filePath: '/test.ts',
    };

    const result = AgentActivityEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should reject a non-UUIDv4 uuid', () => {
    const bad = {
      sessionId: 'sess',
      timestamp: Date.now(),
      uuid: 'not-a-uuid',
      userId: 'u',
      agentType: ClientType.Qoder,
      actionType: ActionType.Edit,
      filePath: '/test.ts',
    };

    const result = AgentActivityEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should reject a negative timestamp', () => {
    const bad = {
      sessionId: 'sess',
      timestamp: -100,
      uuid: '00000000-0000-4000-a000-000000000000',
      userId: 'u',
      agentType: ClientType.Qoder,
      actionType: ActionType.Edit,
      filePath: '/test.ts',
    };

    const result = AgentActivityEntrySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('should cover all ClientType enum values', () => {
    for (const ct of Object.values(ClientType)) {
      const entry = buildAgentActivityEntry({
        sessionId: 'sess',
        userId: 'u',
        agentType: ct,
        actionType: ActionType.Edit,
        filePath: '/f.ts',
      });
      const result = AgentActivityEntrySchema.safeParse(entry);
      expect(result.success, `ClientType.${ct} should be valid`).toBe(true);
    }
  });

  it('should cover all ActionType enum values', () => {
    for (const at of Object.values(ActionType)) {
      const entry = buildAgentActivityEntry({
        sessionId: 'sess',
        userId: 'u',
        agentType: ClientType.Qoder,
        actionType: at,
        filePath: '/f.ts',
      });
      const result = AgentActivityEntrySchema.safeParse(entry);
      expect(result.success, `ActionType.${at} should be valid`).toBe(true);
    }
  });
});
