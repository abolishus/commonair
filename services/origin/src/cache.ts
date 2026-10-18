// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Size-bounded LRU with per-entry TTL, and a request coalescer. Together they keep
 * origin → MediaMTX traffic at about one request per object no matter how many
 * viewers ask for it at once.
 */

export interface Sized {
  /** Bytes charged against the cache budget. */
  size: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class ByteLru<V extends Sized> {
  // Map iteration order is insertion order; re-inserting on hit makes it an LRU.
  private readonly map = new Map<string, Entry<V>>();
  private used = 0;

  constructor(
    readonly maxBytes: number,
    /** Larger objects are never cached, so one huge object cannot flush everything else. */
    readonly maxEntryBytes = Math.max(1, Math.floor(maxBytes / 8)),
    private readonly now: () => number = Date.now,
  ) {}

  get bytes(): number {
    return this.used;
  }
  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.remove(key, e);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Returns false when the value was too large to cache. */
  set(key: string, value: V, ttlMs: number): boolean {
    const old = this.map.get(key);
    if (old) this.remove(key, old);
    if (value.size > this.maxEntryBytes || ttlMs <= 0) return false;
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    this.used += value.size;
    for (const [k, e] of this.map) {
      if (this.used <= this.maxBytes) break;
      this.remove(k, e);
    }
    return true;
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (e) this.remove(key, e);
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  private remove(key: string, e: Entry<V>): void {
    this.map.delete(key);
    this.used -= e.value.size;
  }
}

/** Concurrent callers for the same key share one in-flight promise. */
export class Coalescer<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  get pending(): number {
    return this.inflight.size;
  }

  run(key: string, fn: () => Promise<T>): { promise: Promise<T>; joined: boolean } {
    const existing = this.inflight.get(key);
    if (existing) return { promise: existing, joined: true };
    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return { promise, joined: false };
  }
}

/** Small TTL map for lookups (channels, relay tokens, renditions); bounded by entry count. */
export class TtlCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  constructor(
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

/** Counting semaphore bounding concurrent upstream sockets. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      // Hand the slot straight to the next waiter; otherwise release it.
      if (next) next();
      else this.active--;
    }
  }
}
