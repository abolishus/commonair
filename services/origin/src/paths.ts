// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Strict parsing of HLS request paths. Everything the origin forwards to MediaMTX
 * goes through here, so the grammar is deliberately narrow: a known route prefix,
 * `live/<slug>`, an optional known rendition directory and one flat file name with
 * a known extension. No dot segments, no percent-encoding, no nested directories.
 */
import { RENDITIONS } from "@commonair/contracts/enums";
import { mediaPath } from "@commonair/contracts/internal";
import { DVR_ROUTE } from "@commonair/contracts/storage";

export const ROUTES = { hls: "/hls/", relayPull: "/relay-pull/", cdn: "/cdn/" } as const;
export type Route = keyof typeof ROUTES;

export type MediaKind = "playlist" | "segment" | "part";
export type Rendition = Exclude<(typeof RENDITIONS)[number], "source">;

const RENDITION_DIRS = new Set<string>(RENDITIONS.filter((r) => r !== "source"));
const SLUG = /^[a-z0-9_]{3,25}$/;
const FILE = /^[A-Za-z0-9_-]{1,128}\.(m3u8|mp4|m4s|m4a|m4v|ts|aac|vtt)$/;
/** MediaMTX names LL-HLS parts `<prefix>_<track>_part<N>.mp4`. */
const PART = /_part\d+\.[a-z0-9]+$/;

export interface MediaRequest {
  route: Route;
  slug: string;
  /** Undefined for the source path. */
  rendition?: Rendition;
  file: string;
  kind: MediaKind;
  /** MediaMTX path, e.g. `live/<slug>` or `live/<slug>/720p`. */
  upstreamPath: string;
  /** The channel's MediaMTX path the playback token must name (always the source path). */
  channelPath: string;
  /** True for `index.m3u8` at the channel root: the playlist the origin may synthesize. */
  isMultivariant: boolean;
}

/**
 * Parse the raw request target (path only, as sent by the client). Returns null for
 * anything outside the grammar; callers answer 404 without touching upstream.
 */
export function parseMediaPath(rawPath: string): MediaRequest | null {
  if (!safeRaw(rawPath)) return null;
  const route = (Object.keys(ROUTES) as Route[]).find((r) => rawPath.startsWith(ROUTES[r]));
  if (!route) return null;
  const parts = rawPath.slice(ROUTES[route].length).split("/");
  if (parts[0] !== "live" || (parts.length !== 3 && parts.length !== 4)) return null;
  const slug = parts[1] ?? "";
  if (!SLUG.test(slug)) return null;
  let rendition: Rendition | undefined;
  if (parts.length === 4) {
    const dir = parts[2] ?? "";
    if (!RENDITION_DIRS.has(dir)) return null;
    rendition = dir as Rendition;
  }
  const file = parts.at(-1) ?? "";
  if (!FILE.test(file)) return null;
  const channelPath = mediaPath(slug);
  return {
    route,
    slug,
    rendition,
    file,
    kind: classify(file),
    upstreamPath: rendition ? `${channelPath}/${rendition}` : channelPath,
    channelPath,
    isMultivariant: rendition === undefined && file === "index.m3u8",
  };
}

/**
 * Every request kind the origin dispatches (W2 contract step). `MediaKind` is the MediaMTX grammar
 * above; `subtitles` (a live subtitle playlist) and `vtt` (a WebVTT segment) are the captions route
 * under the live path (W2-captions, `captions.ts`); `dvr` is `/dvr/<vodId>/<file>` (W2-dvr,
 * `dvr.ts`). The handlers own what they serve; the grammar lives here so no unit edits it.
 */
export type RequestKind = MediaKind | "subtitles" | "vtt" | "dvr";

/** Directory under `live/<slug>/` that holds caption tracks: `captions/<language>/<file>`. */
export const CAPTIONS_DIR = "captions";
/** A caption track's subtitle playlist. */
export const SUBTITLE_PLAYLIST = "index.m3u8";
/** The BCP 47 subset `vodCaptionsKey` accepts (`en`, `es`, `pt-BR`). */
const CAPTION_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
const VTT_FILE = /^[A-Za-z0-9_-]{1,128}\.vtt$/;

export interface CaptionsRequest {
  route: Route;
  slug: string;
  language: string;
  file: string;
  kind: "subtitles" | "vtt";
  /** The channel's MediaMTX path the playback token must name. */
  channelPath: string;
}

/**
 * `/<route>/live/<slug>/captions/<language>/index.m3u8` (subtitle playlist) or
 * `…/<language>/<name>.vtt` (segment), on every pull route so relays and CDNs can carry them.
 * Null for anything else, including every path `parseMediaPath` accepts.
 */
