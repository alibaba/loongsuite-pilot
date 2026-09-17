import { describe, expect, it } from 'vitest';
import { RuleEngine } from '../../../src/interceptor/rules/engine.js';
import { collectHookText } from '../../../src/interceptor/rules/hook-text.js';
import { builtinRules } from '../../../src/interceptor/rules/registry.js';
import {
  createSensitiveTypeRule,
  SENSITIVE_INTERCEPT_TYPES,
} from '../../../src/interceptor/rules/sensitive-type.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

function request(overrides: Partial<HookRequest> = {}): HookRequest {
  return {
    agent: 'qoder',
    event: 'UserPromptSubmit',
    raw: {},
    ...overrides,
  };
}

describe('sensitive-type interceptor rules', () => {
  it('registers the four mask types in JSON order', () => {
    expect(builtinRules().map(rule => rule.id)).toEqual([...SENSITIVE_INTERCEPT_TYPES]);
  });

  it('stays bypassed until the type switch is true', async () => {
    const engine = new RuleEngine(builtinRules(), {});
    await expect(engine.evaluate(request({ prompt: 'LTAI1234567890ABCD' }))).resolves.toEqual({
      action: 'allow',
      evaluatedRules: [],
    });
  });

  it.each([
    ['cloudAccessKey', 'please use LTAI1234567890ABCD', '[ACCESSKEY_MASKED]'],
    ['cloudAccessKey', 'aws=AKIAIOSFODNN7EXAMPLE', '[ACCESSKEY_MASKED]'],
    ['cloudAccessKey', 'sts=ASIAABCDEFGHIJKLMNOP', '[ACCESSKEY_MASKED]'],
    ['cloudAccessKey', 'tencent=AKIDabcdefghijklmnopqrstuvwxyz', '[ACCESSKEY_MASKED]'],
    ['apiKey', 'openai=sk-1234567890abcdefghijklmnop', '[APIKEY_MASKED]'],
    ['apiKey', 'github=ghp_1234567890abcdefghijklmnop', '[APIKEY_MASKED]'],
    ['privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----', '[PRIVATEKEY_MASKED]'],
    ['databaseUrl', 'mysql://agent:eMCyjl4XWcVzpXFb@127.0.0.1:3306/pilot', '[DATABASEURL_MASKED]'],
    ['databaseUrl', 'jdbc:mysql://localhost:3306/db?user=root&password=MySynthMysql12', '[DATABASEURL_MASKED]'],
  ] as const)('blocks %s text through the engine', async (type, prompt, reason) => {
    const engine = new RuleEngine(builtinRules(), { [type]: true });
    await expect(engine.evaluate(request({ prompt }))).resolves.toEqual({
      action: 'block',
      reason,
      ruleId: type,
      evaluatedRules: [type],
    });
  });

  it('blocks secrets in tool input', async () => {
    const engine = new RuleEngine(builtinRules(), { apiKey: true });
    await expect(engine.evaluate(request({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command: 'export KEY=sk-1234567890abcdefghijklmnop' },
    }))).resolves.toEqual({
      action: 'block',
      reason: '[APIKEY_MASKED]',
      ruleId: 'apiKey',
      evaluatedRules: ['apiKey'],
    });
  });

  it('allows non-matching text when the switch is on', async () => {
    const cloud = createSensitiveTypeRule('cloudAccessKey');
    await expect(cloud.evaluate(request({ prompt: 'short_aliyun=LTAI123' }))).resolves.toEqual({
      matched: false,
    });
    await expect(createSensitiveTypeRule('databaseUrl').evaluate(request({
      prompt: 'mysql://localhost:3306/pilot',
    }))).resolves.toEqual({ matched: false });
  });
});

describe('collectHookText', () => {
  it('joins prompt, tool name, and serialized tool input', () => {
    expect(collectHookText(request({
      prompt: 'hello',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    }))).toBe('hello\nBash\n{"command":"ls"}');
  });
});
