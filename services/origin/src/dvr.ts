// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live DVR, `GET|HEAD /dvr/<vodId>/<file>?t=<token>` (ADR 0016 decisions 1–7).
 *
 * - **Token.** A genuine, unexpired `PlaybackClaims` with `path = dvr/<vodId>` and `src = origin`
 *   for the VOD's channel. A token carrying `dm` is refused (data mode never rewinds, decision 7),
 *   and so is any other source: DVR is origin-only (decision 5), so a relay or CDN token, a live
 *   token or a VOD token authorizes nothing here.
 * - **State, per request** (decision 3), through the origin's 5 s `VodStateCache` and the shared
 *   `dvrServable` predicate: the VOD is `recording` and not removed, its broadcast is live, a
 *   `live` broadcast (not a rehearsal), not T1-restricted, the channel is not suspended and has DVR
 *   on. Anything else is a 404, so a removal or a T0 closes DVR within 5 s on every instance.
 * - **Playlist.** Only `recordings/<vodId>/index.m3u8` is read (the in-progress recording; never
 *   `vods/`). It is cut to `min(channel window, DVR_MAX_WINDOW_SECONDS)` by PDT back from the newest
 *   segment's end, its media and discontinuity sequences fixed, served without `ENDLIST` (it is a
 *   sliding live window), and every URI rewritten to carry the token (`rewritePlaylist`).
 * - **Segments.** Only an object the cut playlist lists (a media segment or the init segment of
 *   one) is served. The recorder writes the playlist only after a segment is uploaded, so a
 *   segment still being recorded is unlisted, and a 404.
 * - `cache-control: private, no-store` on everything. Every playlist and segment served (GET) goes
 *   to the segment log with `mode: "dvr"`, so integrity judges DVR seconds on DVR fetches (decision 6).
 *
 * **Relays** (batch 7 decision (x), ADR 0016 Amendment 1 A1.3) pull the same objects from
 * `GET|HEAD /relay-pull/dvr/<vodId>/<file>` with the live pull's relay bearer token (failures
 * limited per peer). The state checks and the window cut are the same; playlist URIs are bare
 * relative ones (the relay adds its viewers' tokens). Fetches go to the segment log as `src:
 * relay` with the relay's id. The viewer route keeps refusing relay tokens: a relay's viewers
 * rewind on the relay. Each whole segment a relay pulls is also counted in `DvrPullStore`, the
 * bound relay issuance gives the relay's DVR sessions (ADR 0016 Amendment 2).
 */
import { eq } from "drizzle-orm";
import { DVR_RULES } from "@commonair/contracts/enums";
import { DVR_ROUTE, dvrServable, dvrTokenPath, VOD_PLAYLIST, vodPrefix } from "@commonair/contracts/storage";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, type Executor } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { RelayAuth } from "./auth.ts";
import { Coalescer, TtlCache } from "./cache.ts";
import { FailureLimiter } from "./clientip.ts";
import { CORS, mediaFail, objectHeaders, readObject } from "./media.ts";
import { parseDvrPath } from "./paths.ts";
import { rewritePlaylist } from "./playlist.ts";
import type { OriginRouteContext, OriginRouteRegistry, RouteHandler } from "./routes.ts";
import { dvrStateOf, type VodState } from "./vod.ts";

/**
 * How long a recording's playlist is reused across requests. The recorder rewrites it once per
 * 4 s segment; a shorter reuse than that keeps every viewer within a segment of the newest one
 * while a busy channel costs one storage read per second instead of one per request.
 */
export const DVR_PLAYLIST_TTL_MS = 1_000;
/** A channel's window setting is cached as long as its VOD state (5 s). */
export const DVR_WINDOW_TTL_MS = 5_000;

// ---------------------------------------------------------------------------------------
// The recording's playlist (what `services/media/src/vod/playlist.ts` renders) and its window cut.

export interface RecordingSegment {
  uri: string;
  durationSeconds: number;
  /** EXT-X-PROGRAM-DATE-TIME in ms, when stamped. */
  pdtMs: number | null;
  /** The EXT-X-MAP init segment in effect. */
  map: string | null;
  /** An EXT-X-DISCONTINUITY precedes this segment. */
  discontinuity: boolean;
}

export interface RecordingPlaylist {
  /** EXT-X-MEDIA-SEQUENCE of the first segment (the recorder writes 0). */
  mediaSequence: number;
  /** EXT-X-DISCONTINUITY-SEQUENCE of the first segment. */
  discontinuitySequence: number;
  segments: RecordingSegment[];
}

/** Parse a recorder playlist. Tolerant: an unknown tag is ignored, a URI line without EXTINF is skipped. */
export function parseRecording(text: string): RecordingPlaylist {
  const out: RecordingPlaylist = { mediaSequence: 0, discontinuitySequence: 0, segments: [] };
  let map: string | null = null;
  let duration: number | null = null;
  let pdt: number | null = null;
  let discontinuity = false;
  const int = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) out.mediaSequence = int(line.slice(22));
    else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) out.discontinuitySequence = int(line.slice(30));
    else if (line === "#EXT-X-DISCONTINUITY") discontinuity = true;
    else if (line.startsWith("#EXT-X-MAP:")) map = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    else if (line.startsWith("#EXTINF:")) {
      const d = Number.parseFloat(line.slice(8));
      duration = Number.isFinite(d) && d >= 0 ? d : null;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(line.slice(25));
      pdt = Number.isNaN(t) ? null : t;
    } else if (!line.startsWith("#")) {
      if (duration !== null)
        out.segments.push({ uri: line, durationSeconds: duration, pdtMs: pdt, map, discontinuity });
      duration = null;
      pdt = null;
      discontinuity = false;
    }
  }
  return out;
}

export interface DvrWindow {
  /** The cut playlist, URIs not yet rewritten. */
  text: string;
  /** Object names it lists (media segments and their init segments). */
  objects: Set<string>;
  /** Wall-clock start of the first segment kept, ms, or null without PDT. */
  startMs: number | null;
  /** Wall-clock end of the newest segment, ms, or null without PDT. */
  endMs: number | null;
}

/**
 * Each segment's wall-clock start: its PDT, else the previous start plus the previous duration.
 * Segments before the first PDT get one backwards from it; without any PDT, all are null.
 */
function segmentStarts(segments: readonly RecordingSegment[]): (number | null)[] {
  const starts: (number | null)[] = segments.map(() => null);
  let prev: number | null = null;
  segments.forEach((s, i) => {
    const prevSeg = segments[i - 1];
    const derived = prev !== null && prevSeg ? prev + prevSeg.durationSeconds * 1000 : null;
    starts[i] = s.pdtMs ?? derived;
    prev = starts[i] ?? null;
  });
  const first = starts.findIndex((s) => s !== null);
  for (let i = first - 1; i >= 0; i--) {
    const next = starts[i + 1];
    const seg = segments[i];
    if (next !== null && next !== undefined && seg) starts[i] = next - seg.durationSeconds * 1000;
  }
  return starts;
}

const fmtDuration = (d: number) => d.toFixed(6);

/**
 * Cut a recording to the last `windowSeconds` (by PDT, back from the newest segment's end) and
 * render it as a sliding live playlist: no `ENDLIST`, no `PLAYLIST-TYPE`, media and discontinuity
 * sequences of the first segment kept, its init segment repeated. A segment counts when any of it
 * lies inside the window. Without PDT the window is counted in durations back from the newest.
 */
export function cutToWindow(rec: RecordingPlaylist, windowSeconds: number): DvrWindow {
  const segs = rec.segments;
  const windowMs = Math.max(0, windowSeconds) * 1000;
  const starts = segmentStarts(segs);
  const last = segs.length - 1;
  const lastStart = starts[last];
  const lastSeg = segs[last];
  const endMs =
    lastSeg && lastStart !== null && lastStart !== undefined ? lastStart + lastSeg.durationSeconds * 1000 : null;
  let first = segs.length;
  if (endMs !== null) {
    const edge = endMs - windowMs;
    for (let i = last; i >= 0; i--) {
      const start = starts[i] ?? null;
      const seg = segs[i];
      if (!seg || start === null || start + seg.durationSeconds * 1000 <= edge) break;
      first = i;
    }
  } else {
    let covered = 0;
    for (let i = last; i >= 0 && covered < windowMs; i--) {
      covered += (segs[i]?.durationSeconds ?? 0) * 1000;
      first = i;
    }
  }
  const kept = segs.slice(first);
  const discontinuities = segs.slice(0, first + 1).filter((s, i) => s.discontinuity && i > 0).length;
  // A discontinuity on the first kept segment is carried by the sequence number, not a tag.
  const discSeq = rec.discontinuitySequence + discontinuities;
  const target = Math.max(1, Math.ceil(Math.max(0, ...kept.map((s) => s.durationSeconds))));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    `#EXT-X-MEDIA-SEQUENCE:${rec.mediaSequence + first}`,
    ...(discSeq > 0 ? [`#EXT-X-DISCONTINUITY-SEQUENCE:${discSeq}`] : []),
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  const objects = new Set<string>();
  let map: string | null | undefined;
  kept.forEach((s, i) => {
    if (i > 0 && s.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    if (s.map !== map || (i > 0 && s.discontinuity)) {
      if (s.map) {
        lines.push(`#EXT-X-MAP:URI="${s.map}"`);
        objects.add(s.map);
      }
      map = s.map;
    }
    const start = starts[first + i];
    if (start !== null && start !== undefined) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(start).toISOString()}`);
    lines.push(`#EXTINF:${fmtDuration(s.durationSeconds)},`, s.uri);
    objects.add(s.uri);
  });
  const startMs = kept.length > 0 ? (starts[first] ?? null) : null;
  return { text: `${lines.join("\n")}\n`, objects, startMs, endMs: kept.length > 0 ? endMs : null };
}

