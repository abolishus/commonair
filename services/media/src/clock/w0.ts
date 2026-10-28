// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W0: the wall-clock time of PTS 0 on a source path's own stream timeline (ADR 0012, variant A2).
 *
 * MediaMTX serves SRT readers MPEG-TS whose PTS is the path's stream timeline, the same for every
 * reader session, and its LL-HLS muxer writes `tfdt` from that timeline plus a fixed 10 s. So one
 * complete LL-HLS segment gives `W0 = PDT − (pts / timescale − 10 s)`. A `-copyts` SRT reader
 * then maps every frame to the source's wall clock with `W0 + pts`: the ladder passes it to its
 * RTSP outputs (`-start_time_realtime`), the recorder adds it to its fMP4 times.
 *
 * MPEG-TS PTS wraps at 2^33 ticks of 90 kHz (about 26.5 h). ffmpeg unwraps within one session,
 * so W0 is fetched fresh for every ffmpeg start and rebased to the representation that session
 * will use (`rebasePts`).
 *
 * W0 is only taken once the path's PDT has settled (`w0Settled`). MediaMTX stamps a non-RTSP
 * source's PDT from arrival (its NTP estimator: projected from the first packet, re-anchored to
 * the arrival time when media would land in the future or more than 5 s in the past), while the
 * SRT timeline only follows the media. A publisher that runs faster than real time for a while,
 * such as ffmpeg's `-re` catching up at 1.05× after a WHIP handshake, moves PDT about 5 % against
 * the timeline until it has caught up (~30 s for a 1.5 s late start); a W0 read then stays that
 * far off for the whole ffmpeg run (measured 2026-10-28, `clock-whip.int.test.ts`). The first
 * segment's PDT is also set before the publisher's start-up burst is over (500 ms off on a steady
 * source), so W0 is never taken from a playlist's only segment.
 */
import { MEDIA_INTERNAL_USER } from "@commonair/contracts/internal";
import { parseFragment, parseInit, type InitTrack } from "./boxes.ts";

/** MediaMTX's LL-HLS `tfdt` runs this far ahead of its MPEG-TS timeline (measured, 1.21.2). */
export const HLS_TFDT_OFFSET_SECONDS = 10;
/** MPEG-TS PTS period: 2^33 ticks at 90 kHz. */
export const PTS_WRAP_SECONDS = 2 ** 33 / 90_000;
/**
 * libavformat's wrap correction (`update_wraparound`): a session whose first timestamp lies in the
 * last 60 s before the wrap counts later (pre-wrap) times as negative instead of adding 2^33 to
 * post-wrap ones.
 */
const FFMPEG_WRAP_WINDOW_SECONDS = 60;
/**
 * A fetched segment this close before ffmpeg's window may be followed by a reader whose first packet
 * lands inside it: refused as well.
 */
const AMBIGUOUS_SECONDS = 15;

/** Refused from here to the wrap: ffmpeg's SUB window plus the ambiguous seconds before it. */
const WRAP_REFUSE_FROM_SECONDS = PTS_WRAP_SECONDS - FFMPEG_WRAP_WINDOW_SECONDS - AMBIGUOUS_SECONDS;

export class W0Error extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "http" | "too_large" | "playlist" | "segment" | "wrap" | "unsettled",
  ) {
    super(message);
    this.name = "W0Error";
  }
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/**
 * A stream-timeline time (seconds, possibly unwrapped by MediaMTX) in the representation a
 * `-copyts` ffmpeg session that opens now will use: modulo the wrap. Throws `W0Error("wrap")`
 * from shortly before ffmpeg's 60 s window up to the wrap itself. A session opened inside that
 * window gets negative times, which the RTSP and HLS/fMP4 muxers (no AVFMT_TS_NEGATIVE) shift by
 * `avoid_negative_ts`, so `W0 + pts` would be up to 60 s off: the caller retries after the wrap.
 */
export function rebasePts(seconds: number): number {
  const r = mod(seconds, PTS_WRAP_SECONDS);
  if (r > WRAP_REFUSE_FROM_SECONDS) throw new W0Error("source timeline is about to wrap; retry", "wrap");
  return r;
}

/**
 * Whether a `-copyts` session that opened at `streamSeconds` on the source timeline (less
 * `marginSeconds` of host-to-source skew) may have opened inside the refused window, so its output
 * times may have been shifted and cannot be anchored with `W0 + pts`. Only the side before the
 * wrap: a new stream's timeline may itself start near 0.
 */
export function opensNearWrap(streamSeconds: number, marginSeconds = 5): boolean {
  return mod(streamSeconds, PTS_WRAP_SECONDS) > WRAP_REFUSE_FROM_SECONDS - marginSeconds;
}

