import { describe, it, expect } from 'vitest';
import { BoundedLruMap } from '../../../src/utils/bounded-lru-map.js';

describe('BoundedLruMap', () => {
  it('returns stored values', () => {
    const map = new BoundedLruMap<{ n: number }>(10);
    map.set('a', { n: 1 });

    expect(map.get('a')).toEqual({ n: 1 });
    expect(map.get('missing')).toBeUndefined();
  });

  it('keeps entries indefinitely while there is capacity', () => {
    const map = new BoundedLruMap<number>(3);
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);

    expect(map.size).toBe(3);
    expect(map.get('a')).toBe(1);
    expect(map.get('b')).toBe(2);
    expect(map.get('c')).toBe(3);
  });

  it('returns the stored object so in-place mutation is retained', () => {
    const map = new BoundedLruMap<{ n: number }>(10);
    map.set('a', { n: 1 });

    const held = map.get('a')!;
    held.n += 1;

    expect(map.get('a')).toEqual({ n: 2 });
  });

  it('never exceeds capacity and reports how many entries were evicted', () => {
    const map = new BoundedLruMap<number>(3);

    let evicted = 0;
    for (let i = 0; i < 100; i++) {
      evicted += map.set(`key-${i}`, i);
      expect(map.size).toBeLessThanOrEqual(3);
    }

    expect(map.size).toBe(3);
    expect(evicted).toBe(97);
  });

  it('evicts the least-recently-used entry', () => {
    const map = new BoundedLruMap<number>(2);
    map.set('a', 1);
    map.set('b', 2);

    // Touch 'a' so 'b' becomes least-recently-used.
    expect(map.get('a')).toBe(1);
    expect(map.set('c', 3)).toBe(1);

    expect(map.get('b')).toBeUndefined();
    expect(map.get('a')).toBe(1);
    expect(map.get('c')).toBe(3);
  });

  it('counts a read as use, so an entry read between bursts survives churn', () => {
    const map = new BoundedLruMap<string>(50);
    map.set('live', 'keep-me');

    // Fewer new keys per round than the capacity, so promoting 'live' on each read
    // always keeps it clear of the eviction end.
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 30; i++) {
        map.set(`churn-${round}-${i}`, 'transient');
      }
      expect(map.get('live')).toBe('keep-me');
    }

    expect(map.size).toBe(50);
    expect(map.get('live')).toBe('keep-me');
  });

  it('evicts even a recently read entry when one burst exceeds the capacity', () => {
    // The boundary of the LRU guarantee: reading promotes, but a single burst larger
    // than the whole map pushes everything older out regardless.
    const map = new BoundedLruMap<string>(50);
    map.set('live', 'keep-me');
    expect(map.get('live')).toBe('keep-me');

    for (let i = 0; i < 50; i++) {
      map.set(`burst-${i}`, 'transient');
    }

    expect(map.get('live')).toBeUndefined();
  });

  it('drops an entry that is never read again once enough new keys arrive', () => {
    const map = new BoundedLruMap<number>(2);
    map.set('forgotten', 1);
    map.set('b', 2);
    map.set('c', 3);

    expect(map.get('forgotten')).toBeUndefined();
  });

  it('treats a repeated set as an update rather than a new entry', () => {
    const map = new BoundedLruMap<number>(2);
    map.set('a', 1);
    map.set('a', 2);

    expect(map.size).toBe(1);
    expect(map.get('a')).toBe(2);
  });

  it('clamps a non-positive capacity to one entry', () => {
    const map = new BoundedLruMap<number>(0);
    map.set('a', 1);
    map.set('b', 2);

    expect(map.size).toBe(1);
    expect(map.get('b')).toBe(2);
  });
});
