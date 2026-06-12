import { describe, it, expect } from 'vitest';
import { compareVersions } from '../../../src/updater/version-utils.js';

describe('compareVersions', () => {
  describe('standard semver', () => {
    it('returns 1 when a > b (patch)', () => {
      expect(compareVersions('1.0.2', '1.0.1')).toBe(1);
    });

    it('returns -1 when a < b (patch)', () => {
      expect(compareVersions('1.0.1', '1.0.2')).toBe(-1);
    });

    it('returns 0 when equal', () => {
      expect(compareVersions('1.0.2', '1.0.2')).toBe(0);
    });

    it('returns 1 when a > b (minor)', () => {
      expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    });

    it('returns -1 when a < b (minor)', () => {
      expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
    });

    it('returns 1 when a > b (major)', () => {
      expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    });

    it('returns -1 when a < b (major)', () => {
      expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
    });
  });

  describe('unequal segment counts', () => {
    it('treats missing segments as 0: 1.0 == 1.0.0', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });

    it('1.0.1 > 1.0', () => {
      expect(compareVersions('1.0.1', '1.0')).toBe(1);
    });

    it('single segment: 2 > 1', () => {
      expect(compareVersions('2', '1')).toBe(1);
    });

    it('four segments: 1.0.0.1 > 1.0.0.0', () => {
      expect(compareVersions('1.0.0.1', '1.0.0.0')).toBe(1);
    });
  });

  describe('non-standard formats (string fallback)', () => {
    it('falls back to string comparison for non-numeric versions', () => {
      expect(compareVersions('abc', 'def')).toBe(-1);
      expect(compareVersions('def', 'abc')).toBe(1);
    });

    it('returns 0 for identical non-numeric strings', () => {
      expect(compareVersions('beta', 'beta')).toBe(0);
    });

    it('falls back when any segment is NaN: 1.0.0-beta vs 1.0.0', () => {
      const result = compareVersions('1.0.0-beta', '1.0.0');
      expect(typeof result).toBe('number');
      // '1.0.0-beta' > '1.0.0' in string comparison (longer string)
      expect(result).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('empty strings are equal', () => {
      expect(compareVersions('', '')).toBe(0);
    });

    it('zero versions: 0.0.0 == 0.0.0', () => {
      expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
    });

    it('large version numbers', () => {
      expect(compareVersions('100.200.300', '100.200.299')).toBe(1);
    });
  });
});
