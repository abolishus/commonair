// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Request handling for the three pull routes:
 *
 *   GET /hls/live/<slug>/…         viewers (token `?t=`, src origin|cdn), rewritten playlists
 *   GET /relay-pull/live/<slug>/…  member relays (Bearer relay token), relative URIs, no tokens
 *   GET /cdn/live/<slug>/…         CDN origin-pull (x-cdn-auth), relative URIs, no tokens
 */
import { renditionPath, sourceAacPath } from "@commonair/contracts/internal";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Logger } from "@commonair/observability";
import { authorizeViewer, checkCdnAuth, CDN_AUTH_HEADER, type RelayAuth } from "./auth.ts";
import type { ChannelDirectory, LiveChannel } from "./channels.ts";
import { clientIp, FailureLimiter, type Cidr } from "./clientip.ts";
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
import {
  filterForDataMode,
  isMultivariantText,
  rewritePlaylist,
  stripLowLatency,
  synthesizeMultivariant,
  type UriTarget,
  type VariantSource,
} from "./playlist.ts";
import type { TokenRefresher } from "./refresh.ts";
import { UpstreamError } from "./upstream.ts";

export interface HandlerDeps {
  publicKey: CryptoKey;
  store: ContentStore;
  channels: ChannelDirectory;
  relays: RelayAuth;
  segments: SegmentLog;
  refresher: TokenRefresher;
  cdn: { enabled: boolean; baseUrl?: string; authValue: string };
  /** Proxies whose X-Forwarded-For is believed (for per-IP limits). */
  trustedProxies?: Cidr[];
  /** Failed relay authentications per client IP before 429 (per minute). */
  relayAuthFailuresPerMinute?: number;
  metrics?: OriginMetrics;
  logger?: Logger;
  now?: () => number;
}

export type OriginFetch = (req: Request, peerIp?: string) => Promise<Response>;

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

/**
 * `SegmentFetch.obj` for a media request: `<rendition dir>/<file>` (`source` for the
 * channel's own path). File names carry the sequence number, so integrity can count
 * distinct segments and parts per session rather than requests.
 */
export function fetchObjectId(mr: Pick<MediaRequest, "rendition" | "file">): string {
  return `${mr.rendition ?? "source"}/${mr.file}`;
}

