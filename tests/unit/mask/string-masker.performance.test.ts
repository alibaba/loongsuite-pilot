import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { loadEnabledRules } from '../../../src/mask/rule-loader.js';
import { maskString } from '../../../src/mask/string-masker.js';

describe('mask string masker performance smoke', () => {
  it('masks a middle-position secret across threshold and window combinations', () => {
    const rules = loadEnabledRules({ mode: 'all', types: [] });
    const secret = 'sk-1234567890abcdefghijklmnop';
    const input = `${'x'.repeat(300 * 1024)} ${secret} ${'y'.repeat(300 * 1024)}`;
    const thresholds = [64 * 1024, 128 * 1024, 256 * 1024];
    const windows = [4 * 1024, 8 * 1024, 16 * 1024];

    const startedAt = performance.now();
    for (const threshold of thresholds) {
      for (const window of windows) {
        const masked = maskString(input, rules, {
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
});
