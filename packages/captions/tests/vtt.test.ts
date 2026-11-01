// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  completeSegments,
  escapeCueText,
  LIVE_WINDOW_SEGMENTS,
  liveSubtitlePlaylist,
  liveVttSegment,
  parseVtt,
  parseVttTimestamp,
  SEGMENT_MS,
  segmentIndexAt,
  timestampMap,
  toVodCues,
  vodVttDocument,
  vttTimestamp,
  type LiveTrack,
} from "../src/vtt.ts";

const W0 = Date.parse("2026-11-01T11:59:50.000Z");
const ANCHOR = Date.parse("2026-11-01T12:00:00.000Z");
const track = (throughMs: number): LiveTrack => ({ language: "en", w0Ms: W0, anchorMs: ANCHOR, throughMs });

describe("timestamps", () => {
  test("format and parse round-trip, hours past 99 included", () => {
    expect(vttTimestamp(0)).toBe("00:00:00.000");
    expect(vttTimestamp(3_723_004)).toBe("01:02:03.004");
    expect(vttTimestamp(360_000_000)).toBe("100:00:00.000");
    expect(vttTimestamp(-5)).toBe("00:00:00.000");
    for (const ms of [0, 1, 999, 61_001, 3_723_004, 360_000_000]) expect(parseVttTimestamp(vttTimestamp(ms))).toBe(ms);
    expect(parseVttTimestamp("01:02.500")).toBe(62_500);
    expect(parseVttTimestamp("1:2:3")).toBeNull();
    expect(parseVttTimestamp("00:61:00.000")).toBeNull();
  });

  test("cue text is one escaped line, so it cannot end the cue or open a tag", () => {
    expect(escapeCueText("a <b>bold</b> & --> claim\nnext")).toBe("a &lt;b&gt;bold&lt;/b&gt; &amp; --&gt; claim next");
  });
});

describe("live segmenter", () => {
  test("only complete segments are listed, within the window", () => {
    expect(completeSegments(track(ANCHOR + 2_999))).toBeNull();
    expect(completeSegments(track(ANCHOR + 3_000))).toEqual([0, 0]);
    expect(completeSegments(track(ANCHOR + 7_000))).toEqual([0, 1]);
    const far = track(ANCHOR + (LIVE_WINDOW_SEGMENTS + 10) * SEGMENT_MS);
    expect(completeSegments(far)).toEqual([10, LIVE_WINDOW_SEGMENTS + 9]);
    expect(segmentIndexAt(track(0), ANCHOR + 6_500)).toBe(2);
  });

  test("the playlist carries a PDT per segment and the media sequence of the first", () => {
    const text = liveSubtitlePlaylist(track(ANCHOR + 9_100), (n) => `${n}.vtt?t=x`);
    expect(text).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-TARGETDURATION:3",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:00.000Z",
        "#EXTINF:3.000,",
        "0.vtt?t=x",
        "#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:03.000Z",
        "#EXTINF:3.000,",
        "1.vtt?t=x",
        "#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:06.000Z",
        "#EXTINF:3.000,",
        "2.vtt?t=x",
        "",
      ].join("\n"),
    );
    // Nothing transcribed yet: a valid playlist with no segments.
    expect(liveSubtitlePlaylist(track(ANCHOR), String)).not.toContain("#EXTINF");
  });

  test("a segment lists overlapping cues timed from W0 on the source clock (X-TIMESTAMP-MAP)", () => {
    expect(timestampMap()).toBe("X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000");
    const cues = [
      { startMs: ANCHOR + 500, endMs: ANCHOR + 2_000, text: "first" },
      { startMs: ANCHOR + 2_500, endMs: ANCHOR + 3_400, text: "crosses" },
      { startMs: ANCHOR + 4_000, endMs: ANCHOR + 5_000, text: "later" },
    ];
    const seg0 = liveVttSegment(track(ANCHOR + 6_000), 0, cues);
    expect(seg0).toBe(
      [
        "WEBVTT",
        "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000",
        "",
        "00:00:10.500 --> 00:00:12.000",
        "first",
        "",
        "00:00:12.500 --> 00:00:13.400",
        "crosses",
        "",
        "",
      ].join("\n"),
    );
    const seg1 = liveVttSegment(track(ANCHOR + 6_000), 1, cues);
    expect(seg1).toContain("crosses");
    expect(seg1).toContain("later");
    expect(seg1).not.toContain("first");
    // Silence: a valid, empty segment.
    expect(liveVttSegment(track(ANCHOR + 12_000), 3, cues)).toBe(
      "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n",
    );
  });

  test("unicode and empty text", () => {
    const seg = liveVttSegment(track(ANCHOR + 3_000), 0, [
      { startMs: ANCHOR, endMs: ANCHOR + 1_000, text: "¿Qué? 你好" },
    ]);
    expect(seg).toContain("¿Qué? 你好");
  });
});

describe("VOD track", () => {
  test("live cues move onto the VOD clock; ones before time 0 are clipped or dropped", () => {
    const vod = toVodCues(
      [
        { startMs: ANCHOR - 2_000, endMs: ANCHOR - 1_000, text: "before" },
        { startMs: ANCHOR - 500, endMs: ANCHOR + 500, text: "straddles" },
        { startMs: ANCHOR + 1_000, endMs: ANCHOR + 2_000, text: "in" },
      ],
      ANCHOR,
    );
    expect(vod).toEqual([
      { startMs: 0, endMs: 500, text: "straddles" },
      { startMs: 1_000, endMs: 2_000, text: "in" },
    ]);
  });

  test("document round-trips through the parser, origin note included", () => {
    const track = {
      originMs: ANCHOR,
      cues: [
        { startMs: 0, endMs: 1_200, text: "Hello <world> & you" },
        { startMs: 3_723_004, endMs: 3_724_000, text: "ñandú 🙂" },
      ],
    };
    const doc = vodVttDocument(track);
    expect(doc.startsWith("WEBVTT\n\nNOTE commonair-origin 2026-11-01T12:00:00.000Z\n\n")).toBe(true);
    expect(parseVtt(doc)).toEqual(track);
    expect(parseVtt(vodVttDocument({ originMs: null, cues: [] }))).toEqual({ originMs: null, cues: [] });
  });

  test("parses other simple WebVTT and refuses non-WebVTT", () => {
    const doc =
      "﻿WEBVTT - title\r\n\r\nNOTE hi\r\n\r\nid-1\r\n00:01.000 --> 00:02.000 align:start\r\nline one\r\nline two\r\n";
    expect(parseVtt(doc)).toEqual({
      originMs: null,
      cues: [{ startMs: 1000, endMs: 2000, text: "line one line two" }],
    });
    expect(parseVtt("not vtt")).toBeNull();
  });
});
