// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `timeline-sync` steps 1, 3 and 4: the pure expectations in src/w1/timeline.ts. */
import { describe, expect, test } from "vite-plus/test";
import {
  expectedMediaTs,
  latencyMatches,
  MEDIA_TS_WINDOW_MS,
  atKey,
  replayOrderProblems,
  retentionDeletes,
  type ClampCase,
} from "../../src/w1/timeline.ts";

const receivedAt = new Date("2026-10-30T12:00:00.000Z");
const at = (ms: number) => new Date(receivedAt.getTime() + ms);
const base: ClampCase = {
  receivedAt,
  hint: null,
  playbackMode: "live",
  liveStartedAt: at(-3_600_000),
  latencySeconds: null,
};
const place = (over: Partial<ClampCase>) => expectedMediaTs({ ...base, ...over });

describe("expectedMediaTs (w1-selectors timeline-sync 1)", () => {
  test("now − 5 s is kept; now + 10 s is receive time; now − 120 s is receive − 60 s", () => {
    expect(place({ hint: at(-5_000) })).toEqual(at(-5_000));
    expect(place({ hint: at(10_000) })).toEqual(receivedAt);
    expect(place({ hint: at(-120_000) })).toEqual(at(-MEDIA_TS_WINDOW_MS));
  });

  test("window edges are inclusive", () => {
    expect(place({ hint: at(-60_000) })).toEqual(at(-60_000));
    expect(place({ hint: receivedAt })).toEqual(receivedAt);
  });

  test("before started_at is started_at", () => {
    expect(place({ hint: at(-40_000), liveStartedAt: at(-10_000) })).toEqual(at(-10_000));
  });

  test("dvr and offline are null", () => {
    expect(place({ hint: at(-5_000), playbackMode: "dvr" })).toBeNull();
    expect(place({ hint: at(-5_000), liveStartedAt: null })).toBeNull();
  });

  test("without a hint: receive − latency, receive time without a key, capped by the window", () => {
    expect(place({ latencySeconds: 3 })).toEqual(at(-3_000));
    expect(place({})).toEqual(receivedAt);
    expect(place({ latencySeconds: 120 })).toEqual(at(-60_000));
  });
});

describe("latencyMatches", () => {
  test("no key means receive time", () => {
    expect(latencyMatches(0, [null])).toBe(true);
    expect(latencyMatches(1_000, [null])).toBe(false);
  });

  test("any value chat could have used (millisecond rounding)", () => {
    expect(latencyMatches(2_500, [2.4, 2.5])).toBe(true);
    expect(latencyMatches(2_501, [2.5])).toBe(true);
    expect(latencyMatches(2_600, [2.4, 2.5])).toBe(false);
    expect(latencyMatches(60_000, [75])).toBe(true);
    expect(latencyMatches(0, [])).toBe(false);
  });
});

describe("replayOrderProblems", () => {
  const item = (id: string, atIso: string, mediaTs: string | null, createdAt = atIso) => ({
    id,
    at: atIso,
    mediaTs,
    createdAt,
    catchingUp: mediaTs === null,
  });

  test("rows in the same millisecond order by their microseconds, not id", () => {
    expect(
      replayOrderProblems([
        item("b", "2026-10-30T12:00:00.123100Z", null, "2026-10-30T12:00:00.123Z"),
        item("a", "2026-10-30T12:00:00.123900Z", null, "2026-10-30T12:00:00.123Z"),
      ]),
    ).toEqual([]);
    expect(
      replayOrderProblems([
        item("a", "2026-10-30T12:00:00.123900Z", null, "2026-10-30T12:00:00.123Z"),
        item("b", "2026-10-30T12:00:00.123100Z", null, "2026-10-30T12:00:00.123Z"),
      ]),
    ).toHaveLength(1);
  });

  test("atKey splits milliseconds from sub-millisecond digits", () => {
    expect(atKey("2026-10-30T12:00:00.123456Z")).toEqual([Date.parse("2026-10-30T12:00:00.123Z"), 456]);
    expect(atKey("2026-10-30T12:00:00Z")).toEqual([Date.parse("2026-10-30T12:00:00Z"), 0]);
  });

  test("media-time order with ties by id is fine", () => {
    expect(
      replayOrderProblems([
        item("a", "2026-10-30T12:00:00.000Z", "2026-10-30T12:00:00.000Z", "2026-10-30T12:00:05.000Z"),
        item("b", "2026-10-30T12:00:00.000Z", "2026-10-30T12:00:00.000Z"),
        item("c", "2026-10-30T12:00:01.000Z", null),
      ]),
    ).toEqual([]);
  });

  test("out of order, wrong `at` and a wrong flag are reported", () => {
    expect(
      replayOrderProblems([
        item("b", "2026-10-30T12:00:02.000Z", "2026-10-30T12:00:02.000Z"),
        item("a", "2026-10-30T12:00:01.000Z", "2026-10-30T12:00:01.000Z"),
      ]),
    ).toHaveLength(1);
    expect(
      replayOrderProblems([
        {
          id: "x",
          at: "2026-10-30T12:00:05.000Z",
          mediaTs: "2026-10-30T12:00:01.000Z",
          createdAt: "2026-10-30T12:00:05.000Z",
          catchingUp: false,
        },
      ]),
    ).toHaveLength(1);
    expect(
      replayOrderProblems([
        {
          id: "y",
          at: "2026-10-30T12:00:05.000Z",
          mediaTs: null,
          createdAt: "2026-10-30T12:00:05.000Z",
          catchingUp: false,
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("retentionDeletes (w1-selectors timeline-sync 4)", () => {
  test("offline chat goes at 30 days", () => {
    expect(retentionDeletes({ ageDays: 31, vodAlive: false, held: false })).toBe(true);
    expect(retentionDeletes({ ageDays: 29, vodAlive: false, held: false })).toBe(false);
  });

  test("VOD-attached chat stays until 60 days", () => {
    expect(retentionDeletes({ ageDays: 44, vodAlive: true, held: false })).toBe(false);
    expect(retentionDeletes({ ageDays: 60.5, vodAlive: true, held: false })).toBe(true);
  });

  test("a legal hold keeps everything", () => {
    expect(retentionDeletes({ ageDays: 90, vodAlive: false, held: true })).toBe(false);
  });

  test("operator settings", () => {
    expect(retentionDeletes({ ageDays: 8, vodAlive: false, held: false }, { retentionDays: 7, maxDays: 14 })).toBe(
      true,
    );
    expect(retentionDeletes({ ageDays: 8, vodAlive: true, held: false }, { retentionDays: 7, maxDays: 14 })).toBe(
      false,
    );
  });
});
