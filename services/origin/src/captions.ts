// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live captions (ADR 0011): the subtitle playlist and WebVTT segments under
 * `/<route>/live/<slug>/captions/<language>/`, built per request from the cues media keeps in
 * Valkey (`@commonair/captions` `CAPTIONS_KEYS`).
 *
 * - `/hls/` takes the viewer's playback token like the media routes (same path claim, same
 *   sources); a rehearsal invitee's token gets nothing (no captions for a rehearsal, decision (g)).
 *   `/relay-pull/` takes a relay token, so member relays can carry captions. `/cdn/` is not served
 *   (the CDN pull secret is not in the route context); CDN-delivered viewers get no SUBTITLES group.
 * - 404 when the channel is offline or has no active track in that language (a queued or ended
 *   track is not advertised either).
 * - The playlist lists complete segments only, each with `EXT-X-PROGRAM-DATE-TIME`; a segment's
 *   cues carry `X-TIMESTAMP-MAP` on the source clock. Short `cache-control` on both.
 * - Captions are not media: nothing here goes to the `SegmentLog` (integrity, egress receipts).
 */
import {
  CAPTIONS_KEYS,
  completeSegments,
  decodeCue,
  decodeLiveTrack,
  liveSubtitlePlaylist,
  liveVttSegment,
  segmentBounds,
  CHUNK_SECONDS,
  type Cue,
  type LiveTrack,
} from "@commonair/captions";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { verifyPlaybackToken } from "@commonair/tokens";
import { ORIGIN_SERVED_SOURCES, RelayAuth } from "./auth.ts";
import { contentTypeFor, parseCaptionsPath, ROUTES, type CaptionsRequest, type Route } from "./paths.ts";
import { routeNotFound, type OriginRouteContext, type OriginRouteRegistry, type RouteHandler } from "./routes.ts";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-length, content-type",
  "access-control-max-age": "86400",
};

/** The playlist changes every segment (3 s); a segment's cues are final once it is listed. */
export const CACHE_PLAYLIST_SECONDS = 1;
export const CACHE_SEGMENT_SECONDS = 30;

const SEGMENT_FILE = /^(\d{1,9})\.vtt$/;

type Puller = { route: "hls"; claims: PlaybackClaims; token: string } | { route: "relayPull" };

/** One subtitle track the multivariant playlist advertises (`playlist.ts` `withSubtitles`). */
export interface SubtitleTrack {
  language: string;
}

/**
 * The live tracks of a broadcast (at most one: the spoken language), for the multivariant
 * playlist. Empty when none is active or Valkey cannot be read (captions never break playback).
 */
export function liveSubtitleTracks(
  valkey: OriginRouteContext["valkey"],
): (broadcastId: string) => Promise<SubtitleTrack[]> {
  return async (broadcastId) => {
    try {
      const track = decodeLiveTrack(await valkey.get(CAPTIONS_KEYS.live(broadcastId)));
      return track ? [{ language: track.language }] : [];
    } catch {
      return [];
    }
  };
}

