import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolveAgentSystem, AGENT_SYSTEM_MAP } from '../../../src/normalization/agent-system-map.js';

describe('resolveAgentSystem', () => {
  it.each([
    ['openclaw', 'openclaw'],
    ['copilot', 'copilot'],
    ['cursor-cli', 'cursor'],
    ['kiro-cli', 'kiro'],
    ['qoder-cn', 'qoder'],
  ])('maps supported type %s to %s', (agentType, system) => {
    expect(resolveAgentSystem(agentType)).toBe(system);
  });

  it('covers every bundled Agent integration and the runtime-only Wukong input', () => {
    const definitionsDir = new URL('../../../agents.d/', import.meta.url);
    // Deployment IDs can differ from the type actually emitted by an input.
    const emittedTypes: Record<string, string> = {
      'hermes-agent': 'hermes',
      'qoder-jetbrains': 'qoder-idea',
    };
    const agentTypes = readdirSync(definitionsDir)
      .filter(file => file.endsWith('.json'))
      .map(file => {
        const definition = JSON.parse(readFileSync(new URL(file, definitionsDir), 'utf8'));
        return emittedTypes[definition.id] ?? definition.id;
      });

    for (const agentType of [...agentTypes, 'wukong']) {
      expect(resolveAgentSystem(agentType), `Missing system mapping for ${agentType}`).not.toBe('unknown');
    }
  });

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

  it('distinguishes Qoder App without changing existing Qoder family systems', () => {
    expect(resolveAgentSystem('qoder-app')).toBe('qoder-app');
    expect(resolveAgentSystem('qoder-cli')).toBe('qoder');
    expect(resolveAgentSystem('qoder-cn')).toBe('qoder');
  });

  it('maps cursor variants to cursor', () => {
    expect(resolveAgentSystem('cursor')).toBe('cursor');
    expect(resolveAgentSystem('cursor-hook')).toBe('cursor');
  });

  it('maps grok-build to grok', () => {
    expect(resolveAgentSystem('grok-build')).toBe('grok');
  });

  it('maps qwen-code-cli to qwen-code', () => {
    expect(resolveAgentSystem('qwen-code-cli')).toBe('qwen-code');
    expect(resolveAgentSystem('qwen-work-cn')).toBe('qwen');
  });

  it('maps mimo-code to mimo-code', () => {
    expect(resolveAgentSystem('mimo-code')).toBe('mimo-code');
  });

  it('maps pi-coding-agent to pi', () => {
    expect(resolveAgentSystem('pi-coding-agent')).toBe('pi');
  });

  it('maps workbuddy to workbuddy', () => {
    expect(resolveAgentSystem('workbuddy')).toBe('workbuddy');
  });

  it('maps dsh to dsh', () => {
    expect(resolveAgentSystem('dsh')).toBe('dsh');
  });

  it('maps hermes to hermes', () => {
    expect(resolveAgentSystem('hermes')).toBe('hermes');
  });

  it('returns unknown for unmapped types', () => {
    expect(resolveAgentSystem('some-future-agent')).toBe('unknown');
    expect(resolveAgentSystem('')).toBe('unknown');
  });

  it('has entries for all expected agent types', () => {
    const expectedKeys = [
      'claude-code', 'codex', 'codex-session',
      'qoder', 'qoder-idea', 'qoder-work', 'qoder-work-cn', 'qoder-cli', 'qoder-cli-hook',
      'cursor', 'cursor-hook', 'grok-build',
      'qwen-code-cli', 'qwen-work-cn', 'mimo-code', 'pi-coding-agent', 'workbuddy', 'hermes', 'dsh',
    ];
    for (const key of expectedKeys) {
      expect(AGENT_SYSTEM_MAP[key]).toBeDefined();
    }
  });
});
