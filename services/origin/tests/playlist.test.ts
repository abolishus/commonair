// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  AUDIO_ONLY_BANDWIDTH,
  mediaSegmentUris,
  parseAttributes,
  rewritePlaylist,
  rewriteUri,
  synthesizeMultivariant,
  type RewriteContext,
} from "../src/playlist.ts";
import { MEDIA, MULTIVARIANT, SESSION, rendition480, rendition720, renditionAudio } from "./fixtures.ts";

const TOKEN = "eyJ2IjoxfQ.c2ln";
const root = "live/alice";
const origin: RewriteContext = { dir: root, root, target: { kind: "relative", token: TOKEN } };
const relay: RewriteContext = {
  dir: root,
  root,
  target: { kind: "absolute", base: "https://relay.example.net/hls", token: TOKEN },
};
const cdn: RewriteContext = {
  dir: root,
  root,
  target: { kind: "absolute", base: "https://cdn.example.net", token: TOKEN },
};
const pull: RewriteContext = { dir: root, root, target: { kind: "relative" } };

/** Every URI in a playlist: plain URI lines and URI="…" attributes. */
function uris(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("#")) for (const m of line.matchAll(/(?:^|[:,])URI="([^"]*)"/g)) out.push(m[1] ?? "");
    else out.push(line);
  }
  return out;
}
const tokenCount = (uri: string) => [...new URL(uri, "https://x/").searchParams.getAll("t")].length;

describe("rewritePlaylist", () => {
  test("media playlist: every URI (map, segments, parts, preload hint, rendition report) carries the token once", () => {
    const out = rewritePlaylist(MEDIA, origin);
    const all = uris(out);
    expect(all).toHaveLength(8);
    for (const u of all) {
      expect(tokenCount(u)).toBe(1);
      expect(u).not.toContain("session=");
    }
    expect(out).toContain(`#EXT-X-MAP:URI="54dd20fd99ec_video1_init.mp4?t=${TOKEN}"`);
    expect(out).toContain(`\n54dd20fd99ec_video1_seg33.mp4?t=${TOKEN}\n`);
    expect(out).toContain(`#EXT-X-PRELOAD-HINT:TYPE=PART,URI="54dd20fd99ec_video1_part157.mp4?t=${TOKEN}"`);
    expect(out).toContain(`#EXT-X-RENDITION-REPORT:URI="audio2_stream.m3u8?t=${TOKEN}",LAST-MSN=35,LAST-PART=1`);
    expect(out).toContain(`URI="54dd20fd99ec_video1_part155.mp4?t=${TOKEN}",INDEPENDENT=YES`);
  });

  test("non-URI lines are untouched", () => {
    const out = rewritePlaylist(MEDIA, origin).split("\n");
    const inp = MEDIA.split("\n");
    expect(out).toHaveLength(inp.length);
    const untouched = (lines: string[]) =>
      lines.filter((l) => !l.includes("URI=") && !l.endsWith(".mp4") && !l.includes("?"));
    expect(untouched(out)).toEqual(untouched(inp));
    expect(inp.filter((l) => l.includes(SESSION))).toHaveLength(8);
  });

  test("rewriting twice still yields exactly one token (no double append)", () => {
    const once = rewritePlaylist(MEDIA, origin);
    const twice = rewritePlaylist(once, origin);
    expect(twice).toBe(once);
    for (const u of uris(twice)) expect(tokenCount(u)).toBe(1);
  });

  test("an existing foreign t= is replaced, other query params preserved", () => {
    expect(rewriteUri("seg1.mp4?t=old&x=1&session=s", origin)).toBe(`seg1.mp4?x=1&t=${TOKEN}`);
  });

  test("relay base: absolute <relay>/hls/live/<slug>/… URIs", () => {
    const out = rewritePlaylist(MULTIVARIANT, relay);
    expect(uris(out)).toEqual([
      `https://relay.example.net/hls/live/alice/audio2_stream.m3u8?t=${TOKEN}`,
      `https://relay.example.net/hls/live/alice/video1_stream.m3u8?t=${TOKEN}`,
    ]);
  });

  test("CDN base: CDN_BASE_URL/live/<slug>/… URIs", () => {
    const out = rewritePlaylist(MEDIA, { ...cdn, dir: "live/alice/720p" });
    expect(uris(out)[0]).toBe(`https://cdn.example.net/live/alice/720p/54dd20fd99ec_video1_init.mp4?t=${TOKEN}`);
  });

  test("relay/CDN pulls: relative URIs, no token, no session", () => {
    const out = rewritePlaylist(MEDIA, pull);
    for (const u of uris(out)) expect(u).toMatch(/^[A-Za-z0-9_]+\.(mp4|m3u8)$/);
  });

  test("synthesized multivariant URIs into rendition dirs stay relative from the channel root", () => {
    expect(rewriteUri("720p/video1_stream.m3u8", origin)).toBe(`720p/video1_stream.m3u8?t=${TOKEN}`);
    // From inside a rendition dir, a URI back to the root resolves with ../
    expect(rewriteUri("../audio2_stream.m3u8", { ...origin, dir: "live/alice/720p" })).toBe(
      `../audio2_stream.m3u8?t=${TOKEN}`,
    );
    expect(rewriteUri("/live/alice/480p/x.m3u8", { ...origin, dir: "live/alice/720p" })).toBe(
      `../480p/x.m3u8?t=${TOKEN}`,
    );
  });

  test("URIs escaping the channel or pointing elsewhere never get a token", () => {
    expect(rewriteUri("../bob/index.m3u8", origin)).toBe("../bob/index.m3u8");
    expect(rewriteUri("../../../etc/passwd", origin)).toBe("../../../etc/passwd");
    expect(rewriteUri("https://evil.example/seg.mp4", origin)).toBe("https://evil.example/seg.mp4");
    expect(rewriteUri("//evil.example/seg.mp4", origin)).toBe("//evil.example/seg.mp4");
  });

  test("SERVER-URI is not mistaken for URI", () => {
    const line = '#EXT-X-CONTENT-STEERING:SERVER-URI="steer.json",PATHWAY-ID="a"';
    expect(rewritePlaylist(line, origin).trim()).toBe(line);
  });

  test("CRLF input is normalized and a single trailing newline kept", () => {
    const out = rewritePlaylist("#EXTM3U\r\n#EXTINF:1,\r\nseg.mp4\r\n\r\n", origin);
    expect(out).toBe(`#EXTM3U\n#EXTINF:1,\nseg.mp4?t=${TOKEN}\n\n`);
  });
});

