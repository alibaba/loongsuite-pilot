/** String-key LRU map. Reads and writes refresh recency. */
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

  /** Returns the number of entries evicted to stay within capacity. */
  set(key: string, value: V): number {
    this.map.delete(key);
    this.map.set(key, value);
    let evicted = 0;
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      evicted += 1;
    }
    return evicted;
  }

  clear(): void {
    this.map.clear();
  }
}
