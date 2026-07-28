import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { loadMaskPlan } from '../../../src/mask/rule-loader.js';
import { maskString } from '../../../src/mask/string-masker.js';

describe('mask string masker performance smoke', () => {
  it('masks a middle-position secret across threshold and window combinations', () => {
    const plan = loadMaskPlan({ mode: 'all', types: [] });
    const secret = 'sk-1234567890abcdefghijklmnop';
    const input = `${'x'.repeat(300 * 1024)} ${secret} ${'y'.repeat(300 * 1024)}`;
    const thresholds = [64 * 1024, 128 * 1024, 256 * 1024];
    const windows = [4 * 1024, 8 * 1024, 16 * 1024];

    const startedAt = performance.now();
    for (const threshold of thresholds) {
      for (const window of windows) {
        const masked = maskString(input, plan, {
          largeStringThresholdBytes: threshold,
          keywordContextWindow: window,
        });

        expect(masked).toContain('[APIKEY_MASKED]');
        expect(masked).not.toContain(secret);
      }
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
  });

  it('keeps five-type PII scanning bounded for large plain and mixed text', () => {
    const plan = loadMaskPlan({ mode: 'all', types: [] });
    const plain = 'ordinary collector output without sensitive values\n'.repeat(3_000);
    const mixed = [
      plain,
      'id=11010519491231002X',
      'phone=13800138000',
      'email=user@example.com',
      'ip=192.168.1.10',
      'card=4111111111111111',
      plain,
    ].join('\n');

    const startedAt = performance.now();
    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(maskString(plain, plan)).toBe(plain);
      const masked = maskString(mixed, plan);
      expect(masked).toContain('[IDCARD_MASKED]');
      expect(masked).toContain('[PHONE_MASKED]');
      expect(masked).toContain('[EMAIL_MASKED]');
      expect(masked).toContain('[IPADDRESS_MASKED]');
      expect(masked).toContain('[BANKCARD_MASKED]');
    }
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
  });
});
