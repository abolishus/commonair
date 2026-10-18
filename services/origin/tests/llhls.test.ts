// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  advancePartLimit,
  blockingTimeoutMs,
  checkDirectives,
  maxPartsPerSegment,
  playlistState,
  type PlaylistState,
} from "../src/llhls.ts";
import { MEDIA } from "./fixtures.ts";

describe("playlistState", () => {
  test("MediaMTX LL-HLS playlist ending in parts of an unfinished segment", () => {
    // MEDIA: sequence 33, three full segments (33–35), then a preload hint and no trailing parts.
    expect(playlistState(MEDIA)).toEqual({
      lastMsn: 35,
      lastFullMsn: 35,
      lastPart: 1,
      targetDuration: 1,
      partTarget: 0.2,
    });
    const building = `${MEDIA}#EXT-X-PART:DURATION=0.2,URI="a_part160.mp4"\n#EXT-X-PART:DURATION=0.2,URI="a_part161.mp4"\n`;
    expect(playlistState(building)).toMatchObject({ lastMsn: 36, lastFullMsn: 35, lastPart: 1 });
  });

  test("delta updates count skipped segments", () => {
    const delta = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-SKIP:SKIPPED-SEGMENTS=4\n#EXTINF:2,\na.mp4\n";
    expect(playlistState(delta)).toEqual({ lastMsn: 14, lastFullMsn: 14, lastPart: -1, targetDuration: 2, partTarget: undefined });
  });

  test("multivariant and garbage have no state", () => {
    expect(playlistState("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n")).toBeNull();
    expect(playlistState("")).toBeNull();
  });
});

describe("checkDirectives", () => {
  const s: PlaylistState = { lastMsn: 36, lastFullMsn: 35, lastPart: 1, targetDuration: 1, partTarget: 0.2 };

  test("limits derived from the playlist", () => {
    expect(maxPartsPerSegment(s)).toBe(8); // segments last < 1.5 s at 0.2 s parts
    expect(advancePartLimit(s)).toBe(15); // 3 / 0.2
    expect(advancePartLimit({ ...s, partTarget: 1.5 })).toBe(3);
  });

  test.each([
    [{}, "ok"],
    [{ msn: 10 }, "ok"], // the past answers immediately
    [{ msn: 36, part: 2 }, "ok"], // the next part
    [{ msn: 37, part: 0 }, "ok"], // the first part of the next segment
    [{ msn: 37 }, "ok"],
    [{ msn: 38 }, "msn_too_far"], // more than two past the last complete segment
    [{ msn: 36, part: 8 }, "part_out_of_range"],
    [{ msn: 37, part: 7 }, "ok"],
  ] as const)("%o → %s", (d, verdict) => {
    expect(checkDirectives(d, s)).toBe(verdict);
  });

  test("the advance part limit binds when parts are long relative to segments", () => {
    const long: PlaylistState = { lastMsn: 5, lastFullMsn: 4, lastPart: 0, targetDuration: 6, partTarget: 1 };
    expect(checkDirectives({ msn: 5, part: 3 }, long)).toBe("ok");
    expect(checkDirectives({ msn: 5, part: 4 }, long)).toBe("beyond_advance_limit");
  });

  test("part directives on a playlist without parts are refused", () => {
    expect(checkDirectives({ msn: 3, part: 0 }, { ...s, partTarget: undefined })).toBe("part_unsupported");
  });
});

test("blocking timeout is 3 × target duration, bounded", () => {
  const base = { lastMsn: 1, lastFullMsn: 1, lastPart: 0 };
  expect(blockingTimeoutMs({ ...base, targetDuration: 1 })).toBe(3_000);
  expect(blockingTimeoutMs({ ...base, targetDuration: 0 })).toBe(1_500);
  expect(blockingTimeoutMs({ ...base, targetDuration: 10 })).toBe(15_000);
  expect(blockingTimeoutMs(undefined)).toBe(6_000);
});
