import { describe, it, expect } from 'vitest';
import { normalizeE2eQoderPersonalAccessToken } from '../../scripts/e2e/lib/qoder-pat.mjs';

describe('normalizeE2eQoderPersonalAccessToken', () => {
  it('trims and strips CR', () => {
    expect(normalizeE2eQoderPersonalAccessToken('  abc\r\n')).toBe('abc');
  });

  it('strips Bearer prefix', () => {
    expect(normalizeE2eQoderPersonalAccessToken('Bearer qp_test_123')).toBe('qp_test_123');
  });

  it('strips wrapping quotes when both ends match', () => {
    expect(normalizeE2eQoderPersonalAccessToken('"qp_abc"')).toBe('qp_abc');
    expect(normalizeE2eQoderPersonalAccessToken("'qp_abc'")).toBe('qp_abc');
  });
});
