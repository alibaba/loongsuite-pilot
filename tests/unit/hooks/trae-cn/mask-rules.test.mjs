import { describe, expect, test } from 'vitest';
import { maskString } from '../../../../src/mask/string-masker.ts';
import { loadSensitiveRules } from '../../../../src/mask/rule-loader.ts';

const rules = loadSensitiveRules();

function findRule(id) {
  return rules.find((r) => r.id === id);
}

describe('trae-cn mask rules', () => {
  test('trae-cn-credentials + trae-cn-command-output rules are loaded', () => {
    expect(findRule('apiKey.traeCnCredentials')).toBeTruthy();
    expect(findRule('apiKey.traeCnCommandOutput')).toBeTruthy();
  });

  test('masks iCubeAuthInfo:// credential', () => {
    expect(findRule('apiKey.traeCnCredentials')).toBeTruthy();
    const text = 'auth header: iCubeAuthInfo://abcdef1234.jwt.token';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_CREDENTIAL_MASKED]');
    expect(masked).not.toContain('abcdef1234.jwt.token');
  });

  test('masks trae-jwt-token=...', () => {
    const text = 'trae-jwt-token=eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_CREDENTIAL_MASKED]');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  test('masks sessionKey:...', () => {
    const text = 'sessionKey: "abc-123-456-7890"';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_CREDENTIAL_MASKED]');
    expect(masked).not.toContain('abc-123-456-7890');
  });

  test('masks access_token:...', () => {
    const text = 'access_token: "eyJ0ZXN0.dG9rZW4.ifNpZw"';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_CREDENTIAL_MASKED]');
    expect(masked).not.toContain('eyJ0ZXN0');
  });

  test('masks Bearer token in command output', () => {
    const text = 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://example.com';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_COMMAND_OUTPUT_MASKED]');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  });

  test('masks /home/<user>/... paths in command output', () => {
    const text = 'wrote file to /home/alice/secrets/token.json';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_COMMAND_OUTPUT_MASKED]');
    expect(masked).not.toContain('/home/alice/secrets/token.json');
  });

  test('masks /Users/<user>/... paths on macOS', () => {
    const text = 'output saved at /Users/bob/.config/token';
    const masked = maskString(text, rules);
    expect(masked).toContain('[TRAE_CN_COMMAND_OUTPUT_MASKED]');
    expect(masked).not.toContain('/Users/bob/.config/token');
  });

  test('does NOT mask unrelated text', () => {
    const text = 'build succeeded in 12s; tests: 24 passed';
    const masked = maskString(text, rules);
    expect(masked).toBe(text);
  });

  test('does NOT mask unrelated /home/ path that lacks prefilter keywords', () => {
    // No prefilter keyword like "bearer" or "/home/" inside the prefilter list
    // wouldn't actually be matched — but verify a generic log line is unchanged
    const text = 'operation completed normally at 2026-08-18T01:00:00Z';
    const masked = maskString(text, rules);
    expect(masked).toBe(text);
  });
});