describe("mediaSegmentUris", () => {
  test("lists full segments only, without query", () => {
    expect(mediaSegmentUris(MEDIA)).toEqual([
      "54dd20fd99ec_video1_seg33.mp4",
      "54dd20fd99ec_video1_seg34.mp4",
      "54dd20fd99ec_video1_seg35.mp4",
    ]);
  });
});

describe("parseAttributes", () => {
  test("quoted values may contain commas and equals signs", () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.42c01e,mp4a.40.2",URI="a=b.m3u8",X=Y')).toEqual([
      ["BANDWIDTH", "1"],
      ["CODECS", '"avc1.42c01e,mp4a.40.2"'],
      ["URI", '"a=b.m3u8"'],
      ["X", "Y"],
    ]);
  });
});

describe("synthesizeMultivariant", () => {
  const ladder = synthesizeMultivariant([
    { rendition: "source", text: MULTIVARIANT },
    { rendition: "720p", text: rendition720 },
    { rendition: "480p", text: rendition480 },
  ]);
  const lines = ladder.split("\n");
  const variants = lines.flatMap((l, i) => (l.startsWith("#EXT-X-STREAM-INF:") ? [[l, lines[i + 1] ?? ""]] : []));

  test("one variant per rendition plus a derived audio-only variant, highest bandwidth first", () => {
    expect(variants.map(([, u]) => u?.split("?")[0])).toEqual([
      "video1_stream.m3u8",
      "720p/video1_stream.m3u8",
      "480p/video1_stream.m3u8",
      "audio2_stream.m3u8",
    ]);
    expect(variants[3]?.[0]).toBe(`#EXT-X-STREAM-INF:BANDWIDTH=${AUDIO_ONLY_BANDWIDTH},CODECS="mp4a.40.2"`);
  });

  test("BANDWIDTH, RESOLUTION, CODECS and FRAME-RATE are taken from each rendition's playlist", () => {
    expect(variants[1]?.[0]).toContain("BANDWIDTH=1400000");
    expect(variants[1]?.[0]).toContain("RESOLUTION=1280x720");
    expect(variants[1]?.[0]).toContain('CODECS="avc1.64001f,mp4a.40.2"');
    expect(variants[1]?.[0]).toContain("FRAME-RATE=30.000");
    expect(variants[2]?.[0]).toContain("RESOLUTION=854x480");
  });

  test("audio groups are namespaced per rendition and referenced consistently", () => {
    expect(ladder).toContain('GROUP-ID="source-audio"');
    expect(ladder).toContain('GROUP-ID="720p-audio"');
    expect(ladder).toContain('URI="720p/audio2_stream.m3u8?session=aaaa"');
    expect(variants[0]?.[0]).toContain('AUDIO="source-audio"');
    expect(variants[1]?.[0]).toContain('AUDIO="720p-audio"');
    expect(variants[2]?.[0]).not.toContain("AUDIO=");
  });

  test("version is the max of the inputs, independent segments preserved", () => {
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("#EXT-X-VERSION:10");
    expect(ladder).toContain("#EXT-X-INDEPENDENT-SEGMENTS");
  });

  test("an explicit audio rendition replaces the derived one", () => {
    const withAudio = synthesizeMultivariant([
      { rendition: "source", text: MULTIVARIANT },
      { rendition: "audio", text: renditionAudio },
    ]);
    const infs = withAudio.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
    expect(infs).toHaveLength(2);
    expect(withAudio).toContain("audio/audio1_stream.m3u8");
    expect(withAudio).not.toContain(`BANDWIDTH=${AUDIO_ONLY_BANDWIDTH}`);
  });

  test("after rewriting, every synthesized URI carries the token exactly once and no session", () => {
    const out = rewritePlaylist(ladder, origin);
    const all = uris(out);
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const u of all) {
      expect(tokenCount(u)).toBe(1);
      expect(u).not.toContain("session=");
    }
  });
});
