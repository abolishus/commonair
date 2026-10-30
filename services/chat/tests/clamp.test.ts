// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { clampMediaTs, MEDIA_TS_WINDOW_MS, type ClampInput } from "../src/clamp.ts";

const receivedAt = new Date("2026-10-30T12:00:00.000Z");
const at = (offsetMs: number) => new Date(receivedAt.getTime() + offsetMs);
const startedLongAgo = at(-3_600_000);

const clamp = (over: Partial<ClampInput>) =>
  clampMediaTs({
    receivedAt,
    hint: null,
    playbackMode: "live",
    liveStartedAt: startedLongAgo,
    channelLatencySeconds: null,
    ...over,
  });

describe("clampMediaTs (ADR 0012 amendment 1 decisions 2 and 4)", () => {
  test("the window is 60 s", () => {
    expect(MEDIA_TS_WINDOW_MS).toBe(60_000);
  });

  test("a hint inside the window is kept as sent", () => {
    expect(clamp({ hint: at(-5_000) })).toEqual(at(-5_000));
  });

  test("exactly the lower edge (receive − 60 s) is kept", () => {
    expect(clamp({ hint: at(-60_000) })).toEqual(at(-60_000));
  });

  test("past the lower edge is raised to it", () => {
    expect(clamp({ hint: at(-60_001) })).toEqual(at(-60_000));
    expect(clamp({ hint: at(-120_000) })).toEqual(at(-60_000));
  });

  test("exactly receive time is kept", () => {
    expect(clamp({ hint: receivedAt })).toEqual(receivedAt);
  });

  test("a future hint becomes receive time", () => {
    expect(clamp({ hint: at(1) })).toEqual(receivedAt);
    expect(clamp({ hint: at(10_000) })).toEqual(receivedAt);
  });

  test("a hint before the broadcast started becomes started_at", () => {
    const startedAt = at(-20_000);
    expect(clamp({ hint: at(-30_000), liveStartedAt: startedAt })).toEqual(startedAt);
    expect(clamp({ hint: at(-20_000), liveStartedAt: startedAt })).toEqual(startedAt);
    expect(clamp({ hint: at(-19_000), liveStartedAt: startedAt })).toEqual(at(-19_000));
  });

  test("a broadcast start after receive time (host skew) bounds at receive time", () => {
    expect(clamp({ hint: at(-5_000), liveStartedAt: at(2_000) })).toEqual(receivedAt);
    expect(clamp({ liveStartedAt: at(2_000), channelLatencySeconds: 4 })).toEqual(receivedAt);
  });

  test("an offline channel drops the hint", () => {
    expect(clamp({ hint: at(-5_000), liveStartedAt: null })).toBeNull();
    expect(clamp({ hint: null, liveStartedAt: null, channelLatencySeconds: 3 })).toBeNull();
  });

  test("DVR mode is always null", () => {
    expect(clamp({ hint: at(-5_000), playbackMode: "dvr" })).toBeNull();
    expect(clamp({ hint: null, playbackMode: "dvr", channelLatencySeconds: 3 })).toBeNull();
  });

  test("no hint and no latency key: receive time", () => {
    expect(clamp({})).toEqual(receivedAt);
  });

  test("no hint with a latency: receive − latency", () => {
    expect(clamp({ channelLatencySeconds: 4 })).toEqual(at(-4_000));
    expect(clamp({ channelLatencySeconds: 2.5 })).toEqual(at(-2_500));
  });

  test("no hint with a latency above 60 s: the lower edge", () => {
    expect(clamp({ channelLatencySeconds: 90 })).toEqual(at(-60_000));
  });

  test("no hint with a latency reaching before started_at: started_at", () => {
    expect(clamp({ channelLatencySeconds: 10, liveStartedAt: at(-3_000) })).toEqual(at(-3_000));
  });

  test("a negative or non-finite latency counts as zero", () => {
    expect(clamp({ channelLatencySeconds: -5 })).toEqual(receivedAt);
    expect(clamp({ channelLatencySeconds: Number.NaN })).toEqual(receivedAt);
    expect(clamp({ channelLatencySeconds: Number.POSITIVE_INFINITY })).toEqual(receivedAt);
  });

  test("a hint wins over the latency", () => {
    expect(clamp({ hint: at(-7_000), channelLatencySeconds: 3 })).toEqual(at(-7_000));
  });

  test("an invalid Date hint falls back to receive time", () => {
    expect(clamp({ hint: new Date(Number.NaN) })).toEqual(receivedAt);
  });

  test("returns a new Date, never the caller's object", () => {
    const hint = at(-1_000);
    const out = clamp({ hint });
    expect(out).toEqual(hint);
    expect(out).not.toBe(hint);
  });
});
