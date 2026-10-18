// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Request handling for the three pull routes:
 *
 *   GET /hls/live/<slug>/…         viewers (token `?t=`, src origin|cdn), rewritten playlists
 *   GET /relay-pull/live/<slug>/…  member relays (Bearer relay token), relative URIs, no tokens
 *   GET /cdn/live/<slug>/…         CDN origin-pull (x-cdn-auth), relative URIs, no tokens
 */
import { renditionPath } from "@commonair/contracts/internal";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Logger } from "@commonair/observability";
import { authorizeViewer, checkCdnAuth, CDN_AUTH_HEADER, type RelayAuth } from "./auth.ts";
import type { ChannelDirectory, LiveChannel } from "./channels.ts";
import type { ContentStore, MediaObject } from "./content.ts";
import type { EgressSource, SegmentLog } from "./accounting.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import {
  contentTypeFor,
  isBlocking,
  parseHlsDirectives,
  parseMediaPath,
  rawPathOf,
  type HlsDirectives,
  type MediaRequest,
} from "./paths.ts";
import { rewritePlaylist, synthesizeMultivariant, type UriTarget, type VariantSource } from "./playlist.ts";
import { UpstreamError } from "./upstream.ts";

export interface HandlerDeps {
  publicKey: CryptoKey;
  store: ContentStore;
  channels: ChannelDirectory;
  relays: RelayAuth;
  segments: SegmentLog;
  cdn: { enabled: boolean; baseUrl?: string; authValue: string };
  metrics?: OriginMetrics;
  logger?: Logger;
  now?: () => number;
}

/** Who is pulling, after authentication. */
type Puller =
  | { route: "hls"; claims: PlaybackClaims; token: string }
  | { route: "relayPull"; relayId: string }
  | { route: "cdn" };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-length, content-type",
  "access-control-max-age": "86400",
};

