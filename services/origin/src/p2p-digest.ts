// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET|HEAD /p2p-digest/live/<slug>[/<rendition>]/<file>?t=<token>`: the SHA-256 of a segment exactly
 * as `/hls/` serves it, 64 lowercase hex characters (ADR 0005 amendment 1, decision 7). Players
 * check every peer-delivered segment against it. Only the origin, the trust anchor, serves it.
 *
 * The bytes come from the shared `ContentStore` (same cache and coalescing as `/hls/`, so at most
 * one upstream fetch per object) and digests are memoized. A digest is not a segment fetch: it
 * writes no `SegmentFetch`, so integrity's counts do not move.
 */
import { sourceAacPath } from "@commonair/contracts/internal";
import type { Logger } from "@commonair/observability";
import { verifyPlaybackToken } from "@commonair/tokens";
import type { ChannelDirectory } from "./channels.ts";
import { DEFAULT_TTLS, type ContentStore, type MediaObject, type ObjectRef } from "./content.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import { parseMediaPath, ROUTES, type MediaRequest } from "./paths.ts";
import { UpstreamError } from "./upstream.ts";

export const P2P_DIGEST_ROUTE = "/p2p-digest/";

/** The `route` label of `origin.requests` and `origin.egress.bytes` for this endpoint. */
export const P2P_DIGEST_METRIC_ROUTE = "p2p_digest";

export interface P2PDigestDeps {
  /** Verifies the viewer's playback token (`?t=`). */
  publicKey: CryptoKey;
  store: ContentStore;
  /**
   * The HLS handler's channel directory. With it, a digest resolves the source path the way `/hls/`
   * does (media's AAC copy while one is live, `503 starting` while it starts) and checks that the
   * channel is live and is the token's. Without it, the source is hashed from its own path, which
   * differs from what `/hls/` serves while an AAC copy is live (the player then fails closed).
   */
  channels?: Pick<ChannelDirectory, "lookup" | "sourceAac">;
  metrics?: OriginMetrics;
  logger?: Logger;
  now?: () => number;
  /** Digests remembered (default 4096 objects, each kept at most the store's media TTL). */
  memoEntries?: number;
}

export type P2PDigestFetch = (req: Request, rawPath: string) => Promise<Response>;

/** The HLS handler's CORS headers (`src/handler.ts`), copied so the two stay independent. */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-length, content-type",
  "access-control-max-age": "86400",
};

type Lookup =
  | { ok: true; digest: string }
  | { ok: false; status: number; error: string; headers?: Record<string, string> };

/** Map-ordered LRU with a per-entry lifetime. */
class DigestMemo {
  private readonly map = new Map<string, { value: Promise<Lookup>; until: number }>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): Promise<Lookup> | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    if (e.until <= this.now()) return undefined;
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: Promise<Lookup>): void {
    this.map.delete(key);
    this.map.set(key, { value, until: this.now() + this.ttlMs });
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  /** Drop `key` only while it still holds `value` (a failed lookup must not evict a newer one). */
  drop(key: string, value: Promise<Lookup>): void {
    if (this.map.get(key)?.value === value) this.map.delete(key);
  }
}

const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");

