// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  findLiveWindow,
  findWindow,
  parsePlaylist,
  renderPlaylist,
  totalDuration,
  type PlaylistSegment,
} from "../src/vod/playlist.ts";

// Exactly what ffmpeg 7–9 writes for `-hls_segment_type fmp4 -hls_flags program_date_time`.
const FFMPEG_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init_r1.mp4"
#EXTINF:4.024033,
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T17:24:03.901-0400
r1_000000.m4s
#EXTINF:4.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T17:24:07.925-0400
r1_000001.m4s
#EXTINF:2.566667,
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T17:24:11.925-0400
r1_000002.m4s
#EXT-X-ENDLIST
`;

const seg = (uri: string, startIso: string, d: number, map: string): PlaylistSegment => ({
  uri,
  durationSeconds: d,
  startedAt: new Date(startIso),
  map,
});

describe("parsePlaylist", () => {
  test("reads ffmpeg's fMP4 playlist (tags in either order around EXTINF)", () => {
    const p = parsePlaylist(FFMPEG_PLAYLIST);
    expect(p.ended).toBe(true);
    expect(p.segments.map((s) => s.uri)).toEqual(["r1_000000.m4s", "r1_000001.m4s", "r1_000002.m4s"]);
    expect(p.segments[0]?.map).toBe("init_r1.mp4");
    expect(p.segments[0]?.durationSeconds).toBeCloseTo(4.024033);
    expect(p.segments[1]?.startedAt?.toISOString()).toBe("2026-10-18T21:24:07.925Z");
    expect(totalDuration(p.segments)).toBeCloseTo(10.591, 3);
  });

  test("a live playlist without ENDLIST is not ended", () => {
    expect(parsePlaylist(FFMPEG_PLAYLIST.replace("#EXT-X-ENDLIST\n", "")).ended).toBe(false);
    expect(parsePlaylist("").segments).toEqual([]);
  });
});

describe("renderPlaylist", () => {
  const run1 = [
    seg("r1_0.m4s", "2026-10-18T20:00:00Z", 4, "init_r1.mp4"),
    seg("r1_1.m4s", "2026-10-18T20:00:04Z", 4, "init_r1.mp4"),
  ];
  const run2 = [seg("r2_0.m4s", "2026-10-18T20:00:30Z", 3.5, "init_r2.mp4")];

  test("joins recorder runs with a discontinuity and a new map", () => {
    const text = renderPlaylist([...run1, ...run2], { ended: false });
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(text).not.toContain("#EXT-X-ENDLIST");
    expect(text.match(/#EXT-X-MAP/g)?.length).toBe(2);
    expect(text.match(/#EXT-X-DISCONTINUITY/g)?.length).toBe(1);
    expect(text.indexOf("#EXT-X-DISCONTINUITY")).toBeLessThan(text.indexOf('URI="init_r2.mp4"'));
  });

  test("final playlist ends with ENDLIST and round-trips", () => {
    const text = renderPlaylist([...run1, ...run2], { ended: true });
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
    const back = parsePlaylist(text);
    expect(back.ended).toBe(true);
    expect(back.segments).toEqual([...run1, ...run2]);
    expect(text).toContain("#EXT-X-TARGETDURATION:4");
  });
});

describe("findWindow", () => {
  const segs = [
    seg("r1_0.m4s", "2026-10-18T20:00:00Z", 4, "init_r1.mp4"),
    seg("r1_1.m4s", "2026-10-18T20:00:04Z", 4, "init_r1.mp4"),
    seg("r1_2.m4s", "2026-10-18T20:00:08Z", 4, "init_r1.mp4"),
    seg("r2_0.m4s", "2026-10-18T20:00:20Z", 4, "init_r2.mp4"),
  ];

  test("picks the overlapping segments and the offset into the first", () => {
    const w = findWindow(segs, new Date("2026-10-18T20:00:05Z"), 5);
    expect(w?.segments.map((s) => s.uri)).toEqual(["r1_1.m4s", "r1_2.m4s"]);
    expect(w?.offsetSeconds).toBe(1);
    expect(w?.durationSeconds).toBe(5);
  });

  test("at the live edge the window is shortened to what exists", () => {
    const w = findWindow(segs, new Date("2026-10-18T20:00:10Z"), 30);
    // Stays within run 1 (the run containing the start); run 1 ends at 20:00:12.
    expect(w?.segments.map((s) => s.uri)).toEqual(["r1_2.m4s"]);
    expect(w?.durationSeconds).toBe(2);
  });

  test("a window starting in a gap begins at the next segment", () => {
    const w = findWindow(segs, new Date("2026-10-18T20:00:15Z"), 8);
    expect(w?.segments.map((s) => s.uri)).toEqual(["r2_0.m4s"]);
    expect(w?.offsetSeconds).toBe(0);
    expect(w?.durationSeconds).toBe(3);
  });

  test("outside the recording there is no window", () => {
    expect(findWindow(segs, new Date("2026-10-18T19:00:00Z"), 10)).toBeNull();
    expect(findWindow(segs, new Date("2026-10-18T21:00:00Z"), 10)).toBeNull();
    expect(findWindow([], new Date(), 10)).toBeNull();
  });
});

describe("findLiveWindow", () => {
  const buffer = [
    seg("r1_0.m4s", "2026-10-18T20:00:03Z", 6, "init_r1.mp4"),
    seg("r1_1.m4s", "2026-10-18T20:00:09Z", 4, "init_r1.mp4"),
    seg("r1_2.m4s", "2026-10-18T20:00:13Z", 4, "init_r1.mp4"),
  ];
  const recordingStart = new Date("2026-10-18T20:00:03Z");
  const at = (s: string) => new Date(`2026-10-18T20:00:${s}Z`);

  test("nothing recorded yet is pending, not missing", () => {
    expect(findLiveWindow([], null, at("00"), 5)).toEqual({ status: "pending" });
    expect(findLiveWindow([], recordingStart, at("00"), 5)).toEqual({ status: "pending" });
  });

  test("a window ending past the last finished segment is pending", () => {
    expect(findLiveWindow(buffer, recordingStart, at("14"), 5)).toEqual({ status: "pending" });
    // Ends exactly at the buffered edge: available.
    expect(findLiveWindow(buffer, recordingStart, at("12"), 5).status).toBe("found");
  });

  test("a window inside the buffer is found", () => {
    const r = findLiveWindow(buffer, recordingStart, at("10"), 5);
    if (r.status !== "found") throw new Error(r.status);
    expect(r.window.segments.map((s) => s.uri)).toEqual(["r1_1.m4s", "r1_2.m4s"]);
    expect(r.window.offsetSeconds).toBe(1);
    expect(r.window.durationSeconds).toBe(5);
  });

  test("a window before the recording began moves to its start, at full length", () => {
    const r = findLiveWindow(buffer, recordingStart, at("00"), 5);
    if (r.status !== "found") throw new Error(r.status);
    expect(r.window.segments.map((s) => s.uri)).toEqual(["r1_0.m4s"]);
    expect(r.window.offsetSeconds).toBe(0);
    expect(r.window.durationSeconds).toBe(5);
    // Moved, it must still be buffered in full.
    expect(findLiveWindow(buffer.slice(0, 1), recordingStart, at("00"), 7)).toEqual({ status: "pending" });
  });

  test("a window already pruned from the buffer is outside", () => {
    // The recording began at :03 but only :13 onwards is still on disk.
    expect(findLiveWindow(buffer.slice(2), recordingStart, at("04"), 4)).toEqual({ status: "outside" });
  });
});
