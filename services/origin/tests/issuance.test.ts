// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  computeIssuance,
  dirBytes,
  dirObjects,
  issuanceBucket,
  recomputeBuckets,
  sessionAllowance,
} from "../src/issuance.ts";
import { type ChannelMinute, type DirProduction } from "../src/production.ts";

const R1 = "0190a0a0-0000-7000-8000-0000000000a1";
const R2 = "0190a0a0-0000-7000-8000-0000000000a2";
const B1 = "0190a0a0-0000-7000-8000-0000000000b1";
const B2 = "0190a0a0-0000-7000-8000-0000000000b2";
const at = new Date(120_000);

const dir = (p: Partial<DirProduction>): DirProduction => ({
  segments: 0,
  segmentBytes: 0,
  parts: 0,
  partBytes: 0,
  inits: 0,
  initBytes: 0,
  ...p,
});
const minute = (dirs: Record<string, Partial<DirProduction>>): ChannelMinute =>
  new Map(Object.entries(dirs).map(([d, p]) => [d, dir(p)]));

describe("per-directory production", () => {
  test("objects count every media object a relay could deliver: full segments + parts + init", () => {
    // One minute of 1 s segments with 5 parts each, video + audio tracks, one init per track.
    expect(dirObjects(dir({ segments: 120, parts: 600, inits: 2 }))).toBe(722);
  });

  test("bytes: the larger of whole segments and parts (a player fetches one or the other), plus init", () => {
    expect(dirBytes(dir({ segmentBytes: 1000, partBytes: 900, initBytes: 7 }))).toBe(1007);
    expect(dirBytes(dir({ segmentBytes: 0, partBytes: 900 }))).toBe(900);
  });
});

describe("per-session allowance", () => {
  test("max over directories (a session watches one rendition at a time)", () => {
    const m = minute({
      "live/a": { segments: 120, parts: 600, inits: 2, segmentBytes: 15_000_000, partBytes: 14_000_000 },
      "live/a/720p": { segments: 60, parts: 700, segmentBytes: 9_000_000, partBytes: 9_500_000 },
    });
    expect(sessionAllowance(m)).toEqual({ segments: 760, bytes: 15_000_000 });
  });

  test("no production → nothing issued", () => {
    expect(sessionAllowance(undefined)).toEqual({ segments: 0, bytes: 0 });
    expect(sessionAllowance(new Map())).toEqual({ segments: 0, bytes: 0 });
  });
});

describe("computeIssuance", () => {
  const production = (path: string) =>
    ({
      "live/a": minute({ "live/a": { segments: 120, parts: 0, inits: 2, segmentBytes: 15_000_000, initBytes: 1_000 } }),
      "live/b": minute({
        "live/b": { segments: 60, parts: 300, segmentBytes: 3_000_000, partBytes: 3_600_000 },
        "live/b/480p": { segments: 60, segmentBytes: 1_000_000 },
      }),
    })[path];

  test("sessions × objects and sessions × bytes, summed over the relay's broadcasts", () => {
    const rows = computeIssuance(
      [
        { relayId: R1, broadcastId: B1, path: "live/a", sessions: 3 },
        { relayId: R1, broadcastId: B2, path: "live/b", sessions: 2 },
        { relayId: R2, broadcastId: B2, path: "live/b", sessions: 1 },
      ],
      production,
      at,
    );
    expect(rows).toEqual([
      {
        relayId: R1,
        bucketStart: at,
        sessions: 5,
        segmentTokens: 3 * 122 + 2 * 360,
        bytesIssued: 3 * 15_001_000 + 2 * 3_600_000,
      },
      { relayId: R2, bucketStart: at, sessions: 1, segmentTokens: 360, bytesIssued: 3_600_000 },
    ]);
  });

  test("sessions without a broadcast or production count as sessions but issue nothing", () => {
    const rows = computeIssuance(
      [
        { relayId: R1, broadcastId: null, path: null, sessions: 2 },
        { relayId: R1, broadcastId: B1, path: "live/gone", sessions: 1 },
      ],
      production,
      at,
    );
    expect(rows).toEqual([{ relayId: R1, bucketStart: at, sessions: 3, segmentTokens: 0, bytesIssued: 0 }]);
  });

  test("empty input and zero-session rows produce no rows", () => {
    expect(computeIssuance([], production, at)).toEqual([]);
    expect(computeIssuance([{ relayId: R1, broadcastId: B1, path: "live/a", sessions: 0 }], production, at)).toEqual(
      [],
    );
  });

  test("linear in sessions: doubling sessions doubles issuance", () => {
    const one = computeIssuance([{ relayId: R1, broadcastId: B1, path: "live/a", sessions: 1 }], production, at)[0];
    const two = computeIssuance([{ relayId: R1, broadcastId: B1, path: "live/a", sessions: 2 }], production, at)[0];
    expect(two?.bytesIssued).toBe(2 * (one?.bytesIssued ?? 0));
    expect(two?.segmentTokens).toBe(2 * (one?.segmentTokens ?? 0));
  });
});

test("issuanceBucket is the last complete minute", () => {
  expect(issuanceBucket(130_000)).toBe(60_000);
  expect(issuanceBucket(120_000)).toBe(60_000);
  expect(issuanceBucket(179_999)).toBe(60_000);
});

test("each tick recomputes the last N closed minutes, oldest first", () => {
  expect(recomputeBuckets(10 * 60_000 + 10_000, 5)).toEqual([5, 6, 7, 8, 9].map((m) => m * 60_000));
});