const dec = new TextDecoder();

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const metrics = deps.metrics ?? noopMetrics;
  const now = deps.now ?? Date.now;

  const fail = (status: number, error: string, mr?: MediaRequest) => {
    const res = Response.json({ error }, { status, headers: mr?.route === "relayPull" ? {} : CORS });
    res.headers.set("cache-control", "no-store");
    return res;
  };

  async function authenticate(req: Request, url: URL, mr: MediaRequest): Promise<Puller | Response> {
    if (mr.route === "hls") {
      const r = await authorizeViewer(deps.publicKey, url.searchParams.get("t"), mr);
      return r.ok ? { route: "hls", claims: r.claims, token: r.token } : fail(403, `forbidden: ${r.reason}`, mr);
    }
    if (mr.route === "relayPull") {
      const relay = await deps.relays.authenticate(req.headers.get("authorization"));
      return relay ? { route: "relayPull", relayId: relay.id } : fail(401, "unauthorized", mr);
    }
    if (!deps.cdn.enabled) return fail(404, "not_found", mr);
    return checkCdnAuth(deps.cdn.authValue, req.headers.get(CDN_AUTH_HEADER))
      ? { route: "cdn" }
      : fail(403, "forbidden", mr);
  }

  function uriTarget(p: Puller): UriTarget {
    if (p.route !== "hls") return { kind: "relative" };
    if (p.claims.src === "cdn" && deps.cdn.baseUrl)
      return { kind: "absolute", base: deps.cdn.baseUrl.replace(/\/+$/, ""), token: p.token };
    return { kind: "relative", token: p.token };
  }

  async function playlistBody(mr: MediaRequest, obj: MediaObject, channel: LiveChannel, p: Puller): Promise<string> {
    let text = dec.decode(obj.body);
    if (mr.isMultivariant) {
      const renditions = await deps.channels.renditions(channel.id);
      if (renditions.length > 0) {
        const fetched = await Promise.all(
          renditions.map(async (r): Promise<VariantSource | null> => {
            try {
              const o = await deps.store.get({
                upstreamPath: renditionPath(mr.slug, r),
                file: "index.m3u8",
                kind: "playlist",
              });
              return o.status === 200 ? { rendition: r, text: dec.decode(o.body) } : null;
            } catch {
              // A rendition whose transcoder is not up yet is simply left out of the ladder.
              return null;
            }
          }),
        );
        const variants = fetched.filter((v): v is VariantSource => v !== null);
        if (variants.length > 0) text = synthesizeMultivariant([{ rendition: "source", text }, ...variants]);
      }
    }
    return rewritePlaylist(text, { dir: mr.upstreamPath, root: mr.channelPath, target: uriTarget(p) });
  }

  function cacheControl(mr: MediaRequest, p: Puller, d: HlsDirectives): string {
    // Tokenized responses are per viewer; relay and CDN pulls are shared.
    const scope = p.route === "hls" ? "private" : "public";
    if (mr.kind !== "playlist") return `${scope}, max-age=86400, immutable`;
    if (mr.isMultivariant) return "no-cache";
    // A blocking reload's answer never changes once produced; caches may keep it briefly.
    return isBlocking(d) ? `${scope}, max-age=6` : "no-cache";
  }

  function account(p: Puller, mr: MediaRequest, bytes: number): void {
    const at = now();
    let source: EgressSource;
    if (p.route === "hls") {
      source = p.claims.src;
      deps.segments.record({
        sid: p.claims.sid,
        cid: p.claims.cid,
        src: p.claims.src,
        ...(p.claims.rid ? { rid: p.claims.rid } : {}),
        kind: mr.kind,
        bytes,
        at,
      });
    } else source = sourceOf(p);
    metrics.egress(source, bytes);
  }

  async function serve(req: Request): Promise<Response> {
    const rawPath = rawPathOf(req.url);
    const mr = parseMediaPath(rawPath);
    if (req.method === "OPTIONS" && mr && mr.route !== "relayPull")
      return new Response(null, { status: 204, headers: CORS });
    if (!mr) return fail(404, "not_found");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const res = fail(405, "method_not_allowed", mr);
      res.headers.set("allow", "GET, HEAD, OPTIONS");
      return res;
    }
    const url = new URL(req.url);
    const directives = mr.kind === "playlist" ? parseHlsDirectives(url.searchParams) : {};
    if (!directives) return fail(400, "bad_hls_directives", mr);

    const p = await authenticate(req, url, mr);
    if (p instanceof Response) return p;

    const channel = await deps.channels.lookup(mr.slug);
    if (!channel) return fail(404, "offline", mr);
    if (p.route === "hls" && p.claims.cid !== channel.id) return fail(403, "forbidden: wrong_channel", mr);

    let obj: MediaObject;
    try {
      obj = await deps.store.get({ upstreamPath: mr.upstreamPath, file: mr.file, kind: mr.kind }, directives);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      deps.logger?.warn("upstream failure", { err: err.message, kind: mr.kind });
      return fail(502, "upstream_unavailable", mr);
    }
    if (obj.status !== 200) {
      // 400 = a directive MediaMTX refused (e.g. _HLS_msn too far ahead); 404 = gone or not yet there.
      if (obj.status === 404 || obj.status === 400) return fail(obj.status, "not_found", mr);
      deps.logger?.warn("unexpected upstream status", { status: obj.status, kind: mr.kind });
      return fail(502, "upstream_error", mr);
    }

    const body: Uint8Array<ArrayBuffer> =
      mr.kind === "playlist" ? new TextEncoder().encode(await playlistBody(mr, obj, channel, p)) : obj.body;
    const headers: Record<string, string> = {
      "content-type": contentTypeFor(mr.file),
      "content-length": String(body.byteLength),
      "cache-control": cacheControl(mr, p, directives),
      "cross-origin-resource-policy": "cross-origin",
      ...(p.route === "relayPull" ? {} : CORS),
    };
    const isHead = req.method === "HEAD";
    account(p, mr, isHead ? 0 : body.byteLength);
    metrics.request(mr.route, mr.kind, sourceOf(p), 200);
    return new Response(isHead ? null : body, { status: 200, headers });
  }

  return async (req) => {
    const res = await serve(req);
    if (res.status !== 200 && res.status !== 204) {
      const mr = parseMediaPath(rawPathOf(req.url));
      metrics.request(mr?.route ?? "other", mr?.kind ?? "other", "unauthenticated", res.status);
    }
    return res;
  };
}

function sourceOf(p: Puller): EgressSource {
  if (p.route === "hls") return p.claims.src;
  return p.route === "relayPull" ? "relay" : "cdn";
}
