// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { decodeCue, decodeLiveTrack } from "@commonair/captions";
import { describe, expect, test } from "vite-plus/test";
import {
  captionFixture,
  dvrPurgePrefix,
  FIXTURE_CUE_TEXT,
  receiptTotals,
  servedBy,
  vttCacheControlOk,
} from "../../src/w3/dvr-relay/checks.ts";
import { stepDvrPurge, stepDvrRelay, stepRelayVtt } from "../../src/w3/dvr-relay/index.ts";

const SID = "0192f3a4-5b6c-7d8e-9f01-00000000dd01";
const OTHER = "0192f3a4-5b6c-7d8e-9f01-00000000dd02";

describe("receiptTotals", () => {
  test("sums one session's entries across receipts and ignores the rest", () => {
    const payloads = [
      {
        entries: [
          { sessionId: SID, segments: 3, bytes: 300 },
          { sessionId: OTHER, segments: 9, bytes: 900 },
        ],
      },
      { entries: [{ sessionId: SID, segments: 2, bytes: 200 }] },
      { entries: [] },
      null,
      "garbage",
      { entries: [{ sessionId: SID, segments: "5", bytes: Number.NaN }] },
    ];
    expect(receiptTotals(payloads, SID)).toEqual({ segments: 5, bytes: 500 });
    expect(receiptTotals(payloads, "nobody")).toEqual({ segments: 0, bytes: 0 });
    expect(receiptTotals([], SID)).toEqual({ segments: 0, bytes: 0 });
  });
});

describe("vttCacheControlOk", () => {
  test("max-age=30 without immutable", () => {
    expect(vttCacheControlOk("private, max-age=30")).toBe(true);
    expect(vttCacheControlOk("Public, Max-Age=30")).toBe(true);
    expect(vttCacheControlOk("private, max-age=86400, immutable")).toBe(false);
    expect(vttCacheControlOk("private, max-age=30, immutable")).toBe(false);
    expect(vttCacheControlOk("private, max-age=300")).toBe(false);
    expect(vttCacheControlOk(null)).toBe(false);
  });
});

describe("servedBy", () => {
  test("same origin only", () => {
    expect(servedBy("http://10.0.0.2:8099/dvr/x/index.m3u8?t=a", "http://10.0.0.2:8099")).toBe(true);
    expect(servedBy("http://10.0.0.2:8098/dvr/x/index.m3u8", "http://10.0.0.2:8099")).toBe(false);
    expect(servedBy("http://origin.test/dvr/x/index.m3u8", "http://10.0.0.2:8099")).toBe(false);
    expect(servedBy(null, "http://10.0.0.2:8099")).toBe(false);
    expect(servedBy("not a url", "http://10.0.0.2:8099")).toBe(false);
  });
});

describe("captionFixture", () => {
  test("a track the origin decodes, one 2 s cue per 3 s segment over the window", () => {
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    const f = captionFixture("0192f3a4-5b6c-7d8e-9f01-00000000bb01", now, 30);
    expect(f.liveKey).toBe("captions:live:0192f3a4-5b6c-7d8e-9f01-00000000bb01");
    expect(f.cuesKey).toBe("captions:cues:0192f3a4-5b6c-7d8e-9f01-00000000bb01:en");
    const track = decodeLiveTrack(f.track);
    expect(track).toEqual({ language: "en", w0Ms: now - 30_000, anchorMs: now - 30_000, throughMs: now });
    expect(f.cues).toHaveLength(10);
    for (const [score, member] of f.cues) {
      const cue = decodeCue(member);
      expect(cue?.startMs).toBe(score);
      expect(cue && cue.endMs - cue.startMs).toBe(2000);
      expect(cue?.text.startsWith(FIXTURE_CUE_TEXT)).toBe(true);
      expect(score + 2000).toBeLessThanOrEqual(now);
    }
    // Members are unique even with identical timing (the `n` field).
    expect(new Set(f.cues.map(([, m]) => m)).size).toBe(f.cues.length);
  });
});

test("the purge prefix is the relay's DVR cache tree", () => {
  expect(dvrPurgePrefix("0192f3a4-5b6c-7d8e-9f01-00000000aa01")).toBe("dvr/0192f3a4-5b6c-7d8e-9f01-00000000aa01/");
});

test("the three steps are real (no stub left)", async () => {
  const src = await Bun.file(new URL("../../src/w3/dvr-relay/index.ts", import.meta.url)).text();
  expect(src).not.toContain("not merged");
  expect([stepDvrRelay, stepDvrPurge, stepRelayVtt].every((f) => typeof f === "function")).toBe(true);
});
