import { describe, expect, it } from 'vitest';
import { mergeInterceptorVerdicts } from '../../../src/interceptor/daemon/lifecycle.js';

describe('layered interceptor verdict', () => {
  const failedBuiltin = { action: 'allow' as const, evaluatedRules: ['builtin'], failOpen: true as const };
  it('does not call a managed non-match complete when the builtin check failed', () => {
    const result = mergeInterceptorVerdicts(failedBuiltin, { action: 'allow', evaluatedRules: ['managed'], matches: [], matched: false });
    expect(result).toEqual({ action: 'allow', evaluatedRules: ['builtin', 'managed'], matches: [], failOpen: true });
    expect(result).not.toHaveProperty('matched');
  });
  it('retains known audit metadata independently of a builtin failure', () => {
    expect(mergeInterceptorVerdicts(failedBuiltin, { action: 'allow', evaluatedRules: ['audit'], matched: true, enforcement: 'audit', ruleId: 'audit' }))
      .toEqual({ action: 'allow', evaluatedRules: ['builtin', 'audit'], matched: true, enforcement: 'audit', ruleId: 'audit', failOpen: true });
  });
  it('uses a known enforced block despite an earlier failed rule', () => {
    expect(mergeInterceptorVerdicts(failedBuiltin, { action: 'block', evaluatedRules: ['block'], matched: true, enforcement: 'enforce', ruleId: 'block' }))
      .toEqual({ action: 'block', evaluatedRules: ['builtin', 'block'], matched: true, enforcement: 'enforce', ruleId: 'block' });
  });
});