// ---------------------------------------------------------------------------------------
// The route.

export type DvrDeps = Pick<
  OriginRouteContext,
  "publicKey" | "vodStates" | "media" | "segments" | "dvrMaxWindowSeconds" | "dvrPulls" | "metrics" | "logger" | "now"
> & {
  /** The channel's `dvr_window_seconds`; the default reads Postgres (cached `DVR_WINDOW_TTL_MS`). */
  channelWindow: (channelId: string) => Promise<number>;
  /** Member relays' bearer tokens for `/relay-pull/dvr/`; absent = that route answers 404. */
  relays?: Pick<RelayAuth, "authenticate">;
};

/** The channel's DVR window from Postgres, cached per channel. */
export function dbChannelWindow(db: Executor, now: () => number): DvrDeps["channelWindow"] {
  const cache = new TtlCache<number>(50_000, now);
  const lookups = new Coalescer<number>();
  return async (channelId) => {
    const cached = cache.get(channelId);
    if (cached !== undefined) return cached;
    return lookups.run(channelId, async () => {
      const [row] = await db
        .select({ w: schema.channels.dvrWindowSeconds })
        .from(schema.channels)
        .where(eq(schema.channels.id, channelId));
      const value = row?.w ?? DVR_RULES.defaultWindowSeconds;
      cache.set(channelId, value, DVR_WINDOW_TTL_MS);
      return value;
    }).promise;
  };
}

