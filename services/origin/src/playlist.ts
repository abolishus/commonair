// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HLS playlist rewriting and multivariant synthesis. Pure string functions: the
 * origin caches raw upstream playlists once and rewrites them per request, because
 * every viewer's URIs carry that viewer's token.
 *
 * Every URI is rewritten: plain URI lines (variants, segments) and `URI="…"`
 * attributes on any tag (EXT-X-MAP, EXT-X-PART, EXT-X-PRELOAD-HINT,
 * EXT-X-RENDITION-REPORT, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-KEY, …).
 * MediaMTX's own `session=` query parameter is always removed: upstream sessions
 * belong to the origin and must never reach clients.
 */

export type UriTarget =
  /** Relative to the playlist's own directory (origin-delivered viewers, relay pulls, CDN pulls). */
  | { kind: "relative"; token?: string }
  /** `<base>/<path>`: a relay's `<publicUrl>/hls` or the CDN base. */
  | { kind: "absolute"; base: string; token?: string };

export interface RewriteContext {
  /** Directory of the playlist being rewritten, e.g. `live/alice` or `live/alice/720p`. */
  dir: string;
  /** The channel's root directory (`live/<slug>`); resolved URIs must stay inside it. */
  root: string;
  target: UriTarget;
}

/** Query parameters the origin owns: stripped from upstream URIs, then `t` is re-added once. */
const OWNED_PARAMS = ["session", "t", "cookieCheck"];
/** Matches the `URI` attribute exactly (not `SERVER-URI` and friends). */
const URI_ATTR = /(^|[:,])URI="([^"]*)"/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function normalize(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const s of segments) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

function relativize(path: string, dir: string): string {
  if (path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
  const from = dir.split("/");
  const to = path.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...Array.from({ length: from.length - i }, () => ".."), ...to.slice(i)].join("/");
}

/** Rewrite one URI. URIs that are absolute or escape the channel root are returned unchanged and never get a token. */
export function rewriteUri(uri: string, ctx: RewriteContext): string {
  if (uri === "" || SCHEME.test(uri) || uri.startsWith("//")) return uri;
  const hash = uri.indexOf("#");
  const noHash = hash === -1 ? uri : uri.slice(0, hash);
  const q = noHash.indexOf("?");
  const pathPart = q === -1 ? noHash : noHash.slice(0, q);
  const query = new URLSearchParams(q === -1 ? "" : noHash.slice(q + 1));
  const base = pathPart.startsWith("/") ? [] : ctx.dir.split("/");
  const resolved = normalize([...base, ...pathPart.split("/")]);
  if (!resolved) return uri;
  const path = resolved.join("/");
  if (!path.startsWith(`${ctx.root}/`)) return uri;

  for (const p of OWNED_PARAMS) query.delete(p);
  if (ctx.target.token) query.append("t", ctx.target.token);
  const qs = query.toString();
  const out = ctx.target.kind === "relative" ? relativize(path, ctx.dir) : `${ctx.target.base}/${path}`;
  return qs ? `${out}?${qs}` : out;
}

export function rewritePlaylist(text: string, ctx: RewriteContext): string {
  return splitLines(text)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return line;
      if (trimmed.startsWith("#")) {
        if (!trimmed.startsWith("#EXT")) return line;
        return trimmed.replace(URI_ATTR, (_m, lead: string, uri: string) => `${lead}URI="${rewriteUri(uri, ctx)}"`);
      }
      return rewriteUri(trimmed, ctx);
    })
    .join("\n");
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // Keep a single trailing newline rather than accumulating blank lines.
  if (lines.at(-1) === "") lines.pop();
  return [...lines, ""];
}

/** Full media segment URIs (without query) listed in a media playlist, in order. */
export function mediaSegmentUris(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.split("?")[0] ?? l);
}

export const isMultivariantText = (text: string) => text.includes("#EXT-X-STREAM-INF");

// ---------------------------------------------------------------------------------------
// Attribute lists (RFC 8216 §4.2)

export type AttributeList = [name: string, rawValue: string][];

export function parseAttributes(list: string): AttributeList {
  const out: AttributeList = [];
  let i = 0;
  while (i < list.length) {
    const eq = list.indexOf("=", i);
    if (eq === -1) break;
    const name = list.slice(i, eq).trim();
    let j = eq + 1;
    if (list[j] === '"') {
      const close = list.indexOf('"', j + 1);
      j = close === -1 ? list.length : close + 1;
    } else {
      const comma = list.indexOf(",", j);
      j = comma === -1 ? list.length : comma;
    }
    out.push([name, list.slice(eq + 1, j)]);
    i = list[j] === "," ? j + 1 : j;
  }
  return out;
}

