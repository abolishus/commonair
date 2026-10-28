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
 * A fetched segment this close before ffmpeg's window could belong to either representation,
 * depending on when the reader's first packet lands: refuse, the caller retries a few seconds later.
 */
const AMBIGUOUS_SECONDS = 15;

export class W0Error extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "http" | "too_large" | "playlist" | "segment" | "wrap",
  ) {
    super(message);
    this.name = "W0Error";
  }
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/**
 * A stream-timeline time (seconds, possibly unwrapped by MediaMTX) in the representation a
 * `-copyts` ffmpeg session that opens now will use: modulo the wrap, and negative in the last
 * 60 s before it (libavformat subtracts 2^33 there). Throws `W0Error("wrap")` in the few seconds
 * where the session could land on either side.
 */
export function rebasePts(seconds: number): number {
  const r = mod(seconds, PTS_WRAP_SECONDS);
  const sub = PTS_WRAP_SECONDS - FFMPEG_WRAP_WINDOW_SECONDS;
  if (r > sub) return r - PTS_WRAP_SECONDS;
  if (r > sub - AMBIGUOUS_SECONDS) throw new W0Error("source timeline is about to wrap; retry", "wrap");
  return r;
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
 * The newest complete segment that carries a PDT and an init section. LL-HLS parts after the last
 * `#EXTINF` belong to a segment still being written and are ignored.
 */
export function newestSegment(text: string): MediaSegmentRef | null {
  let map: string | null = null;
  let pdt: number | null = null;
  let inf = false;
  let found: MediaSegmentRef | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) map = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      pdt = Number.isNaN(t) ? null : t;
    } else if (line.startsWith("#EXTINF:")) inf = true;
    else if (!line.startsWith("#")) {
      if (inf && pdt !== null && map) found = { uri: line, map, pdtMs: pdt };
      inf = false;
      pdt = null;
    }
  }
  return found;
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
}

export interface W0Result {
  w0Ms: number;
  sample: W0Sample;
  handler: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Read W0 for a path from MediaMTX's LL-HLS: multivariant, first media playlist, its init
 * section and its newest complete segment (four bounded requests under one deadline). Errors name
 * the path only, never a URL with credentials.
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
    const seg = newestSegment(media);
    if (!seg) throw new W0Error(`media playlist of ${opts.path}: no complete segment with a PDT yet`, "playlist");
    const [init, frag] = await Promise.all([
      get(new URL(seg.map, mediaUrl), "init section"),
      get(new URL(seg.uri, mediaUrl), "segment"),
    ]);
    const track = pdtTrack(parseInit(init));
    if (!track) throw new W0Error(`init section of ${opts.path}: no audio or video track`, "segment");
    const t = parseFragment(frag).find((f) => f.trackId === track.trackId);
    if (!t) throw new W0Error(`segment of ${opts.path}: no fragment for track ${track.trackId}`, "segment");
    const sample: W0Sample = {
      pdtMs: seg.pdtMs,
      baseDecodeTime: t.baseDecodeTime,
      compositionOffset: t.firstCompositionOffset,
      timescale: track.timescale,
    };
    return { w0Ms: computeW0(sample), sample, handler: track.handler };
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