/** Why a token does not authorize a DVR path, or null when it does. */
export function dvrTokenRefusal(
  claims: PlaybackClaims,
  vodId: string,
): "wrong_path" | "wrong_source" | "data_mode" | null {
  if (claims.path !== dvrTokenPath(vodId)) return "wrong_path";
  if (claims.src !== "origin") return "wrong_source";
  if (claims.dm !== undefined) return "data_mode";
  return null;
}

const NO_STORE = "private, no-store";

/** The relay pull route for DVR (ADR 0016 Amendment 1 A1.3): `/relay-pull/dvr/<vodId>/<file>`. */
export const RELAY_PULL_DVR_ROUTE = `/relay-pull${DVR_ROUTE}`;
/** Failed relay authentications per peer address per minute before 429 (as the live pull route). */
export const RELAY_PULL_FAILURES_PER_MINUTE = 10;

/** Who is pulling: a viewer's DVR token, or a member relay's bearer token. */
type DvrPuller = { kind: "viewer"; claims: PlaybackClaims; token: string } | { kind: "relay"; relayId: string };

export function createDvrHandler(deps: DvrDeps): RouteHandler {
  const playlists = new TtlCache<RecordingPlaylist | null>(10_000, deps.now);
  const reads = new Coalescer<RecordingPlaylist | null>();
  const media = deps.media;
  const relayFailures = new FailureLimiter(RELAY_PULL_FAILURES_PER_MINUTE, 60_000, 50_000, deps.now);

  /** The recording's playlist, null when it does not exist yet. Throws on a storage failure. */
  async function recording(vodId: string): Promise<RecordingPlaylist | null> {
    const cached = playlists.get(vodId);
    if (cached !== undefined) return cached;
    return reads.run(vodId, async () => {
      if (!media) return null;
      const res = await media.storage.get(media.bucket, vodPrefix(vodId, "private") + VOD_PLAYLIST);
      const value = res ? parseRecording(await res.text()) : null;
      playlists.set(vodId, value, DVR_PLAYLIST_TTL_MS);
      return value;
    }).promise;
  }

  /** The viewer's token first: a wrong one learns nothing about the VOD. */
  async function viewer(req: Request, vodId: string): Promise<DvrPuller | Response> {
    const token = new URL(req.url).searchParams.get("t");
    if (!token || token.length > 4096) return mediaFail(401, "unauthorized");
    const v = await verifyPlaybackToken(deps.publicKey, token, Math.floor(deps.now() / 1000));
    if (!v.ok) return mediaFail(401, "unauthorized");
    // Viewers of a relay use the relay: a relay token never opens the origin's `/dvr/`.
    if (dvrTokenRefusal(v.value, vodId)) return mediaFail(401, "unauthorized");
    return { kind: "viewer", claims: v.value, token };
  }

  /** The relay's bearer token, checked as the live pull checks it (failures limited per peer). */
  async function relay(req: Request, peerIp: string | undefined): Promise<DvrPuller | Response> {
    if (!deps.relays) return mediaFail(404, "not_found");
    const ip = peerIp ?? "unknown";
    if (relayFailures.blocked(ip)) return mediaFail(429, "too_many_failed_attempts", { "retry-after": "60" });
    const r = await deps.relays.authenticate(req.headers.get("authorization"));
    if (r) return { kind: "relay", relayId: r.id };
    relayFailures.fail(ip);
    return mediaFail(401, "unauthorized");
  }

  return async (req, rawPath, peerIp) => {
    const relayPull = rawPath.startsWith(RELAY_PULL_DVR_ROUTE);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD")
      return mediaFail(405, "method_not_allowed", { allow: "GET, HEAD, OPTIONS" });
    const path = parseDvrPath(relayPull ? rawPath.slice("/relay-pull".length) : rawPath);
    if (!path || !media) return mediaFail(404, "not_found");

    const who = relayPull ? await relay(req, peerIp) : await viewer(req, path.vodId);
    if (who instanceof Response) return who;

    let vod: VodState | null;
    try {
      vod = await deps.vodStates.get(path.vodId);
    } catch {
      deps.logger?.warn("DVR state check failed");
      return mediaFail(404, "not_found");
    }
    // Only the private prefix holds a recording; a VOD already under `vods/` is not recording.
    if (!vod || !dvrServable(dvrStateOf(vod)) || vod.storagePrefix !== vodPrefix(path.vodId, "private"))
      return mediaFail(404, "not_found");
    if (who.kind === "viewer" && who.claims.cid !== vod.channelId) return mediaFail(401, "unauthorized");

    let rec: RecordingPlaylist | null;
    let windowSeconds: number;
    try {
      rec = await recording(path.vodId);
      windowSeconds = Math.min(await deps.channelWindow(vod.channelId), deps.dvrMaxWindowSeconds);
    } catch {
      deps.logger?.warn("DVR recording read failed");
      return mediaFail(502, "upstream_unavailable");
    }
    if (!rec || rec.segments.length === 0 || windowSeconds <= 0) return mediaFail(404, "not_found");
    const cut = cutToWindow(rec, windowSeconds);
    const dir = `dvr/${path.vodId}`;
    const channelId = vod.channelId;
    const account = (kind: "playlist" | "segment", bytes: number) => {
      const src = who.kind === "viewer" ? "origin" : "relay";
      deps.metrics.egress(src, bytes);
      deps.metrics.request("dvr", kind, src, 200);
      deps.segments.record({
        // A relay pull serves no one viewer session, so it is logged under the relay's id. The
        // worker never counts `relay` entries as session evidence: relay viewers are judged on
        // the relay's receipts.
        ...(who.kind === "viewer"
          ? { sid: who.claims.sid, cid: who.claims.cid, src: "origin" as const }
          : { sid: who.relayId, cid: channelId, src: "relay" as const, rid: who.relayId }),
        kind,
        bytes,
        at: deps.now(),
        ...(kind === "segment" ? { obj: `${dir}/${path.file}` } : {}),
        mode: "dvr",
      });
    };

    if (path.kind === "playlist") {
      if (path.file !== VOD_PLAYLIST) return mediaFail(404, "not_found");
      // Viewers get URIs carrying their token; a relay gets bare relative URIs and adds its viewers'.
      const body = rewritePlaylist(cut.text, {
        dir,
        root: dir,
        target: who.kind === "viewer" ? { kind: "relative", token: who.token } : { kind: "relative" },
      });
      const bytes = new TextEncoder().encode(body).byteLength;
      const headers = new Headers(CORS);
      headers.set("content-type", "application/vnd.apple.mpegurl");
      headers.set("content-length", String(bytes));
      headers.set("cache-control", NO_STORE);
      headers.set("x-content-type-options", "nosniff");
      if (req.method === "HEAD") return new Response(null, { status: 200, headers });
      account("playlist", bytes);
      return new Response(body, { status: 200, headers });
    }

    // Unlisted (outside the window, or still being recorded and not uploaded): not served.
    if (!cut.objects.has(path.file)) return mediaFail(404, "not_found");
    const read = await readObject(media, req, vodPrefix(path.vodId, "private") + path.file);
    if ("failed" in read) return read.failed;
    if ("missing" in read) return mediaFail(404, "not_found");
    const res = read.found;
    const headers = objectHeaders(res, NO_STORE);
    if (req.method === "HEAD") {
      await res.body?.cancel();
      return new Response(null, { status: res.status, headers });
    }
    const length = Number(res.headers.get("content-length") ?? "0");
    const bytes = Number.isFinite(length) && length > 0 ? length : 0;
    account("segment", bytes);
    // A whole object a relay may now serve its DVR viewers: the DVR side of relay issuance
    // (ADR 0016 Amendment 2). A range answer is not the object's size, so only a 200 counts.
    if (who.kind === "relay" && res.status === 200 && bytes > 0) {
      const seg = rec.segments.find((s) => s.uri === path.file);
      deps.dvrPulls?.record(
        path.vodId,
        { file: path.file, bytes, durationMs: seg ? Math.round(seg.durationSeconds * 1000) : 0 },
        deps.now(),
      );
    }
    return new Response(res.body, { status: res.status, headers });
  };
}

/** `/dvr/` and `/relay-pull/dvr/`: one route entry (one shared playlist cache), split by `match`. */
export const isDvrPath = (rawPath: string) => rawPath.startsWith(DVR_ROUTE) || rawPath.startsWith(RELAY_PULL_DVR_ROUTE);

export function registerDvrRoutes(registry: OriginRouteRegistry, ctx: OriginRouteContext): void {
  registry.register({
    name: "dvr",
    prefix: "/",
    match: isDvrPath,
    handle: createDvrHandler({
      ...ctx,
      channelWindow: dbChannelWindow(ctx.db, ctx.now),
      relays: new RelayAuth({ db: ctx.db }),
    }),
  });
}
