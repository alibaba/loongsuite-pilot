/**
 * Map with a hard entry cap that evicts the least-recently-used key, for per-session
 * bookkeeping in the long-lived collector daemon.
 *
 * Deliberately has no TTL. Idle expiry would reclaim a session that the user simply
 * walked away from, and re-parenting its later turns onto a fresh anchor would split
 * one conversation into two traces. Capacity pressure is the only reason to drop an
 * entry, and then the least-recently-used one is the safest choice.
 *
 * Reads count as use, because callers mutate the stored value in place rather than
 * re-setting it.
 */
export class BoundedLruMap<V> {
  private readonly entries = new Map<string, V>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;

    const value = this.entries.get(key)!;
    // Re-insert so iteration order stays least-recently-used first.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Returns how many entries were evicted to stay within capacity. */
  set(key: string, value: V): number {
    this.entries.delete(key);
    this.entries.set(key, value);

    let evicted = 0;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
      evicted += 1;
    }
    return evicted;
  }
}
