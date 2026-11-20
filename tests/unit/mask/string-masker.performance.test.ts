import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { loadMaskPlan } from '../../../src/mask/rule-loader.js';
import { maskString } from '../../../src/mask/string-masker.js';

function measureExecutionMs(work: () => void): number {
  // Other Vitest workers and runner preemption must not consume this synchronous
  // scanner's budget. Keep the same thresholds, measuring only this thread's CPU.
  const threadCpuUsage = (process as NodeJS.Process & {
    threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  }).threadCpuUsage;
  if (threadCpuUsage) {
    const before = threadCpuUsage.call(process);
    work();
    const delta = threadCpuUsage.call(process, before);
    return (delta.user + delta.system) / 1000;
  }
  // Compatibility with older supported Node releases without threadCpuUsage.
  const before = performance.now();
  work();
  return performance.now() - before;
}

describe('mask string masker performance smoke', () => {
  it('masks a middle-position secret across threshold and window combinations', () => {
    const plan = loadMaskPlan({ mode: 'all', types: [] });
    const secret = 'sk-1234567890abcdefghijklmnop';
    const input = `${'x'.repeat(300 * 1024)} ${secret} ${'y'.repeat(300 * 1024)}`;
    const thresholds = [64 * 1024, 128 * 1024, 256 * 1024];
    const windows = [4 * 1024, 8 * 1024, 16 * 1024];

    const elapsedMs = measureExecutionMs(() => {
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
    });

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

    const elapsedMs = measureExecutionMs(() => {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        expect(maskString(plain, plan)).toBe(plain);
        const masked = maskString(mixed, plan);
        expect(masked).toContain('[IDCARD_MASKED]');
        expect(masked).toContain('[PHONE_MASKED]');
        expect(masked).toContain('[EMAIL_MASKED]');
        expect(masked).toContain('[IP_ADDRESS_MASKED]');
        expect(masked).toContain('[CREDIT_CARD_MASKED]');
      }
    });

    expect(elapsedMs).toBeLessThan(2000);
  });

  it('keeps fragmented numeric input bounded without dropping valid phones', () => {
    const plan = loadMaskPlan({ mode: 'all', types: [] });
    const fragmented = `${Array.from({ length: 64 }, () => '1').join(' ')}|`.repeat(512);
    const validPhone = '13800138000';
    const input = `${fragmented}${validPhone}`;

    let masked = '';
    const elapsedMs = measureExecutionMs(() => { masked = maskString(input, plan); });

    expect(masked.slice(0, fragmented.length)).toBe(fragmented);
    expect(masked.slice(fragmented.length)).toBe('[PHONE_MASKED]{138****8000}');
    // Keep the regression budget without charging unrelated runner scheduling.
    expect(elapsedMs).toBeLessThan(100);
  });
});
