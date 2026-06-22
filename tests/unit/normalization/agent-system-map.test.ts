import { describe, it, expect } from 'vitest';
import { resolveAgentSystem, AGENT_SYSTEM_MAP } from '../../../src/normalization/agent-system-map.js';

describe('resolveAgentSystem', () => {
  it('maps claude-code to claude', () => {
    expect(resolveAgentSystem('claude-code')).toBe('claude');
  });

  it('maps codex variants to codex', () => {
    expect(resolveAgentSystem('codex')).toBe('codex');
    expect(resolveAgentSystem('codex-session')).toBe('codex');
  });

  it('maps qoder variants to qoder', () => {
    expect(resolveAgentSystem('qoder')).toBe('qoder');
    expect(resolveAgentSystem('qoder-idea')).toBe('qoder');
    expect(resolveAgentSystem('qoder-work')).toBe('qoder');
    expect(resolveAgentSystem('qoder-work-cn')).toBe('qoder');
    expect(resolveAgentSystem('qoder-cli')).toBe('qoder');
    expect(resolveAgentSystem('qoder-cli-hook')).toBe('qoder');
  });

  it('maps cursor variants to cursor', () => {
    expect(resolveAgentSystem('cursor')).toBe('cursor');
    expect(resolveAgentSystem('cursor-hook')).toBe('cursor');
  });

  it('maps qwen-code-cli to qwen-code', () => {
    expect(resolveAgentSystem('qwen-code-cli')).toBe('qwen-code');
  });

  it('returns unknown for unmapped types', () => {
    expect(resolveAgentSystem('some-future-agent')).toBe('unknown');
    expect(resolveAgentSystem('')).toBe('unknown');
  });

  it('has entries for all expected agent types', () => {
    const expectedKeys = [
      'claude-code', 'codex', 'codex-session',
      'qoder', 'qoder-idea', 'qoder-work', 'qoder-work-cn', 'qoder-cli', 'qoder-cli-hook',
      'cursor', 'cursor-hook',
      'qwen-code-cli',
    ];
    for (const key of expectedKeys) {
      expect(AGENT_SYSTEM_MAP[key]).toBeDefined();
    }
  });
});
