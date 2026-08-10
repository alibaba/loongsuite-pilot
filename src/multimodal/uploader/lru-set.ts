/** Default capacity for multimodal LRU caches (e.g. upload success keys). */
export const MULTIMODAL_LRU_LIMIT = 2048;

/**
 * String-key LRU map. get()/has()/set() refresh recency; overflow drops the oldest entry.
 * Use as a set with value `true` when only membership is needed.
 */
export class LruMap<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('LruMap capacity must be >= 1');
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
