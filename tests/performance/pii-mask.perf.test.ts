import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import {
  loadEnabledRules,
  loadMaskPlan,
} from '../../src/mask/rule-loader.js';
import { maskString } from '../../src/mask/string-masker.js';

interface BenchmarkResult {
  name: string;
  bytes: number;
  iterations: number;
  averageMs: number;
  p95Ms: number;
  throughputMiBPerSecond: number;
  cpuMsPerIteration: number;
  heapDeltaBytes: number;
}

function percentile(values: readonly number[], value: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((value / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function benchmark(
  name: string,
  input: string,
  iterations: number,
  run: (value: string) => string,
): BenchmarkResult {
  for (let index = 0; index < 5; index += 1) run(input);

  const timings: number[] = [];
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    run(input);
    timings.push(performance.now() - startedAt);
  }
  const cpu = process.cpuUsage(cpuBefore);
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  const totalMs = timings.reduce((sum, timing) => sum + timing, 0);
  const bytes = Buffer.byteLength(input);

  return {
    name,
    bytes,
    iterations,
    averageMs: totalMs / iterations,
    p95Ms: percentile(timings, 95),
    throughputMiBPerSecond:
      ((bytes * iterations) / (1024 * 1024)) / (totalMs / 1000),
    cpuMsPerIteration: (cpu.user + cpu.system) / 1000 / iterations,
    heapDeltaBytes,
  };
}

describe('PII masking performance benchmark', () => {
  it('reports baseline and five-type costs for large and dense text', () => {
    const config = { mode: 'all' as const, types: [] };
    const legacyRules = loadEnabledRules(config);
    const allPlan = loadMaskPlan(config);
    const phoneOnlyPlan = loadMaskPlan({
      mode: 'custom',
      types: ['phone'],
    });
    const plain = 'ordinary collector output without sensitive values\n'.repeat(1_500);
    const numericNoise =
      'event=12345 duration_ms=678 token_count=901 model_version=v5\n'.repeat(1_200);
    const fragmentedNumeric =
      `${Array.from({ length: 64 }, () => '1').join(' ')}|`.repeat(512);
    const mixed = [
      plain.slice(0, Math.floor(plain.length / 2)),
      'id=11010519491231002X',
      'phone=13800138000',
      'email=user@example.com',
      'ip=192.168.1.10',
      'card=4111111111111111',
      plain.slice(Math.floor(plain.length / 2)),
    ].join('\n');
    const denseMatches = Array.from(
      { length: 250 },
      () =>
        '11010519491231002X 13800138000 user@example.com 192.168.1.10 4111111111111111',
    ).join('\n');

    const results = [
      benchmark('legacy-rules:plain', plain, 100, value =>
        maskString(value, legacyRules),
      ),
      benchmark('all-rules:plain', plain, 100, value =>
        maskString(value, allPlan),
      ),
      benchmark('all-rules:numeric-noise', numericNoise, 100, value =>
        maskString(value, allPlan),
      ),
      benchmark('all-rules:fragmented-numeric', fragmentedNumeric, 20, value =>
        maskString(value, allPlan),
      ),
      benchmark('phone-only:mixed', mixed, 100, value =>
        maskString(value, phoneOnlyPlan),
      ),
      benchmark('all-rules:mixed', mixed, 100, value =>
        maskString(value, allPlan),
      ),
      benchmark('all-rules:dense-matches', denseMatches, 20, value =>
        maskString(value, allPlan),
      ),
    ];

    console.info(`[pii-mask-perf] ${JSON.stringify(results)}`);

    expect(results[1].p95Ms).toBeLessThan(50);
    expect(results[2].p95Ms).toBeLessThan(50);
    expect(results[3].p95Ms).toBeLessThan(50);
    expect(results[4].p95Ms).toBeLessThan(50);
    expect(results[5].p95Ms).toBeLessThan(50);
    expect(results[6].p95Ms).toBeLessThan(100);
    expect(maskString(mixed, allPlan)).not.toContain('11010519491231002X');
    expect(maskString(mixed, allPlan)).not.toContain('13800138000');
    expect(maskString(mixed, allPlan)).not.toContain('user@example.com');
    expect(maskString(mixed, allPlan)).not.toContain('192.168.1.10');
    expect(maskString(mixed, allPlan)).not.toContain('4111111111111111');

    const maskedDenseMatches = maskString(denseMatches, allPlan);
    expect(maskedDenseMatches.match(/\[IDCARD_MASKED\]/g)).toHaveLength(250);
    expect(maskedDenseMatches.match(/\[PHONE_MASKED\]/g)).toHaveLength(250);
    expect(maskedDenseMatches.match(/\[EMAIL_MASKED\]/g)).toHaveLength(250);
    expect(maskedDenseMatches.match(/\[IPADDRESS_MASKED\]/g)).toHaveLength(250);
    expect(maskedDenseMatches.match(/\[BANKCARD_MASKED\]/g)).toHaveLength(250);
  });
});