export const serializeAttributes = (attrs: AttributeList) => attrs.map(([k, v]) => `${k}=${v}`).join(",");
export const attr = (attrs: AttributeList, name: string) => attrs.find(([k]) => k === name)?.[1];
export const unquote = (v: string | undefined) => (v?.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

function setAttr(attrs: AttributeList, name: string, value: string): void {
  const hit = attrs.find(([k]) => k === name);
  if (hit) hit[1] = value;
  else attrs.push([name, value]);
}

// ---------------------------------------------------------------------------------------
// Multivariant synthesis

export interface VariantSource {
  /** `source` for the channel path, otherwise the rendition directory name. */
  rendition: string;
  /** That path's own multivariant playlist, as served by MediaMTX. */
  text: string;
}

/** Bandwidth advertised for the synthesized audio-only variant when no `audio` rendition exists (AAC-LC stereo plus container overhead). */
export const AUDIO_ONLY_BANDWIDTH = 192_000;
const AUDIO_CODEC = /^(mp4a|opus|ac-3|ec-3|flac|alac)/i;
const GROUP_ATTRS = ["AUDIO", "VIDEO", "SUBTITLES", "CLOSED-CAPTIONS"];

interface Collected {
  version: number;
  independent: boolean;
  media: string[];
  variants: { bandwidth: number; inf: string; uri: string; audioOnly: boolean }[];
}

/**
 * Combine the source path's multivariant playlist and each rendition's own multivariant
 * playlist (`live/<slug>/<rendition>/index.m3u8`) into one ladder. BANDWIDTH, RESOLUTION,
 * CODECS and FRAME-RATE come from MediaMTX's playlists, which measure the real streams.
 * Group ids are namespaced per rendition so audio groups never collide. If no `audio`
 * rendition is published, an audio-only variant is derived from the source's audio group.
 * URIs in the result are relative to the channel root (feed it through rewritePlaylist).
 */
export function synthesizeMultivariant(sources: VariantSource[]): string {
  const c: Collected = { version: 0, independent: false, media: [], variants: [] };
  let sourceAudio: { uri: string; codec?: string } | undefined;
  const hasAudioRendition = sources.some((s) => s.rendition === "audio");

  for (const src of sources) {
    const prefix = src.rendition === "source" ? "" : `${src.rendition}/`;
    const ns = (group: string) => `"${src.rendition}-${unquote(group) ?? ""}"`;
    const lines = src.text.split(/\r?\n/).map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("#EXT-X-VERSION:")) c.version = Math.max(c.version, Number(line.slice(15)) || 0);
      else if (line === "#EXT-X-INDEPENDENT-SEGMENTS") c.independent = true;
      else if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttributes(line.slice(13));
        const group = attr(attrs, "GROUP-ID");
        if (group) setAttr(attrs, "GROUP-ID", ns(group));
        const uri = unquote(attr(attrs, "URI"));
        if (uri !== undefined) setAttr(attrs, "URI", `"${prefix}${uri}"`);
        if (src.rendition === "source" && attr(attrs, "TYPE") === "AUDIO" && uri !== undefined && !sourceAudio)
          sourceAudio = { uri: `${prefix}${uri}` };
        c.media.push(`#EXT-X-MEDIA:${serializeAttributes(attrs)}`);
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = parseAttributes(line.slice(18));
        for (const g of GROUP_ATTRS) {
          const v = attr(attrs, g);
          if (v && v !== "NONE") setAttr(attrs, g, ns(v));
        }
        let j = i + 1;
        while (j < lines.length && (lines[j] === "" || lines[j]?.startsWith("#"))) j++;
        const uri = lines[j];
        if (uri === undefined) continue;
        i = j;
        const codecs = (unquote(attr(attrs, "CODECS")) ?? "").split(",").map((s) => s.trim());
        const audioOnly = attr(attrs, "RESOLUTION") === undefined && codecs.every((cd) => AUDIO_CODEC.test(cd));
        if (src.rendition === "source" && sourceAudio && !sourceAudio.codec)
          sourceAudio.codec = codecs.find((cd) => AUDIO_CODEC.test(cd));
        c.variants.push({
          bandwidth: Number(attr(attrs, "BANDWIDTH")) || 0,
          inf: `#EXT-X-STREAM-INF:${serializeAttributes(attrs)}`,
          uri: `${prefix}${uri}`,
          audioOnly,
        });
      }
    }
  }

  if (!hasAudioRendition && sourceAudio?.codec) {
    c.variants.push({
      bandwidth: AUDIO_ONLY_BANDWIDTH,
      inf: `#EXT-X-STREAM-INF:BANDWIDTH=${AUDIO_ONLY_BANDWIDTH},CODECS="${sourceAudio.codec}"`,
      uri: sourceAudio.uri,
      audioOnly: true,
    });
  }

  // Video variants by descending bandwidth (players start with the first listed), audio-only last.
  c.variants.sort((a, b) => Number(a.audioOnly) - Number(b.audioOnly) || b.bandwidth - a.bandwidth);
  const out = ["#EXTM3U", `#EXT-X-VERSION:${c.version || 9}`];
  if (c.independent) out.push("#EXT-X-INDEPENDENT-SEGMENTS");
  out.push("", ...c.media, "");
  for (const v of c.variants) out.push(v.inf, v.uri, "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------
// Data mode (ADR 0018 decision 5)

/** LL-HLS tags a data-mode media playlist drops (RFC 8216bis §4.4.3.7–4.4.5.3, §4.4.3.8). */
const LOW_LATENCY_TAGS = [
  "#EXT-X-PART-INF:",
  "#EXT-X-PART:",
  "#EXT-X-PRELOAD-HINT:",
  "#EXT-X-RENDITION-REPORT:",
  "#EXT-X-SERVER-CONTROL:",
];

/**
 * A media playlist without its low-latency layer, for data-mode tokens: complete segments only.
 * Every rewritten URI carries the viewer's ~330-character token, so an LL-HLS playlist is several
 * kilobytes, and an LL player reloads it once per part (5 times a second); on an audio-only budget
 * that polling costs more than the audio itself. Without parts and `CAN-BLOCK-RELOAD` players
 * reload once per target duration and fetch whole segments (integrity counts both the same way).
 * Tags of the in-progress segment, which has parts but no `EXTINF` yet, go with it.
 */
export function stripLowLatency(media: string): string {
  const lines = media.split(/\r?\n/).filter((l) => !LOW_LATENCY_TAGS.some((tag) => l.trim().startsWith(tag)));
  let lastUri = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t !== "" && !t.startsWith("#")) lastUri = i;
  });
  if (lastUri === -1) return lines.join("\n");
  const tail = lines.slice(lastUri + 1).filter((l) => l.trim() === "" || l.trim() === "#EXT-X-ENDLIST");
  return [...lines.slice(0, lastUri + 1), ...tail].join("\n");
}

