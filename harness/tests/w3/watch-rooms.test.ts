// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `watch-room` scenario's sync measurement and refusal parsing (`src/w3/watch-rooms/sync.ts`). */
import { describe, expect, it } from "vite-plus/test";
import { WATCH_ROOM_STEP_RUNNERS } from "../../src/w3/watch-rooms/index.ts";
import {
  deltaAt,
  playheadsAt,
  refusalCode,
  summarizeDelta,
  syncFrameOf,
  type PlayheadSample,
} from "../../src/w3/watch-rooms/sync.ts";

const ROOM = "01890000-0000-7000-8000-00000000a001";
const T0 = 1_800_000_000_000;

describe("syncFrameOf", () => {
  it("reads this room's room.sync frames only", () => {
    const at = new Date(T0).toISOString();
    expect(
      syncFrameOf(JSON.stringify({ op: "room.sync", roomId: ROOM, playheadWallclock: at, mode: "live" }), ROOM),
    ).toEqual({
      pdt: T0,
      mode: "live",
    });
    expect(
      syncFrameOf(
        Buffer.from(JSON.stringify({ op: "room.sync", roomId: ROOM, playheadWallclock: at, mode: "dvr" })),
        ROOM,
      ),
    ).toEqual({ pdt: T0, mode: "dvr" });
    expect(syncFrameOf(JSON.stringify({ op: "room.sync", roomId: "other", playheadWallclock: at }), ROOM)).toBeNull();
    expect(syncFrameOf(JSON.stringify({ op: "send", body: "x" }), ROOM)).toBeNull();
    expect(syncFrameOf(JSON.stringify({ op: "room.sync", roomId: ROOM, playheadWallclock: "nope" }), ROOM)).toBeNull();
    expect(syncFrameOf("{", ROOM)).toBeNull();
  });
});

const s = (sentAt: number, behindMs: number, mode: "live" | "dvr" = "live"): PlayheadSample => ({
  sentAt,
  pdt: sentAt - behindMs,
  mode,
});

describe("playheads and deltas", () => {
  const samples: Record<string, PlayheadSample[]> = {
    a: [s(T0, 8000), s(T0 + 2000, 8000)],
    b: [s(T0 + 500, 8300), s(T0 + 2500, 8200)],
  };

  it("extrapolates each member's latest sample", () => {
    expect(playheadsAt(samples, T0 + 3000)).toEqual({ a: T0 + 3000 - 8000, b: T0 + 3000 - 8200 });
    expect(deltaAt(samples, T0 + 3000, ["a", "b"])).toBe(200);
  });

  it("a stale, missing or DVR member is unknown", () => {
    expect(deltaAt(samples, T0 + 20_000, ["a", "b"])).toBeNull();
    expect(deltaAt(samples, T0 + 3000, ["a", "b", "c"])).toBeNull();
    expect(deltaAt({ a: [s(T0, 8000)], b: [s(T0, 9000, "dvr")] }, T0 + 1000, ["a", "b"])).toBeNull();
    expect(playheadsAt(samples, T0 - 1)).toEqual({});
  });

  it("summarizes with the median, so one late frame does not decide", () => {
    const steady: Record<string, PlayheadSample[]> = { a: [], b: [] };
    for (let i = 0; i < 10; i++) {
      steady.a!.push(s(T0 + i * 2000, 8000));
      steady.b!.push(s(T0 + i * 2000 + 100, i === 9 ? 9500 : 8100));
    }
    const sum = summarizeDelta(steady, ["a", "b"], T0 + 19_000);
    expect(sum.medianMs).toBe(100);
    expect(sum.maxMs).toBe(1500);
    expect(sum.measured).toBe(8);
    expect(summarizeDelta({}, ["a"], T0)).toEqual({ medianMs: null, maxMs: null, measured: 0, missing: 8 });
  });
});

describe("refusalCode", () => {
  it("reads the requirement of a refused call", () => {
    expect(refusalCode({ code: "PRECONDITION_FAILED", data: { requirement: "room_full" } })).toBe("room_full");
    expect(refusalCode(new Error("x"))).toBeNull();
    expect(refusalCode(null)).toBeNull();
  });
});

describe("step runners", () => {
  it("every step has a runner", () => {
    expect(Object.keys(WATCH_ROOM_STEP_RUNNERS)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });
});
