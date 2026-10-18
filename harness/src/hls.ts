// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Just enough HLS playlist parsing (RFC 8216 + LL-HLS) for the HTTP-only viewer. */

export interface Variant {
  uri: string;
  bandwidth: number;
  resolution: { width: number; height: number } | null;
  codecs: string | null;
  audioGroup: string | null;
}

export interface Rendition {
  type: string;
  groupId: string;
  name: string;
  uri: string | null;
  isDefault: boolean;
}

export interface MultivariantPlaylist {
  kind: "multivariant";
  variants: Variant[];
  renditions: Rendition[];
}

export interface Segment {
  uri: string;
  duration: number;
  sequence: number;
  /** Epoch ms of the segment's first sample (EXT-X-PROGRAM-DATE-TIME, carried forward). */
  programDateTime: number | null;
  /** Init section that applies to this segment. */
  map: string | null;
}

export interface MediaPlaylist {
  kind: "media";
  targetDuration: number;
  mediaSequence: number;
  partTarget: number | null;
  segments: Segment[];
  ended: boolean;
  /** EXT-X-SKIP: segments omitted from the start of a delta playlist. */
  skipped: number;
}

export type Playlist = MultivariantPlaylist | MediaPlaylist;

/** Parse an attribute list (`A=1,B="x,y",C=0x1F`). */
export function parseAttributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const m of text.matchAll(re)) {
    const key = m[1];
    const raw = m[2] ?? "";
    if (key) out[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

function tagValue(line: string): string {
  const i = line.indexOf(":");
  return i < 0 ? "" : line.slice(i + 1);
}

export function parsePlaylist(body: string): Playlist {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("not an HLS playlist (missing #EXTM3U)");
  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) return parseMultivariant(lines);
  return parseMedia(lines);
}

function parseMultivariant(lines: string[]): MultivariantPlaylist {
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  let pending: Record<string, string> | null = null;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseAttributes(tagValue(line));
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(tagValue(line));
      renditions.push({
        type: a.TYPE ?? "",
        groupId: a["GROUP-ID"] ?? "",
        name: a.NAME ?? "",
        uri: a.URI ?? null,
        isDefault: a.DEFAULT === "YES",
      });
    } else if (!line.startsWith("#") && pending) {
      const res = /^(\d+)x(\d+)$/.exec(pending.RESOLUTION ?? "");
      variants.push({
        uri: line,
        bandwidth: Number(pending.BANDWIDTH ?? 0),
        resolution: res ? { width: Number(res[1]), height: Number(res[2]) } : null,
        codecs: pending.CODECS ?? null,
        audioGroup: pending.AUDIO ?? null,
      });
      pending = null;
    }
  }
  return { kind: "multivariant", variants, renditions };
}

function parseMedia(lines: string[]): MediaPlaylist {
  let targetDuration = 0;
  let mediaSequence = 0;
  let partTarget: number | null = null;
  let ended = false;
  let skipped = 0;
  let map: string | null = null;
  let nextDuration: number | null = null;
  let nextPdt: number | null = null;
  let carriedPdt: number | null = null;
  const segments: Segment[] = [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number(tagValue(line));
    else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSequence = Number(tagValue(line));
    else if (line.startsWith("#EXT-X-PART-INF:")) partTarget = Number(parseAttributes(tagValue(line))["PART-TARGET"]);
    else if (line.startsWith("#EXT-X-MAP:")) map = parseAttributes(tagValue(line)).URI ?? null;
    else if (line.startsWith("#EXT-X-SKIP:"))
      skipped = Number(parseAttributes(tagValue(line))["SKIPPED-SEGMENTS"] ?? 0);
    else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(tagValue(line));
      nextPdt = Number.isFinite(t) ? t : null;
    } else if (line.startsWith("#EXTINF:")) nextDuration = Number.parseFloat(tagValue(line));
    else if (line === "#EXT-X-ENDLIST") ended = true;
    else if (!line.startsWith("#") && nextDuration !== null) {
      const pdt: number | null = nextPdt ?? carriedPdt;
      segments.push({
        uri: line,
        duration: nextDuration,
        sequence: mediaSequence + skipped + segments.length,
        programDateTime: pdt,
        map,
      });
      carriedPdt = pdt === null ? null : pdt + nextDuration * 1000;
      nextDuration = null;
      nextPdt = null;
    }
  }
  return { kind: "media", targetDuration, mediaSequence, partTarget, segments, ended, skipped };
}

/** Resolve a playlist URI against the playlist URL, carrying the playback token if the URI lacks it. */
export function resolveUri(uri: string, base: string, tokenParam = "t"): string {
  const url = new URL(uri, base);
  const token = new URL(base).searchParams.get(tokenParam);
  if (token && !url.searchParams.has(tokenParam)) url.searchParams.set(tokenParam, token);
  return url.toString();
}

/** Replace the playback token in a URL (heartbeats refresh it before expiry). */
export function withToken(url: string, token: string, tokenParam = "t"): string {
  const u = new URL(url);
  if (!u.searchParams.has(tokenParam)) return url;
  u.searchParams.set(tokenParam, token);
  return u.toString();
}

/** Lowest-bandwidth variant (load tests keep viewer cost down). */
export function lowestVariant(p: MultivariantPlaylist): Variant | null {
  return [...p.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0] ?? null;
}
