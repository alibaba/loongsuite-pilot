import { describe, expect, it } from 'vitest';
import { isRuleEnabled, parseInterceptorSwitches } from '../../../src/interceptor/config.js';

describe('interceptor config', () => {
  it('keeps only boolean switches', () => {
    expect(parseInterceptorSwitches({
      keep: true,
      drop: false,
      skip: 'yes',
      nested: { a: true },
    })).toEqual({ keep: true, drop: false });
  });

  it('treats missing and non-true values as bypass', () => {
    expect(isRuleEnabled({}, 'demo')).toBe(false);
    expect(isRuleEnabled({ demo: false }, 'demo')).toBe(false);
    expect(isRuleEnabled({ other: true }, 'demo')).toBe(false);
    expect(isRuleEnabled({ demo: true }, 'demo')).toBe(true);
  });
});
