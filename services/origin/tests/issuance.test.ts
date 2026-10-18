// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ChannelMinute } from "../src/accounting.ts";
import { computeIssuance, dirBytes, issuanceBucket, sessionAllowance } from "../src/issuance.ts";

const R1 = "0190a0a0-0000-7000-8000-0000000000a1";
const R2 = "0190a0a0-0000-7000-8000-0000000000a2";
const B1 = "0190a0a0-0000-7000-8000-0000000000b1";
const B2 = "0190a0a0-0000-7000-8000-0000000000b2";
const at = new Date(120_000);

const minute = (dirs: Record<string, [segments: number, segmentBytes: number, partBytes: number]>): ChannelMinute =>
  new Map(
    Object.entries(dirs).map(([d, [segments, segmentBytes, partBytes]]) => [d, { segments, segmentBytes, partBytes }]),
  );

describe("per-session allowance", () => {
  test("a directory's bytes are the larger of whole segments and parts (a player fetches one or the other)", () => {
    expect(dirBytes({ segments: 60, segmentBytes: 1000, partBytes: 900 })).toBe(1000);
    expect(dirBytes({ segments: 60, segmentBytes: 0, partBytes: 900 })).toBe(900);
  });

  test("max over directories (a session watches one rendition at a time)", () => {
    const m = minute({ "live/a": [120, 15_000_000, 14_000_000], "live/a/720p": [120, 9_000_000, 9_500_000] });
    expect(sessionAllowance(m)).toEqual({ segments: 120, bytes: 15_000_000 });
  });

  test("no production → nothing issued", () => {
    expect(sessionAllowance(undefined)).toEqual({ segments: 0, bytes: 0 });
    expect(sessionAllowance(new Map())).toEqual({ segments: 0, bytes: 0 });
  });
});

describe("computeIssuance", () => {
  const production = (path: string) =>
    ({
      "live/a": minute({ "live/a": [120, 15_000_000, 0] }),
      "live/b": minute({ "live/b": [60, 3_000_000, 3_600_000], "live/b/480p": [60, 1_000_000, 0] }),
    })[path];

  test("sessions × segments and sessions × bytes, summed over the relay's broadcasts", () => {
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
        segmentTokens: 3 * 120 + 2 * 60,
        bytesIssued: 3 * 15_000_000 + 2 * 3_600_000,
      },
      { relayId: R2, bucketStart: at, sessions: 1, segmentTokens: 60, bytesIssued: 3_600_000 },
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
