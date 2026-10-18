// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  classify,
  contentTypeFor,
  directivesQuery,
  parseHlsDirectives,
  parseMediaPath,
  rawPathOf,
} from "../src/paths.ts";

describe("parseMediaPath", () => {
  test("source multivariant", () => {
    expect(parseMediaPath("/hls/live/alice_01/index.m3u8")).toEqual({
      route: "hls",
      slug: "alice_01",
      rendition: undefined,
      file: "index.m3u8",
      kind: "playlist",
      upstreamPath: "live/alice_01",
      channelPath: "live/alice_01",
      isMultivariant: true,
    });
  });

  test("rendition media files map to the rendition's MediaMTX path but the channel's token path", () => {
    const r = parseMediaPath("/relay-pull/live/alice/720p/54dd_video1_seg3.mp4");
    expect(r).toMatchObject({
      route: "relayPull",
      rendition: "720p",
      upstreamPath: "live/alice/720p",
      channelPath: "live/alice",
      kind: "segment",
      isMultivariant: false,
    });
    expect(parseMediaPath("/cdn/live/alice/720p/index.m3u8")).toMatchObject({ route: "cdn", isMultivariant: false });
  });

  test("kinds", () => {
    expect(classify("x_video1_part12.mp4")).toBe("part");
    expect(classify("x_video1_seg12.mp4")).toBe("segment");
    expect(classify("x_video1_init.mp4")).toBe("segment");
    expect(classify("seg.ts")).toBe("segment");
    expect(classify("video1_stream.m3u8")).toBe("playlist");
  });

  test.each([
    "/hls/live/alice/../bob/index.m3u8",
    "/hls/live/alice/%2e%2e/index.m3u8",
    "/hls/live/alice/./index.m3u8",
    "/hls/live//index.m3u8",
    "/hls/live/alice//index.m3u8",
    "/hls/live/Alice/index.m3u8",
    "/hls/live/al/index.m3u8",
    "/hls/live/alice/index.php",
    "/hls/live/alice/index.m3u8.bak",
    "/hls/live/alice/.hidden.mp4",
    "/hls/live/alice/1440p/index.m3u8",
    "/hls/live/alice/source/index.m3u8",
    "/hls/live/alice/720p/deep/index.m3u8",
    "/hls/vod/alice/index.m3u8",
    "/hls/live/alice",
    "/hls/live/alice/seg\\1.mp4",
    "/hls/live/alice/se g.mp4",
    "/other/live/alice/index.m3u8",
    `/hls/live/alice/${"a".repeat(300)}.mp4`,
  ])("rejects %s", (p) => {
    expect(parseMediaPath(p)).toBeNull();
  });
});

describe("rawPathOf", () => {
  test("keeps dot segments and encodings that URL() would normalize away", () => {
    expect(rawPathOf("http://h:1/hls/live/a/../b/x.m3u8?t=1")).toBe("/hls/live/a/../b/x.m3u8");
    expect(rawPathOf("http://h/hls/%2e%2e/x#f")).toBe("/hls/%2e%2e/x");
    expect(rawPathOf("http://h")).toBe("/");
  });
});

describe("LL-HLS directives", () => {
  const p = (q: string) => parseHlsDirectives(new URLSearchParams(q));
  test("valid combinations", () => {
    expect(p("")).toEqual({});
    expect(p("_HLS_msn=12&_HLS_part=3&t=x")).toEqual({ msn: 12, part: 3 });
    expect(p("_HLS_skip=YES")).toEqual({ skip: "YES" });
    expect(directivesQuery({ msn: 12, part: 3, skip: "v2" })).toBe("_HLS_msn=12&_HLS_part=3&_HLS_skip=v2");
  });
  test.each(["_HLS_msn=-1", "_HLS_msn=1e3", "_HLS_part=1", "_HLS_msn=1&_HLS_part=x", "_HLS_skip=no"])(
    "rejects %s",
    (q) => {
      expect(p(q)).toBeNull();
    },
  );
});

test("content types", () => {
  expect(contentTypeFor("index.m3u8")).toBe("application/vnd.apple.mpegurl");
  expect(contentTypeFor("a_seg1.mp4")).toBe("video/mp4");
  expect(contentTypeFor("a.ts")).toBe("video/mp2t");
});