export function createP2PDigestHandler(deps: P2PDigestDeps): P2PDigestFetch {
  const metrics = deps.metrics ?? noopMetrics;
  const now = deps.now ?? Date.now;
  const memo = new DigestMemo(deps.memoEntries ?? 4096, DEFAULT_TTLS.mediaMs, now);

  const fail = (status: number, error: string, headers: Record<string, string> = {}) => {
    const res = Response.json({ error }, { status, headers: { ...CORS, ...headers } });
    res.headers.set("cache-control", "no-store");
    return res;
  };

  async function compute(ref: ObjectRef): Promise<Lookup> {
    let obj: MediaObject;
    try {
      obj = await deps.store.get(ref);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      deps.logger?.warn("upstream failure", { err: err.message, failure: err.kind, kind: ref.kind });
      return err.kind === "queue"
        ? { ok: false, status: 503, error: "overloaded", headers: { "retry-after": "1" } }
        : { ok: false, status: 502, error: "upstream_unavailable" };
    }
    if (obj.status === 404 || obj.status === 400) return { ok: false, status: 404, error: "not_found" };
    if (obj.status !== 200) {
      deps.logger?.warn("unexpected upstream status", { status: obj.status, kind: ref.kind });
      return { ok: false, status: 502, error: "upstream_error" };
    }
    return { ok: true, digest: hex(await crypto.subtle.digest("SHA-256", obj.body)) };
  }

  /** One hash per object: concurrent and later requests share the first lookup until it fails. */
  function digestOf(ref: ObjectRef): Promise<Lookup> {
    const key = `${ref.upstreamPath}/${ref.file}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const p = compute(ref);
    memo.set(key, p);
    p.then(
      (r) => {
        if (!r.ok) memo.drop(key, p);
      },
      () => memo.drop(key, p),
    );
    return p;
  }

  /** The upstream object `/hls/` would serve for `mr`, or a refusal. */
  async function resolve(mr: MediaRequest, cid: string): Promise<ObjectRef | Response> {
    if (!deps.channels) return { upstreamPath: mr.upstreamPath, file: mr.file, kind: "segment" };
    const channel = await deps.channels.lookup(mr.slug);
    if (!channel) return fail(404, "offline");
    if (channel.id !== cid) return fail(403, "forbidden: wrong_channel");
    const aac = mr.rendition === undefined ? await deps.channels.sourceAac(channel.id) : "off";
    if (aac === "pending") return fail(503, "starting", { "retry-after": "1" });
    return { upstreamPath: aac === "live" ? sourceAacPath(mr.slug) : mr.upstreamPath, file: mr.file, kind: "segment" };
  }

  async function serve(req: Request, rawPath: string): Promise<{ res: Response; mr?: MediaRequest; src?: string }> {
    const mr = rawPath.startsWith(P2P_DIGEST_ROUTE)
      ? parseMediaPath(ROUTES.hls + rawPath.slice(P2P_DIGEST_ROUTE.length))
      : null;
    if (req.method === "OPTIONS") return { res: new Response(null, { status: 204, headers: CORS }) };
    // Only segments have digests: playlists change and parts are never shared between peers.
    if (!mr || mr.kind !== "segment") return { res: fail(404, "not_found"), mr: mr ?? undefined };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const res = fail(405, "method_not_allowed");
      res.headers.set("allow", "GET, HEAD, OPTIONS");
      return { res, mr };
    }

    // Signature, expiry and channel path, with any `src`: relay- and CDN-served viewers validate
    // against the origin too.
    const token = new URL(req.url).searchParams.get("t");
    if (!token) return { res: fail(403, "forbidden: missing"), mr };
    if (token.length > 4096) return { res: fail(403, "forbidden: malformed"), mr };
    const v = await verifyPlaybackToken(deps.publicKey, token, Math.floor(now() / 1000));
    if (!v.ok) return { res: fail(403, `forbidden: ${v.error}`), mr };
    if (v.value.path !== mr.channelPath) return { res: fail(403, "forbidden: wrong_path"), mr };
    const src = v.value.src;

    const ref = await resolve(mr, v.value.cid);
    if (ref instanceof Response) return { res: ref, mr, src };
    const r = await digestOf(ref);
    if (!r.ok) return { res: fail(r.status, r.error, r.headers), mr, src };

    const isHead = req.method === "HEAD";
    if (!isHead) metrics.egress(P2P_DIGEST_METRIC_ROUTE, r.digest.length);
    const res = new Response(isHead ? null : r.digest, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(r.digest.length),
        "cache-control": "private, max-age=120",
        "cross-origin-resource-policy": "cross-origin",
        ...CORS,
      },
    });
    return { res, mr, src };
  }

  return async (req, rawPath) => {
    const { res, mr, src } = await serve(req, rawPath);
    if (res.status !== 204)
      metrics.request(P2P_DIGEST_METRIC_ROUTE, mr?.kind ?? "other", src ?? "unauthenticated", res.status);
    return res;
  };
}
