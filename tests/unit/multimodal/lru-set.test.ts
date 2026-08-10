import { describe, expect, it } from 'vitest';
import { LruMap } from '../../../src/multimodal/uploader/lru-set.js';

describe('LruMap', () => {
  it('evicts the least recently used entry', () => {
    const lru = new LruMap<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // refresh a
    lru.set('c', 3); // drops b
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });

  it('works as a membership set with true values', () => {
    const lru = new LruMap<true>(2);
    lru.set('a', true);
    lru.set('b', true);
    expect(lru.has('a')).toBe(true); // refresh a
    lru.set('c', true); // drops b
    expect(lru.has('b')).toBe(false);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('c')).toBe(true);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new LruMap<true>(0)).toThrow(/capacity must be >= 1/);
    expect(() => new LruMap<true>(-1)).toThrow(/capacity must be >= 1/);
  });

  it('overwrites the same key without growing size', () => {
    const lru = new LruMap<number>(2);
    lru.set('a', 1);
    lru.set('a', 2);
    expect(lru.size).toBe(1);
    expect(lru.get('a')).toBe(2);
  });

  it('clear removes all entries', () => {
    const lru = new LruMap<true>(2);
    lru.set('a', true);
    lru.set('b', true);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.has('a')).toBe(false);
  });
});