export function createHandler(deps: HandlerDeps): OriginFetch {
  const metrics = deps.metrics ?? noopMetrics;
  const now = deps.now ?? Date.now;
  const relayFailures = new FailureLimiter(deps.relayAuthFailuresPerMinute ?? 10, 60_000, 50_000, now);

  const fail = (status: number, error: string, mr?: MediaRequest, headers: Record<string, string> = {}) => {
    const res = Response.json(
      { error },
      { status, headers: { ...(mr?.route === "relayPull" ? {} : CORS), ...headers } },
    );
    res.headers.set("cache-control", "no-store");
    return res;
  };

  async function authenticate(req: Request, url: URL, mr: MediaRequest, peerIp?: string): Promise<Puller | Response> {
    if (mr.route === "hls") {
      const r = await authorizeViewer(deps.publicKey, url.searchParams.get("t"), mr);
      return r.ok ? { route: "hls", claims: r.claims, token: r.token } : fail(403, `forbidden: ${r.reason}`, mr);
    }
    if (mr.route === "relayPull") {
      const ip = clientIp(peerIp, req.headers.get("x-forwarded-for"), deps.trustedProxies ?? []) ?? "unknown";
      if (relayFailures.blocked(ip)) return fail(429, "too_many_failed_attempts", mr, { "retry-after": "60" });
      const relay = await deps.relays.authenticate(req.headers.get("authorization"));
      if (relay) return { route: "relayPull", relayId: relay.id };
      relayFailures.fail(ip);
      return fail(401, "unauthorized", mr);
    }
    if (!deps.cdn.enabled) return fail(404, "not_found", mr);
    return checkCdnAuth(deps.cdn.authValue, req.headers.get(CDN_AUTH_HEADER))
      ? { route: "cdn" }
      : fail(403, "forbidden", mr);
  }

  async function uriTarget(p: Puller): Promise<UriTarget> {
    if (p.route !== "hls") return { kind: "relative" };
    // CDN URIs stay tokenless: CDN pulls are tokenless too, and one URL per object is what lets the CDN cache it.
    if (p.claims.src === "cdn" && deps.cdn.baseUrl)
      return { kind: "absolute", base: deps.cdn.baseUrl.replace(/\/+$/, "") };
    return { kind: "relative", token: await deps.refresher.tokenFor(p.claims, p.token) };
  }

  async function playlistBody(mr: MediaRequest, obj: MediaObject, channel: LiveChannel, p: Puller): Promise<string> {
    let text = dec.decode(obj.body);
    if (mr.isMultivariant) {
      const dm = p.route === "hls" ? p.claims.dm : undefined;
      const renditions = await deps.channels.renditions(channel.id);
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
      // A data-mode token always gets the synthesized ladder, so a source-only channel still has
      // its derived audio-only variant; the filter then applies the viewer's budget (ADR 0018
      // decision 5).
      const dataMode = dm !== undefined && isMultivariantText(text);
      if (variants.length > 0 || dataMode) text = synthesizeMultivariant([{ rendition: "source", text }, ...variants]);
      if (dataMode) text = filterForDataMode(text, dm);
    } else if (p.route === "hls" && p.claims.dm !== undefined) {
      text = stripLowLatency(text);
    }
    return rewritePlaylist(text, { dir: mr.upstreamPath, root: mr.channelPath, target: await uriTarget(p) });
  }

  function cacheControl(mr: MediaRequest, p: Puller, d: HlsDirectives): string {
    // Tokenized responses are per viewer; relay and CDN pulls are shared.
    const scope = p.route === "hls" ? "private" : "public";
    if (mr.kind !== "playlist") return `${scope}, max-age=86400, immutable`;
    // A data-mode playlist is filtered for this viewer's budget: never stored anywhere.
    if (mr.isMultivariant) return p.route === "hls" && p.claims.dm !== undefined ? "private, no-store" : "no-cache";
    // A blocking reload's answer never changes once produced; caches may keep it briefly.
    return isBlocking(d) ? `${scope}, max-age=6` : "no-cache";
  }

  function account(p: Puller, mr: MediaRequest, bytes: number): void {
    if (p.route === "hls")
      deps.segments.record({
        sid: p.claims.sid,
        cid: p.claims.cid,
        src: p.claims.src,
        ...(p.claims.rid ? { rid: p.claims.rid } : {}),
        kind: mr.kind,
        bytes,
        at: now(),
        ...(mr.kind === "playlist" ? {} : { obj: fetchObjectId(mr) }),
      });
    metrics.egress(sourceOf(p), bytes);
  }

  function upstreamFailure(err: UpstreamError, mr: MediaRequest, blocking: boolean): Response {
    deps.logger?.warn("upstream failure", { err: err.message, failure: err.kind, kind: mr.kind });
    // Saturation and unanswerable long-polls are retryable (RFC 8216bis asks for 503 on blocking timeouts).
    if (err.kind === "queue" || (err.kind === "timeout" && blocking))
      return fail(503, err.kind === "queue" ? "overloaded" : "blocking_reload_timeout", mr, { "retry-after": "1" });
    return fail(502, "upstream_unavailable", mr);
  }

  async function serve(req: Request, peerIp?: string): Promise<Response> {
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

    const p = await authenticate(req, url, mr, peerIp);
    if (p instanceof Response) return p;

    const channel = await deps.channels.lookup(mr.slug);
    if (!channel) return fail(404, "offline", mr);
    if (p.route === "hls" && p.claims.cid !== channel.id) return fail(403, "forbidden: wrong_channel", mr);

    // The source path serves media's AAC copy while one exists (WHIP's Opus audio does not play in
    // WebKit). Clients keep requesting `live/<slug>/…`; playlists are rewritten against that path.
    const aac = mr.rendition === undefined ? await deps.channels.sourceAac(channel.id) : "off";
    // While the copy starts, players retry rather than receive audio WebKit cannot decode.
    if (aac === "pending") return fail(503, "starting", mr, { "retry-after": "1" });
    const upstreamPath = aac === "live" ? sourceAacPath(mr.slug) : mr.upstreamPath;
    const ref = { upstreamPath, file: mr.file, kind: mr.kind };
    const blocking = isBlocking(directives);
    let obj: MediaObject;
    try {
      const verdict = await deps.store.checkBlocking(ref, directives);
      if (verdict !== "ok") return fail(400, `bad_hls_directives: ${verdict}`, mr);
      obj = await deps.store.get(ref, directives);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      return upstreamFailure(err, mr, blocking);
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
    // HEAD transfers no media, so it is neither a fetch for integrity nor egress.
    if (!isHead) account(p, mr, body.byteLength);
    metrics.request(mr.route, mr.kind, sourceOf(p), 200);
    return new Response(isHead ? null : body, { status: 200, headers });
  }

  return async (req, peerIp) => {
    const res = await serve(req, peerIp);
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
