// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A small TTL + LRU cache of promises. Concurrent misses for one key share a single load,
 * and failed loads are evicted so the next caller retries.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: Promise<V>; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
    private readonly clock: () => number = Date.now,
  ) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const now = this.clock();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) {
      // Re-insert to keep Map order = recency order for eviction.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const value = load();
    const entry = { value, expires: now + this.ttlMs };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return value;
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  /** Remove every key matching `predicate`. */
  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of this.entries.keys()) if (predicate(key)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
