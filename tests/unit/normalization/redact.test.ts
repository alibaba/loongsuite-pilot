import { describe, it, expect } from 'vitest';
import { redactCodeGenerationFields } from '../../../src/normalization/entry-builder.js';
import type { SerializedLogEntry } from '../../../src/types/index.js';

describe('redactCodeGenerationFields', () => {
  it('removes filePath, content, and inlineDiffMessage', () => {
    const input: SerializedLogEntry = {
      sessionId: 's1',
      uuid: 'u1',
      filePath: '/src/app.ts',
      content: 'secret code',
      inlineDiffMessage: 'diff here',
      agentType: 'qoder',
    };
    const out = redactCodeGenerationFields(input);
    expect(out).not.toHaveProperty('filePath');
    expect(out).not.toHaveProperty('content');
    expect(out).not.toHaveProperty('inlineDiffMessage');
    expect(out.sessionId).toBe('s1');
    expect(out.uuid).toBe('u1');
    expect(out.agentType).toBe('qoder');
  });

  it('returns a new object without mutating the original', () => {
    const input: SerializedLogEntry = {
      filePath: '/a.ts',
      content: 'code',
      inlineDiffMessage: 'diff',
      sessionId: 's',
    };
    const out = redactCodeGenerationFields(input);
    expect(input.filePath).toBe('/a.ts');
    expect(input.content).toBe('code');
    expect(input.inlineDiffMessage).toBe('diff');
    expect(out).not.toBe(input);
  });

  it('does not alter output when fields are already missing', () => {
    const input: SerializedLogEntry = {
      sessionId: 's1',
      uuid: 'u1',
      agentType: 'qoder',
    };
    const out = redactCodeGenerationFields(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('preserves all non-redacted fields', () => {
    const input: SerializedLogEntry = {
      sessionId: 's',
      uuid: 'u',
      userId: 'uid',
      agentType: 'qoder',
      actionType: 'edit',
      repoId: 'repo',
      branchName: 'main',
      commitHash: 'abc',
      customField: 'keep-me',
      filePath: '/remove',
      content: 'remove',
      inlineDiffMessage: 'remove',
    };
    const out = redactCodeGenerationFields(input);
    expect(out.sessionId).toBe('s');
    expect(out.uuid).toBe('u');
    expect(out.userId).toBe('uid');
    expect(out.repoId).toBe('repo');
    expect(out.customField).toBe('keep-me');
  });
});