export function createCaptionsHandler(ctx: OriginRouteContext, relays: Pick<RelayAuth, "authenticate">): RouteHandler {
  const fail = (status: number, error: string, cr: CaptionsRequest | null) =>
    Response.json(
      { error },
      { status, headers: { ...(cr?.route === "relayPull" ? {} : CORS), "cache-control": "no-store" } },
    );

  async function authenticate(req: Request, cr: CaptionsRequest): Promise<Puller | Response> {
    if (cr.route === "hls") {
      const token = new URL(req.url).searchParams.get("t");
      if (!token || token.length > 4096) return fail(403, "forbidden: missing", cr);
      const v = await verifyPlaybackToken(ctx.publicKey, token);
      if (!v.ok) return fail(403, `forbidden: ${v.error}`, cr);
      if (v.value.path !== cr.channelPath) return fail(403, "forbidden: wrong_path", cr);
      if (!ORIGIN_SERVED_SOURCES.includes(v.value.src)) return fail(403, "forbidden: wrong_source", cr);
      return { route: "hls", claims: v.value, token };
    }
    if (cr.route === "relayPull")
      return (await relays.authenticate(req.headers.get("authorization")))
        ? { route: "relayPull" }
        : fail(401, "unauthorized", cr);
    return routeNotFound();
  }

  async function cuesFor(broadcastId: string, track: LiveTrack, n: number): Promise<Cue[]> {
    const [start, end] = segmentBounds(track, n);
    // A cue never outlasts its chunk, so one that overlaps this segment starts at most a chunk before it.
    const raw = await ctx.valkey.zrangebyscore(
      CAPTIONS_KEYS.cues(broadcastId, track.language),
      start - CHUNK_SECONDS * 1000,
      `(${end}`,
    );
    return raw.map(decodeCue).filter((c): c is Cue => c !== null);
  }

  return async (req, rawPath) => {
    const cr = parseCaptionsPath(rawPath);
    if (!cr) return routeNotFound();
    if (req.method === "OPTIONS" && cr.route !== "relayPull") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD") {
      const res = fail(405, "method_not_allowed", cr);
      res.headers.set("allow", "GET, HEAD, OPTIONS");
      return res;
    }
    const p = await authenticate(req, cr);
    if (p instanceof Response) return p;
    // A rehearsal has no captions (decision (g)); its invitee tokens see nothing here.
    if (p.route === "hls" && p.claims.rb !== undefined) return fail(404, "not_found", cr);
    const channel = await ctx.channels.lookup(cr.slug);
    if (!channel) return fail(404, "offline", cr);
    if (p.route === "hls" && p.claims.cid !== channel.id) return fail(403, "forbidden: wrong_channel", cr);

    let track: LiveTrack | null;
    try {
      track = decodeLiveTrack(await ctx.valkey.get(CAPTIONS_KEYS.live(channel.broadcastId)));
    } catch {
      return fail(503, "unavailable", cr);
    }
    if (!track || track.language !== cr.language) return fail(404, "not_found", cr);

    const scope = p.route === "hls" ? "private" : "public";
    let body: string;
    let maxAge: number;
    if (cr.kind === "subtitles") {
      const query =
        p.route === "hls" ? `?t=${encodeURIComponent(await ctx.refresher.tokenFor(p.claims, p.token))}` : "";
      body = liveSubtitlePlaylist(track, (n) => `${n}.vtt${query}`);
      maxAge = CACHE_PLAYLIST_SECONDS;
    } else {
      const m = SEGMENT_FILE.exec(cr.file);
      const range = completeSegments(track, Number.MAX_SAFE_INTEGER);
      const n = m ? Number(m[1]) : -1;
      if (!range || n < range[0] || n > range[1]) return fail(404, "not_found", cr);
      try {
        body = liveVttSegment(track, n, await cuesFor(channel.broadcastId, track, n));
      } catch {
        return fail(503, "unavailable", cr);
      }
      maxAge = CACHE_SEGMENT_SECONDS;
    }
    const bytes = new TextEncoder().encode(body);
    const headers: Record<string, string> = {
      "content-type": cr.kind === "subtitles" ? contentTypeFor(cr.file) : "text/vtt; charset=utf-8",
      "content-length": String(bytes.byteLength),
      "cache-control": `${scope}, max-age=${maxAge}`,
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
      ...(p.route === "relayPull" ? {} : CORS),
    };
    ctx.metrics.request(cr.route, cr.kind, p.route === "hls" ? p.claims.src : "relay", 200);
    return new Response(req.method === "HEAD" ? null : bytes, { status: 200, headers });
  };
}

export function registerCaptionsRoutes(registry: OriginRouteRegistry, ctx: OriginRouteContext): void {
  const handle = createCaptionsHandler(ctx, new RelayAuth({ db: ctx.db }));
  for (const route of Object.keys(ROUTES) as Route[])
    registry.register({
      name: `captions:${route}`,
      prefix: ROUTES[route],
      match: (rawPath) => parseCaptionsPath(rawPath) !== null,
      handle,
    });
}