export interface W0Sample {
  /** EXT-X-PROGRAM-DATE-TIME of the segment, epoch ms. */
  pdtMs: number;
  /** Decode time (`tfdt`) of the segment's first sample on the PDT's track, in track ticks. */
  baseDecodeTime: number;
  /** That sample's composition offset (B-frames), in track ticks. */
  compositionOffset: number;
  timescale: number;
}

/** `W0 = PDT − rebase(pts / timescale − 10 s)`, in epoch milliseconds (fractional). */
export function computeW0(s: W0Sample): number {
  const pts = (s.baseDecodeTime + s.compositionOffset) / s.timescale - HLS_TFDT_OFFSET_SECONDS;
  return s.pdtMs - rebasePts(pts) * 1000;
}

/**
 * The track MediaMTX's PDT refers to: the playlist's video track when it has one, otherwise its
 * first audio track (audio-only sources).
 */
export function pdtTrack(tracks: readonly InitTrack[]): InitTrack | null {
  return tracks.find((t) => t.handler === "vide") ?? tracks.find((t) => t.handler === "soun") ?? null;
}

export interface MediaSegmentRef {
  uri: string;
  map: string;
  pdtMs: number;
  /** `#EXTINF` duration, ms. MediaMTX cuts segments on keyframes, so about the source's GOP. */
  durationMs: number;
}

/** First variant URI of a multivariant playlist, or null when `text` is a media playlist. */
export function firstVariant(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.startsWith("#EXT-X-STREAM-INF")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l && !l.startsWith("#")) return l;
    }
  }
  return null;
}

/**
 * Every complete segment that carries a PDT and an init section, oldest first. LL-HLS parts
 * after the last `#EXTINF` belong to a segment still being written and are ignored.
 */
export function completeSegments(text: string): MediaSegmentRef[] {
  let map: string | null = null;
  let pdt: number | null = null;
  let inf: number | null = null;
  const found: MediaSegmentRef[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) map = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      pdt = Number.isNaN(t) ? null : t;
    } else if (line.startsWith("#EXTINF:")) {
      const d = Number.parseFloat(line.slice("#EXTINF:".length));
      inf = Number.isFinite(d) && d >= 0 ? Math.round(d * 1000) : null;
    } else if (!line.startsWith("#")) {
      if (inf !== null && pdt !== null && map) found.push({ uri: line, map, pdtMs: pdt, durationMs: inf });
      inf = null;
      pdt = null;
    }
  }
  return found;
}

/** The newest complete segment that carries a PDT and an init section. */
export function newestSegment(text: string): MediaSegmentRef | null {
  return completeSegments(text).at(-1) ?? null;
}

/**
 * The segment W0 is checked against: the oldest complete one (the longest span), except the very
 * first entry of a playlist with three or more, which MediaMTX may delete before it is fetched.
 * Null when the playlist has fewer than two.
 */
export function referenceSegment(segments: readonly MediaSegmentRef[]): MediaSegmentRef | null {
  if (segments.length < 2) return null;
  return segments[segments.length >= 3 ? 1 : 0] ?? null;
}

/**
 * Settled W0 may differ between two segments by this much plus `W0_SETTLE_RATE` of the PDT span
 * between them: PDT is rounded to the millisecond, and a publisher's media clock may run a little
 * off the wall clock. A publisher catching up at ffmpeg's 1.05× moves W0 ten times the rate
 * allowed.
 */
export const W0_SETTLE_FLOOR_MS = 4;
export const W0_SETTLE_RATE = 0.005;

export interface W0Settle {
  /** PDT of the newest segment minus PDT of the reference segment, ms. */
  spanMs: number;
  /** W0 of the newest segment minus W0 of the reference segment, ms. */
  driftMs: number;
}

/** Whether two segments' W0 agree well enough that the path's PDT is no longer moving. */
export function w0Settled(s: W0Settle): boolean {
  return s.spanMs > 0 && Math.abs(s.driftMs) <= W0_SETTLE_FLOOR_MS + W0_SETTLE_RATE * s.spanMs;
}

export interface FetchW0Options {
  /** MEDIAMTX_HLS_URL. */
  hlsBase: string;
  /** MediaMTX path, `live/<slug>`. */
  path: string;
  /** The internal user's password (basic auth); never put in a URL. */
  password: string;
  timeoutMs?: number;
  /** Cap on any one response (playlists, init, segment). */
  maxBytes?: number;
  fetch?: typeof fetch;
  /**
   * Refuse (`W0Error("unsettled")`) a W0 whose PDT is still moving (default). False returns the
   * newest segment's W0 anyway, with `settle` saying how far it moved: the media clock's last
   * resort for a source that never settles.
   */
  requireSettled?: boolean;
}

