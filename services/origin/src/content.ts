// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The content layer between request handlers and MediaMTX: LRU cache keyed by
 * upstream path (+ LL-HLS directives), coalescing of concurrent misses, and
 * negative caching. N viewers long-polling the same `_HLS_msn` cause one upstream
 * request; every segment and part is pulled from MediaMTX about once.
 *
 * Blocking reloads are additionally bounded: each is checked against the
 * playlist's current end (requests that cannot be answered soon are refused), it
 * waits at most 3 × target duration, and each MediaMTX path may have only a few
 * distinct blocking keys in flight at once.
 */
import { ByteLru, Coalescer, type Sized } from "./cache.ts";
import {
  blockingTimeoutMs,
  checkDirectives,
  playlistState,
  type DirectiveVerdict,
  type PlaylistState,
} from "./llhls.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import { directivesQuery, isBlocking, type HlsDirectives, type MediaKind } from "./paths.ts";
import { UpstreamError, type MediaUpstream } from "./upstream.ts";

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
  /**
   * Max distinct blocking keys in flight per MediaMTX path. Honest players need about two per
   * media playlist (this part and the next); a path has a video and an audio playlist.
   */
  maxBlockingKeysPerPath?: number;
  /** A playlist state older than this is refreshed (one cached, coalesced request) before judging directives. */
  stateMaxAgeMs?: number;
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
  private readonly now: () => number;
  private readonly states = new Map<string, { state: PlaylistState; at: number }>();
  private readonly blockingPerPath = new Map<string, number>();

  constructor(private readonly opts: ContentStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.cache = new ByteLru<MediaObject>(opts.cacheBytes, undefined, this.now);
    this.ttls = { ...DEFAULT_TTLS, ...opts.ttls };
    this.metrics = opts.metrics ?? noopMetrics;
  }

  get inflight(): number {
    return this.coalescer.pending;
  }

  /** Last known end of a media playlist (tests, diagnostics). */
  state(ref: Pick<ObjectRef, "upstreamPath" | "file">): PlaylistState | undefined {
    return this.states.get(`${ref.upstreamPath}/${ref.file}`)?.state;
  }

  /**
   * Judge LL-HLS directives against the playlist's current end. When the known state is stale,
   * refresh it with one non-blocking fetch (cached and coalesced across viewers).
   */
  async checkBlocking(ref: ObjectRef, d: HlsDirectives): Promise<DirectiveVerdict> {
    if (!isBlocking(d)) return "ok";
    const key = `${ref.upstreamPath}/${ref.file}`;
    let known = this.states.get(key);
    if (!known || this.now() - known.at > (this.opts.stateMaxAgeMs ?? 1_000)) {
      await this.get(ref);
      known = this.states.get(key);
    }
    // Unknown (playlist not available): let MediaMTX answer; its 404 is cached briefly.
    return known ? checkDirectives(d, known.state) : "ok";
  }

  async get(ref: ObjectRef, directives: HlsDirectives = {}): Promise<MediaObject> {
    const query = directivesQuery(directives);
    const key = `${ref.upstreamPath}/${ref.file}${query ? `?${query}` : ""}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.metrics.cache("hit", ref.kind);
      return hit;
    }
    const blocking = isBlocking(directives);
    if (blocking && !this.coalescer.has(key)) {
      const n = this.blockingPerPath.get(ref.upstreamPath) ?? 0;
      if (n >= (this.opts.maxBlockingKeysPerPath ?? 16))
        throw new UpstreamError("too many distinct blocking reloads for this path", "queue");
    }
    const { promise, joined } = this.coalescer.run(key, () => this.fetch(key, ref, query, blocking));
    this.metrics.cache(joined ? "coalesced" : "miss", ref.kind);
    return promise;
  }

  private async fetch(key: string, ref: ObjectRef, query: string, blocking: boolean): Promise<MediaObject> {
    const started = performance.now();
    const playlistKey = `${ref.upstreamPath}/${ref.file}`;
    if (blocking) this.blockingPerPath.set(ref.upstreamPath, (this.blockingPerPath.get(ref.upstreamPath) ?? 0) + 1);
    try {
      const res = await this.opts.upstream.get(
        ref.upstreamPath,
        ref.file,
        query,
        blocking ? { blockingTimeoutMs: blockingTimeoutMs(this.states.get(playlistKey)?.state) } : {},
      );
      this.metrics.upstream(ref.kind, res.status, performance.now() - started);
      const obj: MediaObject = { ...res, size: res.body.byteLength + key.length };
      this.cache.set(key, obj, this.ttlFor(ref, obj.status, blocking));
      if (obj.status === 200) {
        if (ref.kind === "playlist" && ref.file !== "index.m3u8") this.noteState(playlistKey, obj);
        this.opts.onFetched?.(ref, obj);
      }
      return obj;
    } finally {
      if (blocking) {
        const n = (this.blockingPerPath.get(ref.upstreamPath) ?? 1) - 1;
        if (n > 0) this.blockingPerPath.set(ref.upstreamPath, n);
        else this.blockingPerPath.delete(ref.upstreamPath);
      }
    }
  }

  private noteState(key: string, obj: MediaObject): void {
    const state = playlistState(new TextDecoder().decode(obj.body));
    if (!state) return;
    const prev = this.states.get(key);
    // Responses complete out of order, so a fresh known end never moves backwards. A stale one may:
    // a restarted muxer starts its sequence numbers over.
    const fresh = prev && this.now() - prev.at <= (this.opts.stateMaxAgeMs ?? 1_000);
    const p = prev?.state;
    if (fresh && p && (p.lastMsn > state.lastMsn || (p.lastMsn === state.lastMsn && p.lastPart > state.lastPart)))
      return;
    this.states.delete(key);
    this.states.set(key, { state, at: this.now() });
    if (this.states.size > 10_000) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
  }

  private ttlFor(ref: ObjectRef, status: number, blocking: boolean): number {
    if (status >= 500) return 0;
    if (status !== 200) return blocking ? 0 : this.ttls.negativeMs;
    if (ref.kind !== "playlist") return this.ttls.mediaMs;
    if (ref.file === "index.m3u8") return this.ttls.multivariantMs;
    return blocking ? this.ttls.blockingPlaylistMs : this.ttls.playlistMs;
  }
}
