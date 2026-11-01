// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `replay-panel` step's pure expectations (`src/w2/replay.ts`): microsecond `at` order, the
 * reveal check over panel samples (early, missing, blocked, unknown, labels, before the first
 * frame), line placement over a recording, selectors and paths.
 */
import { describe, expect, it } from "vite-plus/test";
import {
  agedDays,
  atMicros,
  clipPath,
  lineOffsets,
  orderProblems,
  replaySel,
  revealProblems,
  vodPath,
  type ExpectedLine,
  type PanelSample,
} from "../../src/w2/replay.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const at = (sec: number, us = "000") => `${new Date(T0 + sec * 1000).toISOString().slice(0, -1)}${us}Z`;
const head = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const A: ExpectedLine = { id: "a", at: at(5), catchingUp: false };
const B: ExpectedLine = { id: "b", at: at(10), catchingUp: true };
const C: ExpectedLine = { id: "c", at: at(20), catchingUp: false };
const row = (e: ExpectedLine, label = e.catchingUp) => ({ id: e.id, at: e.at, catchingUpLabel: label });
const s = (sec: number | null, rows: PanelSample["rows"]): PanelSample => ({
  playhead: sec === null ? "" : head(sec),
  currentTime: sec ?? 0,
  rows,
});

describe("atMicros and order", () => {
  it("keeps microseconds", () => {
    expect(atMicros(at(0, "123"))).toBe(T0 * 1000 + 123);
    expect(atMicros(at(0, "124")) - atMicros(at(0, "123"))).toBe(1);
  });

  it("flags rows out of (at, id) order, equal at by id", () => {
    expect(orderProblems([row(A), row(B)])).toEqual([]);
    expect(orderProblems([row(B), row(A)])).toHaveLength(1);
    expect(
      orderProblems([
        { id: "x", at: at(1) },
        { id: "y", at: at(1) },
      ]),
    ).toEqual([]);
    expect(
      orderProblems([
        { id: "y", at: at(1) },
        { id: "x", at: at(1) },
      ]),
    ).toHaveLength(1);
    expect(
      orderProblems([
        { id: "y", at: at(1, "001") },
        { id: "x", at: at(1, "002") },
      ]),
    ).toEqual([]);
    expect(orderProblems([])).toEqual([]);
  });
});

describe("revealProblems", () => {
  const expected = [A, B, C];

  it("accepts rows that follow the playhead", () => {
    const samples = [s(null, []), s(4, []), s(6, [row(A)]), s(12, [row(A), row(B)]), s(25, [row(A), row(B), row(C)])];
    expect(revealProblems(samples, expected, ["z"])).toEqual([]);
  });

  it("allows a row to trail the playhead by less than the lag tolerance", () => {
    expect(revealProblems([s(6, [])], expected, [])).toEqual([]);
    expect(revealProblems([s(8, [])], expected, [])).toEqual([expect.stringContaining("a at")]);
  });

  it("flags a row shown before the playhead reached it", () => {
    expect(revealProblems([s(3, [row(A)])], expected, [])).toEqual([expect.stringContaining("shown early")]);
    // Within the lead tolerance it is one render behind, not early.
    expect(revealProblems([s(4.5, [row(A)])], expected, [])).toEqual([]);
  });

  it("flags rows before the first frame, out of order, blocked or unknown", () => {
    expect(revealProblems([s(null, [row(A)])], expected, [])).toEqual([
      expect.stringContaining("before the first frame"),
    ]);
    expect(revealProblems([s(12, [row(B), row(A)])], expected, [])).toEqual([expect.stringContaining("before")]);
    const z = { id: "z", at: at(1), catchingUpLabel: false };
    const p = revealProblems([s(6, [z, row(A)])], expected, ["z"]);
    expect(p).toEqual([expect.stringContaining("must never show"), expect.stringContaining("unexpected row z")]);
  });

  it("flags a missing or misplaced catching-up label", () => {
    expect(revealProblems([s(12, [row(A), row(B, false)])], expected, [])).toEqual([
      expect.stringContaining("catching-up label false"),
    ]);
    expect(revealProblems([s(12, [row(A, true), row(B)])], expected, [])).toEqual([
      expect.stringContaining("catching-up label true"),
    ]);
  });

  it("an empty sample list has nothing wrong", () => {
    expect(revealProblems([], expected, [])).toEqual([]);
  });
});

describe("lineOffsets", () => {
  it("spreads lines clear of both ends", () => {
    expect(lineOffsets(38, 5)).toEqual([3, 9.75, 16.5, 23.25, 30]);
    for (const o of lineOffsets(38, 5)) {
      expect(o).toBeGreaterThanOrEqual(3);
      expect(o).toBeLessThanOrEqual(30);
    }
  });

  it("stays ordered for a very short recording and a single line", () => {
    const short = lineOffsets(5, 3);
    expect(short).toEqual([3, 3.5, 4]);
    expect(lineOffsets(40, 1)).toEqual([3]);
  });
});

describe("selectors and paths", () => {
  it("builds attribute selectors and watch paths", () => {
    expect(replaySel("replay-row", { "message-id": "m1" })).toBe('[data-testid="replay-row"][data-message-id="m1"]');
    expect(replaySel("vod-player")).toBe('[data-testid="vod-player"]');
    expect(replaySel("x", { v: 'a"b' })).toBe('[data-testid="x"][data-v="a\\"b"]');
    expect(vodPath("rivertide", "v1")).toBe("/rivertide/vods/v1");
    expect(clipPath("river tide", "c1")).toBe("/river%20tide/clips/c1");
  });
});

describe("agedDays", () => {
  it("seeds past the stack's CHAT_REPLAY_MAX_DAYS, default 60", () => {
    expect(agedDays({})).toBe(65);
    expect(agedDays({ CHAT_REPLAY_MAX_DAYS: "" })).toBe(65);
    expect(agedDays({ CHAT_REPLAY_MAX_DAYS: "120" })).toBe(125);
  });
});
