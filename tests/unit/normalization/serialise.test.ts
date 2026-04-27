import { describe, it, expect } from 'vitest';
import { serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    sessionId: 'sess-1',
    timestamp: 1700000000000,
    uuid: 'test-uuid',
    userId: 'user-1',
    agentType: ClientType.Qoder,
    actionType: ActionType.Edit,
    filePath: '/src/app.ts',
    ...overrides,
  };
}

describe('serialiseLogEntry', () => {
  it('serializes basic fields', () => {
    const out = serialiseLogEntry(makeEntry());
    expect(out.sessionId).toBe('sess-1');
    expect(out.uuid).toBe('test-uuid');
    expect(out.userId).toBe('user-1');
    expect(out.agentType).toBe('qoder');
    expect(out.actionType).toBe('edit');
    expect(out.filePath).toBe('/src/app.ts');
  });

  it('flattens Git context into top-level fields', () => {
    const out = serialiseLogEntry(makeEntry({
      git: { repoId: 'org/repo', branchName: 'feat', commitHash: 'abc' },
    }));
    expect(out.repoId).toBe('org/repo');
    expect(out.branchName).toBe('feat');
    expect(out.commitHash).toBe('abc');
  });

  it('omits git fields when git is undefined', () => {
    const out = serialiseLogEntry(makeEntry({ git: undefined }));
    expect(out).not.toHaveProperty('repoId');
    expect(out).not.toHaveProperty('branchName');
    expect(out).not.toHaveProperty('commitHash');
  });

  it('merges extra fields into top level', () => {
    const out = serialiseLogEntry(makeEntry({
      extra: { customKey: 'customVal' },
    }));
    expect(out.customKey).toBe('customVal');
  });

  it('converts extra values to strings', () => {
    const out = serialiseLogEntry(makeEntry({
      extra: { num: 42, bool: true },
    }));
    expect(out.num).toBe('42');
    expect(out.bool).toBe('true');
  });

  it('JSON.stringifies object values in extra', () => {
    const nested = { a: 1 };
    const out = serialiseLogEntry(makeEntry({
      extra: { nested },
    }));
    expect(out.nested).toBe(JSON.stringify(nested));
  });

  it('filters redacted keys from extra', () => {
    const out = serialiseLogEntry(makeEntry({
      extra: {
        filePath: 'leaked',
        content: 'leaked',
        inlineDiffMessage: 'leaked',
        recorduuid: 'leaked',
        distinctid: 'leaked',
        safeKey: 'kept',
      },
    }));
    expect(out.safeKey).toBe('kept');
    // Extra values with redacted keys should not overwrite top-level fields
    // or appear additionally
    expect(out.filePath).toBe('/src/app.ts'); // original, not from extra
  });

  it('skips null and undefined values in extra', () => {
    const out = serialiseLogEntry(makeEntry({
      extra: { n: null, u: undefined, valid: 'ok' } as any,
    }));
    expect(out).not.toHaveProperty('n');
    expect(out).not.toHaveProperty('u');
    expect(out.valid).toBe('ok');
  });

  it('converts second-level timestamp to millis', () => {
    const out = serialiseLogEntry(makeEntry({ timestamp: 1700000000 }));
    expect(out.timestamp).toBe('1700000000000');
  });

  it('keeps millisecond timestamp as-is', () => {
    const out = serialiseLogEntry(makeEntry({ timestamp: 1700000000000 }));
    expect(out.timestamp).toBe('1700000000000');
  });

  it('includes content when present', () => {
    const out = serialiseLogEntry(makeEntry({ content: 'some code' }));
    expect(out.content).toBe('some code');
  });

  it('includes inlineDiffMessage when present', () => {
    const out = serialiseLogEntry(makeEntry({ inlineDiffMessage: 'diff text' }));
    expect(out.inlineDiffMessage).toBe('diff text');
  });

  it('omits content/inlineDiffMessage when undefined', () => {
    const out = serialiseLogEntry(makeEntry());
    expect(out).not.toHaveProperty('content');
    expect(out).not.toHaveProperty('inlineDiffMessage');
  });
});

describe('normalizeTimestampToMillis boundary cases (T007)', () => {
  it('ts=0 is treated as seconds and becomes 0', () => {
    const out = serialiseLogEntry(makeEntry({ timestamp: 0 }));
    expect(out.timestamp).toBe('0');
  });

  it('ts<0 is treated as seconds and multiplied by 1000', () => {
    const out = serialiseLogEntry(makeEntry({ timestamp: -100 }));
    expect(out.timestamp).toBe('-100000');
  });

  it('ts exactly 1e12 is treated as millis', () => {
    const out = serialiseLogEntry(makeEntry({ timestamp: 1e12 }));
    expect(out.timestamp).toBe('1000000000000');
  });

  it('ts just below 1e12 is treated as seconds', () => {
    const out = serialiseLogEntry(makeEntry({ timestamp: 999999999999 }));
    expect(out.timestamp).toBe('999999999999000');
  });
});
