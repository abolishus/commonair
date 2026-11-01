// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { emptyTally, ingestChecks, median, ruleOf, sumCounts, tally, type HealthSample } from "../src/index.ts";

/** An injected clock: 12:00:00 UTC on a fixed day. */
const T0 = Date.parse("2026-11-01T12:00:00Z");
const sample = (sec: number, over: Partial<HealthSample> = {}): HealthSample => ({
  atMs: T0 + sec * 1000,
  bitrateKbps: 4000,
  fps: 30,
  keyframeIntervalMs: 2000,
  droppedFrames: 0,
  warnings: [],
  ...over,
});
const every5 = (n: number, over: (i: number) => Partial<HealthSample> = () => ({})) =>
  Array.from({ length: n }, (_, i) => sample(i * 5, over(i)));
const check = (r: ReturnType<typeof ingestChecks>, name: string) => r.find((c) => c.check === name)!;

describe("chat tally", () => {
  test("codes map to rules; held messages are the word filter; msg_rejected depends on the kind", () => {
    expect(ruleOf("rejected", "msg_ratelimit", "chat")).toBe("rateLimit");
    expect(ruleOf("rejected", "msg_slowmode", "chat")).toBe("rateLimit");
    expect(ruleOf("rejected", "msg_duplicate", "repeat")).toBe("duplicate");
    expect(ruleOf("rejected", "msg_links_blocked", "link")).toBe("link");
    expect(ruleOf("held", null, "filtered")).toBe("wordFilter");
    expect(ruleOf("held", null, "chat")).toBe("wordFilter");
    expect(ruleOf("rejected", "msg_rejected", "filtered")).toBe("wordFilter");
    expect(ruleOf("rejected", "msg_rejected", "chat")).toBe("other");
    expect(ruleOf("rejected", "msg_banned", "chat")).toBe("other");
    expect(ruleOf("rejected", null, "chat")).toBe("other");
  });

  test("tally counts each outcome once and does not mutate", () => {
    const t0 = emptyTally();
    let t = tally(t0, "accepted", null, "chat");
    t = tally(t, "held", null, "filtered");
    t = tally(t, "rejected", "msg_duplicate", "repeat");
    t = tally(t, "rejected", "msg_duplicate", "repeat");
    expect(t0).toEqual(emptyTally());
    expect(t.accepted).toBe(1);
    expect(t.held.wordFilter).toBe(1);
    expect(t.rejected.duplicate).toBe(2);
    expect(sumCounts(t.rejected)).toBe(2);
    expect(sumCounts(t.held)).toBe(1);
  });
});

describe("ingest checks", () => {
  test("no samples: no checks yet (pending)", () => {
    expect(ingestChecks([])).toEqual([]);
  });

  test("a steady stream passes every check", () => {
    const r = ingestChecks(every5(24));
    expect(r.map((c) => c.check)).toEqual(["bitrate", "fps", "keyframe_interval", "dropped_frames", "audio", "video"]);
    expect(r.every((c) => c.ok && c.dips.length === 0)).toBe(true);
  });

  test("a bitrate dip below 50% of target is timed from its first sample to the next good one", () => {
    // 12:04:00 and 12:04:05 drop to 1500 kbps (< 2000 = 50% of the 4000 median), good again at 12:04:10.
    const r = ingestChecks(every5(60, (i) => (i === 48 || i === 49 ? { bitrateKbps: 1500 } : {})));
    const b = check(r, "bitrate");
    expect(b.ok).toBe(false);
    expect(b.dips).toEqual([{ atMs: Date.parse("2026-11-01T12:04:00Z"), seconds: 10 }]);
    expect(check(r, "fps").ok).toBe(true);
  });

  test("exactly 50% is not a dip; an explicit target wins over the median", () => {
    expect(check(ingestChecks(every5(10, (i) => (i === 3 ? { bitrateKbps: 2000 } : {}))), "bitrate").ok).toBe(true);
    expect(check(ingestChecks(every5(10), { targetKbps: 10_000 }), "bitrate").dips).toHaveLength(1);
  });

  test("separate dips stay separate; a dip at the end lasts at least one interval", () => {
    const r = ingestChecks(every5(10, (i) => (i === 2 || i === 9 ? { bitrateKbps: 100 } : {})));
    expect(check(r, "bitrate").dips).toEqual([
      { atMs: T0 + 10_000, seconds: 5 },
      { atMs: T0 + 45_000, seconds: 5 },
    ]);
  });

  test("fps below 90% of the median, keyframe warnings, dropped frames, audio and video", () => {
    const r = ingestChecks(
      every5(10, (i) => ({
        fps: i === 1 ? 20 : 30,
        warnings: [
          ...(i === 2 ? ["keyframe_interval"] : []),
          ...(i === 3 ? ["audio_missing"] : []),
          ...(i === 4 ? ["video_codec_unsupported"] : []),
        ],
        droppedFrames: i === 5 ? 12 : 0,
      })),
    );
    expect(check(r, "fps").dips).toEqual([{ atMs: T0 + 5000, seconds: 5 }]);
    expect(check(r, "keyframe_interval").dips).toEqual([{ atMs: T0 + 10_000, seconds: 5 }]);
    expect(check(r, "audio").dips).toEqual([{ atMs: T0 + 15_000, seconds: 5 }]);
    expect(check(r, "video").dips).toEqual([{ atMs: T0 + 20_000, seconds: 5 }]);
    expect(check(r, "dropped_frames").dips).toEqual([{ atMs: T0 + 25_000, seconds: 5 }]);
    expect(check(r, "bitrate").ok).toBe(true);
  });

  test("unknown values (no probe yet) are never dips", () => {
    const r = ingestChecks(every5(6, () => ({ fps: null, droppedFrames: null, keyframeIntervalMs: null })));
    expect(check(r, "fps").ok).toBe(true);
    expect(check(r, "dropped_frames").ok).toBe(true);
  });

  test("samples arrive in any order", () => {
    const s = every5(10, (i) => (i === 4 ? { bitrateKbps: 10 } : {}));
    expect(ingestChecks([...s].reverse())).toEqual(ingestChecks(s));
  });
});

describe("median", () => {
  test("odd, even and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