export function parseCaptionsPath(rawPath: string): CaptionsRequest | null {
  if (!safeRaw(rawPath)) return null;
  const route = (Object.keys(ROUTES) as Route[]).find((r) => rawPath.startsWith(ROUTES[r]));
  if (!route) return null;
  const parts = rawPath.slice(ROUTES[route].length).split("/");
  if (parts.length !== 5 || parts[0] !== "live" || parts[2] !== CAPTIONS_DIR) return null;
  const [, slug = "", , language = "", file = ""] = parts;
  if (!SLUG.test(slug) || !CAPTION_LANGUAGE.test(language)) return null;
  const kind = file === SUBTITLE_PLAYLIST ? "subtitles" : VTT_FILE.test(file) ? "vtt" : null;
  if (!kind) return null;
  return { route, slug, language, file, kind, channelPath: mediaPath(slug) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The in-progress recording's objects: its playlist, init segment and fMP4 segments. */
const DVR_FILE = /^[A-Za-z0-9_-]{1,128}\.(m3u8|mp4|m4s)$/;

export interface DvrRequest {
  vodId: string;
  file: string;
  /** `playlist` for a `.m3u8`, `segment` for the init and media segments. */
  kind: "playlist" | "segment";
}

/** `/dvr/<vodId>/<file>` (ADR 0016 decision 2), or null. */
export function parseDvrPath(rawPath: string): DvrRequest | null {
  if (!safeRaw(rawPath) || !rawPath.startsWith(DVR_ROUTE)) return null;
  const parts = rawPath.slice(DVR_ROUTE.length).split("/");
  if (parts.length !== 2) return null;
  const [vodId = "", file = ""] = parts;
  if (!UUID.test(vodId) || !DVR_FILE.test(file)) return null;
  return { vodId, file, kind: file.endsWith(".m3u8") ? "playlist" : "segment" };
}

/** The kind of any origin request path, or null when no grammar accepts it. */
export function requestKindOf(rawPath: string): RequestKind | null {
  const captions = parseCaptionsPath(rawPath);
  if (captions) return captions.kind;
  if (parseDvrPath(rawPath)) return "dvr";
  return parseMediaPath(rawPath)?.kind ?? null;
}

/** No dot segments, percent-encoding, backslashes, empty segments or non-printable bytes. */
function safeRaw(rawPath: string): boolean {
  return rawPath.length <= 256 && !/[%\\]|\/\/|\/\.|\.\.|[^\x21-\x7e]/.test(rawPath);
}

export function classify(file: string): MediaKind {
  if (file.endsWith(".m3u8")) return "playlist";
  return PART.test(file) ? "part" : "segment";
}

/** Extract the path component of a request URL without the normalization `new URL()` applies. */
export function rawPathOf(url: string): string {
  const scheme = url.indexOf("://");
  const start = scheme === -1 ? 0 : url.indexOf("/", scheme + 3);
  if (start === -1) return "/";
  const q = url.indexOf("?", start);
  const h = url.indexOf("#", start);
  const end = Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h);
  return url.slice(start, end);
}

export const CONTENT_TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  mp4: "video/mp4",
  m4s: "video/iso.segment",
  m4v: "video/mp4",
  m4a: "audio/mp4",
  ts: "video/mp2t",
  aac: "audio/aac",
  vtt: "text/vtt",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[file.slice(file.lastIndexOf(".") + 1)] ?? "application/octet-stream";
}

/** LL-HLS blocking-reload directives, validated; anything else in the query is dropped. */
export interface HlsDirectives {
  msn?: number;
  part?: number;
  skip?: "YES" | "v2";
}

export function parseHlsDirectives(params: URLSearchParams): HlsDirectives | null {
  const out: HlsDirectives = {};
  const msn = params.get("_HLS_msn");
  const part = params.get("_HLS_part");
  const skip = params.get("_HLS_skip");
  const int = /^\d{1,15}$/;
  if (msn !== null) {
    if (!int.test(msn)) return null;
    out.msn = Number(msn);
  }
  if (part !== null) {
    // RFC 8216bis: _HLS_part without _HLS_msn is a client error.
    if (!int.test(part) || out.msn === undefined) return null;
    out.part = Number(part);
  }
  if (skip !== null) {
    if (skip !== "YES" && skip !== "v2") return null;
    out.skip = skip;
  }
  return out;
}

/** Stable query string for upstream requests and cache keys. */
export function directivesQuery(d: HlsDirectives): string {
  const q: string[] = [];
  if (d.msn !== undefined) q.push(`_HLS_msn=${d.msn}`);
  if (d.part !== undefined) q.push(`_HLS_part=${d.part}`);
  if (d.skip !== undefined) q.push(`_HLS_skip=${d.skip}`);
  return q.join("&");
}

export const isBlocking = (d: HlsDirectives) => d.msn !== undefined;