/**
 * The multivariant playlist for a data-mode token: video variants whose BANDWIDTH is at most `dm`
 * (bit/s), plus every audio-only variant, which is the floor and is kept even above the ceiling
 * (the player's meter shows what is actually spent). With no video variant under the ceiling the
 * audio-only variants are listed first, so players start on them. Media groups that no kept
 * variant references are dropped. A ladder with neither an audio-only variant nor a video variant
 * under the ceiling keeps its lowest variant rather than serve an unplayable playlist.
 *
 * Input is `synthesizeMultivariant`'s output, before rewriting; kept lines keep their order.
 */
export function filterForDataMode(multivariant: string, dm: number): string {
  const lines = multivariant.split(/\r?\n/).map((l) => l.trim());
  const header: string[] = [];
  const media: { line: string; key: string | undefined }[] = [];
  const variants: { inf: string; attrs: AttributeList; uri: string; bandwidth: number; audioOnly: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      let j = i + 1;
      while (j < lines.length && (lines[j] === "" || lines[j]?.startsWith("#"))) j++;
      const uri = lines[j];
      if (uri === undefined) continue;
      i = j;
      const attrs = parseAttributes(line.slice(18));
      const codecs = (unquote(attr(attrs, "CODECS")) ?? "").split(",").map((s) => s.trim());
      variants.push({
        inf: line,
        attrs,
        uri,
        bandwidth: Number(attr(attrs, "BANDWIDTH")) || 0,
        audioOnly: attr(attrs, "RESOLUTION") === undefined && codecs.every((cd) => AUDIO_CODEC.test(cd)),
      });
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributes(line.slice(13));
      const type = attr(attrs, "TYPE");
      const group = attr(attrs, "GROUP-ID");
      // TYPE values are the STREAM-INF attribute names that reference the group (AUDIO, VIDEO, …).
      media.push({ line, key: type && group ? `${type}|${group}` : undefined });
    } else if (line !== "") header.push(line);
  }

  const fits = (v: (typeof variants)[number]) => v.audioOnly || v.bandwidth <= dm;
  const anyVideoFits = variants.some((v) => !v.audioOnly && v.bandwidth <= dm);
  let kept = anyVideoFits ? variants.filter(fits) : variants.filter((v) => v.audioOnly);
  if (kept.length === 0) {
    const lowest = [...variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
    kept = lowest ? [lowest] : [];
  }

  const referenced = new Set<string>();
  for (const v of kept)
    for (const g of GROUP_ATTRS) {
      const value = attr(v.attrs, g);
      if (value && value !== "NONE") referenced.add(`${g}|${value}`);
    }
  const keptMedia = media.filter((m) => m.key === undefined || referenced.has(m.key));

  const out = [...header, "", ...keptMedia.map((m) => m.line), ""];
  for (const v of kept) out.push(v.inf, v.uri, "");
  return out.join("\n");
}
