import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../../../src/interceptor/rules/engine.js';
import { builtinRules } from '../../../src/interceptor/rules/registry.js';
import type { HookRequest, LocalRule } from '../../../src/interceptor/types.js';

function request(overrides: Partial<HookRequest> = {}): HookRequest {
  return {
    agent: 'qoder',
    event: 'UserPromptSubmit',
    prompt: 'hello',
    raw: {},
    ...overrides,
  };
}

function rule(
  id: string,
  opts: {
    supports?: boolean;
    matched?: boolean;
    reason?: string;
    throws?: boolean;
  } = {},
): LocalRule {
  return {
    id,
    supports: () => opts.supports ?? true,
    evaluate: async () => {
      if (opts.throws) throw new Error('rule failed');
      return opts.matched ? { matched: true, reason: opts.reason ?? `${id} blocked` } : { matched: false };
    },
  };
}

describe('RuleEngine', () => {
  it('allows builtin rules when their switches are off', async () => {
    const engine = new RuleEngine(builtinRules(), { anything: true });
    await expect(engine.evaluate(request({ prompt: 'testing' }))).resolves.toEqual({
      action: 'allow',
      evaluatedRules: [],
    });
    await expect(engine.evaluate(request({ prompt: 'LTAI1234567890ABCD' }))).resolves.toEqual({
      action: 'allow',
      evaluatedRules: [],
    });
  });

  it('bypasses rules unless the switch is exactly true', async () => {
    const engine = new RuleEngine(
      [rule('alpha', { matched: true }), rule('beta', { matched: true })],
      { alpha: false, gamma: true },
    );
    await expect(engine.evaluate(request())).resolves.toEqual({
      action: 'allow',
      evaluatedRules: [],
    });
  });

  it('executes enabled rules in registration order and short-circuits on the first block', async () => {
    const seen: string[] = [];
    const engine = new RuleEngine(
      [
        {
          id: 'first',
          supports: () => true,
          evaluate: async () => {
            seen.push('first');
            return { matched: false };
          },
        },
        {
          id: 'blocker',
          supports: () => true,
          evaluate: async () => {
            seen.push('blocker');
            return { matched: true, reason: 'stop here' };
          },
        },
        {
          id: 'later',
          supports: () => true,
          evaluate: async () => {
            seen.push('later');
            return { matched: true, reason: 'should not run' };
          },
        },
      ],
      { first: true, blocker: true, later: true },
    );

    await expect(engine.evaluate(request())).resolves.toEqual({
      action: 'block',
      reason: 'stop here',
      ruleId: 'blocker',
      evaluatedRules: ['first', 'blocker'],
    });
    expect(seen).toEqual(['first', 'blocker']);
  });

  it('fail-opens when a rule throws', async () => {
    const engine = new RuleEngine(
      [rule('boom', { throws: true }), rule('later', { matched: true })],
      { boom: true, later: true },
    );
    await expect(engine.evaluate(request())).resolves.toEqual({
      action: 'allow',
      evaluatedRules: ['boom'],
    });
  });

  it('skips rules that do not support the request', async () => {
    const engine = new RuleEngine(
      [rule('prompt-only', { supports: false, matched: true }), rule('tool', { matched: true, reason: 'tool blocked' })],
      { 'prompt-only': true, tool: true },
    );
    await expect(engine.evaluate(request({ event: 'PreToolUse', toolName: 'Bash' }))).resolves.toEqual({
      action: 'block',
      reason: 'tool blocked',
      ruleId: 'tool',
      evaluatedRules: ['tool'],
    });
  });
});
