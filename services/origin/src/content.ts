// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The content layer between request handlers and MediaMTX: LRU cache keyed by
 * upstream path (+ LL-HLS directives), coalescing of concurrent misses, and
 * negative caching. N viewers long-polling the same `_HLS_msn` cause one upstream
 * request; every segment and part is pulled from MediaMTX about once.
 */
import { ByteLru, Coalescer, type Sized } from "./cache.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import { directivesQuery, isBlocking, type HlsDirectives, type MediaKind } from "./paths.ts";
import type { MediaUpstream } from "./upstream.ts";

export interface MediaObject extends Sized {
  status: number;
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface ObjectRef {
  upstreamPath: string;
  file: string;
  kind: MediaKind;
}

/** Cache lifetimes. Playlists change every LL-HLS part (~200 ms); media objects never change. */
export interface TtlPolicy {
  mediaMs: number;
  playlistMs: number;
  blockingPlaylistMs: number;
  multivariantMs: number;
  /** 404s and other client errors (offline channel, expired segment). */
  negativeMs: number;
}

export const DEFAULT_TTLS: TtlPolicy = {
  mediaMs: 120_000,
  playlistMs: 200,
  blockingPlaylistMs: 1_000,
  multivariantMs: 5_000,
  negativeMs: 2_000,
};

export interface ContentStoreOptions {
  upstream: MediaUpstream;
  cacheBytes: number;
  ttls?: Partial<TtlPolicy>;
  metrics?: OriginMetrics;
  /** Called once per object actually fetched from MediaMTX with status 200 (production tracking). */
  onFetched?: (ref: ObjectRef, obj: MediaObject) => void;
  now?: () => number;
}

export class ContentStore {
  readonly cache: ByteLru<MediaObject>;
  private readonly coalescer = new Coalescer<MediaObject>();
  private readonly ttls: TtlPolicy;
  private readonly metrics: OriginMetrics;

  constructor(private readonly opts: ContentStoreOptions) {
    this.cache = new ByteLru<MediaObject>(opts.cacheBytes, undefined, opts.now);
    this.ttls = { ...DEFAULT_TTLS, ...opts.ttls };
    this.metrics = opts.metrics ?? noopMetrics;
  }

  get inflight(): number {
    return this.coalescer.pending;
  }

  async get(ref: ObjectRef, directives: HlsDirectives = {}): Promise<MediaObject> {
    const query = directivesQuery(directives);
    const key = `${ref.upstreamPath}/${ref.file}${query ? `?${query}` : ""}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.metrics.cache("hit", ref.kind);
      return hit;
    }
    const { promise, joined } = this.coalescer.run(key, () => this.fetch(key, ref, query, directives));
    this.metrics.cache(joined ? "coalesced" : "miss", ref.kind);
    return promise;
  }

  private async fetch(key: string, ref: ObjectRef, query: string, directives: HlsDirectives): Promise<MediaObject> {
    const started = performance.now();
    const blocking = isBlocking(directives);
    const res = await this.opts.upstream.get(ref.upstreamPath, ref.file, query, blocking);
    this.metrics.upstream(ref.kind, res.status, performance.now() - started);
    const obj: MediaObject = { ...res, size: res.body.byteLength + key.length };
    this.cache.set(key, obj, this.ttlFor(ref, obj.status, blocking));
    if (obj.status === 200) this.opts.onFetched?.(ref, obj);
    return obj;
  }

  private ttlFor(ref: ObjectRef, status: number, blocking: boolean): number {
    if (status >= 500) return 0;
    if (status !== 200) return blocking ? 0 : this.ttls.negativeMs;
    if (ref.kind !== "playlist") return this.ttls.mediaMs;
    if (ref.file === "index.m3u8") return this.ttls.multivariantMs;
    return blocking ? this.ttls.blockingPlaylistMs : this.ttls.playlistMs;
  }
}
