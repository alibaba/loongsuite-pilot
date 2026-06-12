import { describe, it, expect } from 'vitest';
import { normalizeAgentType } from '../../../src/utils/agent-type-normalize.js';

describe('normalizeAgentType', () => {
  it('returns already-normalized values unchanged', () => {
    expect(normalizeAgentType('claude-code')).toBe('claude-code');
    expect(normalizeAgentType('qoder-cli')).toBe('qoder-cli');
    expect(normalizeAgentType('cursor-hook')).toBe('cursor-hook');
  });

  it('lowercases input', () => {
    expect(normalizeAgentType('Claude-Code')).toBe('claude-code');
    expect(normalizeAgentType('QODER')).toBe('qoder');
  });

  it('collapses non-alphanumeric runs to single dash', () => {
    expect(normalizeAgentType('Qoder CLI')).toBe('qoder-cli');
    expect(normalizeAgentType('qoder__work')).toBe('qoder-work');
    expect(normalizeAgentType('foo@bar#baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing dashes', () => {
    expect(normalizeAgentType('--claude-code--')).toBe('claude-code');
    expect(normalizeAgentType(' cursor ')).toBe('cursor');
  });

  it('returns unknown for empty or pure non-alphanumeric input', () => {
    expect(normalizeAgentType('')).toBe('unknown');
    expect(normalizeAgentType('---')).toBe('unknown');
    expect(normalizeAgentType('   ')).toBe('unknown');
  });
});