export interface W0Result {
  w0Ms: number;
  sample: W0Sample;
  handler: string;
  /** Against the reference segment; null when only one segment was available (unsettled). */
  settle: W0Settle | null;
  /** The newest segment's duration, ms: about the source's keyframe interval. */
  segmentMs: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Read W0 for a path from MediaMTX's LL-HLS: multivariant, first media playlist, its init
 * section, its newest complete segment and an older one to check that W0 has settled (five
 * bounded requests under one deadline). Errors name the path only, never a URL with credentials.
 */
export async function fetchW0(opts: FetchW0Options): Promise<W0Result> {
  const doFetch = opts.fetch ?? fetch;
  const max = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const base = new URL(opts.hlsBase.endsWith("/") ? opts.hlsBase : `${opts.hlsBase}/`);
  const auth = `Basic ${Buffer.from(`${MEDIA_INTERNAL_USER}:${opts.password}`).toString("base64")}`;

  const get = async (url: URL, what: string): Promise<Uint8Array> => {
    let target = url;
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await doFetch(target, { headers: { authorization: auth }, redirect: "manual", signal });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new W0Error(
          `${what} of ${opts.path}: ${timedOut ? "timed out" : "unreachable"}`,
          timedOut ? "timeout" : "http",
        );
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location && hop === 0) {
        // MediaMTX's cookie check; never follow another origin with our credentials.
        await res.body?.cancel();
        const next = new URL(location, target);
        if (next.origin !== base.origin) throw new W0Error(`${what} of ${opts.path}: cross-origin redirect`, "http");
        target = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new W0Error(`${what} of ${opts.path}: HTTP ${res.status}`, "http");
      }
      return readCapped(res, max, `${what} of ${opts.path}`);
    }
  };
  const text = (b: Uint8Array) => new TextDecoder().decode(b);

  try {
    const mvUrl = new URL(`${opts.path}/index.m3u8`, base);
    const mv = text(await get(mvUrl, "multivariant playlist"));
    const variant = firstVariant(mv);
    const mediaUrl = variant ? new URL(variant, mvUrl) : mvUrl;
    const media = variant ? text(await get(mediaUrl, "media playlist")) : mv;
    const segments = completeSegments(media);
    const seg = segments.at(-1);
    if (!seg) throw new W0Error(`media playlist of ${opts.path}: no complete segment with a PDT yet`, "playlist");
    // Only segments of the same init section: one MediaMTX muxer, one timeline.
    const ref = referenceSegment(segments.filter((s) => s.map === seg.map));
    const requireSettled = opts.requireSettled ?? true;
    if (!ref && requireSettled)
      throw new W0Error(`media playlist of ${opts.path}: one segment, W0 not settled yet`, "unsettled");
    const [init, frag, refFrag] = await Promise.all([
      get(new URL(seg.map, mediaUrl), "init section"),
      get(new URL(seg.uri, mediaUrl), "segment"),
      ref ? get(new URL(ref.uri, mediaUrl), "reference segment") : null,
    ]);
    const track = pdtTrack(parseInit(init));
    if (!track) throw new W0Error(`init section of ${opts.path}: no audio or video track`, "segment");
    const sampleOf = (bytes: Uint8Array, pdtMs: number, what: string): W0Sample => {
      const t = parseFragment(bytes).find((f) => f.trackId === track.trackId);
      if (!t) throw new W0Error(`${what} of ${opts.path}: no fragment for track ${track.trackId}`, "segment");
      return {
        pdtMs,
        baseDecodeTime: t.baseDecodeTime,
        compositionOffset: t.firstCompositionOffset,
        timescale: track.timescale,
      };
    };
    const sample = sampleOf(frag, seg.pdtMs, "segment");
    const w0Ms = computeW0(sample);
    let settle: W0Settle | null = null;
    if (ref && refFrag) {
      const refW0 = computeW0(sampleOf(refFrag, ref.pdtMs, "reference segment"));
      settle = { spanMs: seg.pdtMs - ref.pdtMs, driftMs: w0Ms - refW0 };
    }
    if (requireSettled && (!settle || !w0Settled(settle)))
      throw new W0Error(
        `${opts.path}: W0 not settled yet (moved ${Math.round(settle?.driftMs ?? 0)} ms over ${Math.round(settle?.spanMs ?? 0)} ms)`,
        "unsettled",
      );
    return { w0Ms, sample, handler: track.handler, settle, segmentMs: seg.durationMs };
  } catch (err) {
    if (err instanceof W0Error) throw err;
    throw new W0Error(`${opts.path}: ${err instanceof Error ? err.message : String(err)}`, "segment");
  }
}

async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel();
    throw new W0Error(`${what}: larger than ${max} bytes`, "too_large");
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new W0Error(`${what}: larger than ${max} bytes`, "too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}
