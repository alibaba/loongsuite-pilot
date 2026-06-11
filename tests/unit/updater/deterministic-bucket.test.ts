import { describe, it, expect } from 'vitest';
import { deterministicBucket } from '../../../src/updater/version-utils.js';

describe('deterministicBucket', () => {
  it('returns a number in [0, 99]', () => {
    const result = deterministicBucket('a3f8c1d2-7b4e-4f9a-b2c1-e5d6f7a8b9c0', '1.0.36');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(100);
  });

  it('returns the same value for the same installId + version', () => {
    const id = 'test-install-id-123';
    const version = '1.0.36';
    const a = deterministicBucket(id, version);
    const b = deterministicBucket(id, version);
    expect(a).toBe(b);
  });

  it('returns different values for the same installId with different versions', () => {
    const id = 'test-install-id-123';
    const results = new Set<number>();
    for (let v = 0; v < 50; v++) {
      results.add(deterministicBucket(id, `1.0.${v}`));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('returns an integer', () => {
    const result = deterministicBucket('some-uuid-value', '2.0.0');
    expect(Number.isInteger(result)).toBe(true);
  });

  it('returns different values for different installIds', () => {
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(deterministicBucket(`install-${i}`, '1.0.36'));
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('handles empty installId without throwing', () => {
    const result = deterministicBucket('', '1.0.0');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(100);
  });

  it('produces reasonable distribution across 100 buckets', () => {
    const buckets = new Array(100).fill(0);
    const total = 10000;
    for (let i = 0; i < total; i++) {
      const bucket = deterministicBucket(`uuid-${i}-${Math.random()}`, '1.0.36');
      buckets[bucket]++;
    }
    const nonEmpty = buckets.filter(c => c > 0).length;
    expect(nonEmpty).toBeGreaterThan(80);
  });
});
