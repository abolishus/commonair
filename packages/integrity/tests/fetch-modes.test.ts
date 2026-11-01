// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** ADR 0016 decision 6: each playback mode's claimed seconds against that mode's fetches. */
import { describe, expect, test } from "vite-plus/test";
import {
  claimedSecondsUntil,
  DVR_SEGMENT_SECONDS,
  DVR_TOO_MANY_ALLOWANCE_SECONDS,
  fetchChecks,
  fetchSignal,
} from "../src/signals/fetch.ts";
import type { FetchSummary, HeartbeatSample, P2pEvidence } from "../src/types.ts";

const ctx = { segmentDurationSeconds: 1, partsPerSegment: 5 };
const origin = { assignedSource: "origin" as const, watchSeconds: 120 };
/** A live player at 1 s segments: about one segment per second plus playlist reloads. */
const liveOk = (seconds: number): FetchSummary => ({ playlists: seconds, segments: seconds, parts: 0 });
/** A DVR player on 4 s recorder segments. */
const dvrOk = (seconds: number): FetchSummary => ({
  playlists: Math.ceil(seconds / 4),
  segments: Math.ceil(seconds / DVR_SEGMENT_SECONDS),
  parts: 0,
});
const evidenced: P2pEvidence = {
  evidenced: true,
  linkedNetworks: 2,
  linkedWithinCap: 2,
  sameNetworkPeers: 1,
  announces: 20,
};

describe("fetchChecks by playback mode", () => {
  test("absent mode is live: identical to the single-mode judgement", () => {
    const cases: FetchSummary[] = [
      liveOk(120),
      { playlists: 0, segments: 0, parts: 0 },
      { playlists: 40, segments: 0, parts: 0 },
    ];
    for (const f of cases) {
      expect(fetchChecks(origin, f, ctx)).toEqual(
        fetchChecks({ ...origin, dvrSeconds: 0 }, f, { ...ctx, dvrFetches: null }),
      );
      expect(fetchChecks({ ...origin, dvrSeconds: undefined }, f, ctx).measures.dvrSeconds).toBeUndefined();
    }
    expect(fetchChecks(origin, null, ctx).skipped).toBe("no_accounting");
  });

  test("live only: an honest live session passes", () => {
    expect(fetchChecks(origin, liveOk(120), ctx)).toMatchObject({ checks: [], mediaUnconfirmed: false, skipped: null });
  });

  test("DVR only: DVR seconds verify on /dvr/ fetches alone", () => {
    const s = { ...origin, dvrSeconds: 120 };
    const r = fetchChecks(s, null, { ...ctx, dvrFetches: dvrOk(120) });
    expect(r).toMatchObject({ checks: [], mediaUnconfirmed: false, skipped: null });
    expect(r.measures).toMatchObject({ dvrSeconds: 120, liveSeconds: 0, dvrSegments: 30, dvrExpectedSegments: 30 });
    expect(fetchSignal(s, null, { ...ctx, dvrFetches: dvrOk(120) })).toBeNull();
  });

  test("mixed: each part is judged on its own fetches", () => {
    const s = { ...origin, watchSeconds: 240, dvrSeconds: 120 };
    expect(fetchChecks(s, liveOk(120), { ...ctx, dvrFetches: dvrOk(120) }).checks).toEqual([]);
    // The live part's fetches cannot stand in for the DVR part's.
    const noDvr = fetchChecks(s, liveOk(240), { ...ctx, dvrFetches: null });
    expect(noDvr.checks).toEqual(["no_media_fetched"]);
    expect(noDvr.mediaUnconfirmed).toBe(true);
    // Nor the other way round.
    const noLive = fetchChecks(s, { playlists: 0, segments: 0, parts: 0 }, { ...ctx, dvrFetches: dvrOk(240) });
    expect(noLive.checks).toEqual(["no_media_fetched"]);
    // A starved DVR part holds the session even though live is fine.
    const starved = fetchChecks(s, liveOk(120), { ...ctx, dvrFetches: { playlists: 30, segments: 5, parts: 0 } });
    expect(starved.checks).toEqual(["too_few_segments"]);
    expect(starved.mediaUnconfirmed).toBe(true);
    expect(starved.measures.dvrSegmentRatio).toBeCloseTo(5 / 30, 2);
  });

  test("a mode lie: claiming live while fetching only /dvr/ fails no_media_fetched", () => {
    const r = fetchChecks(origin, null, { ...ctx, dvrFetches: dvrOk(120) });
    expect(r.checks).toContain("no_media_fetched");
    expect(r.mediaUnconfirmed).toBe(true);
    expect(fetchSignal(origin, null, { ...ctx, dvrFetches: dvrOk(120) })!.score).toBeGreaterThanOrEqual(0.9);
  });

  test("a mode lie the other way: claiming dvr without DVR fetches fails no_media_fetched", () => {
    const r = fetchChecks({ ...origin, dvrSeconds: 120 }, liveOk(120), ctx);
    expect(r.checks).toEqual(["no_media_fetched"]);
    expect(r.mediaUnconfirmed).toBe(true);
  });

  test("DVR has no P2P share and is judged as origin for a CDN session", () => {
    const s = { ...origin, dvrSeconds: 120 };
    // P2P evidence never lowers the DVR expectation.
    expect(
      fetchChecks(s, null, { ...ctx, p2p: evidenced, dvrFetches: { playlists: 30, segments: 4, parts: 0 } }).checks,
    ).toEqual(["too_few_segments"]);
    const cdn = { ...s, assignedSource: "cdn" as const };
    expect(fetchChecks(cdn, null, { ...ctx, dvrFetches: dvrOk(120) })).toMatchObject({
      checks: [],
      mediaUnconfirmed: false,
      skipped: null,
    });
    // A CDN session with no DVR seconds stays unjudged.
    expect(fetchChecks({ ...cdn, dvrSeconds: 0 }, null, { ...ctx, dvrFetches: dvrOk(8) }).skipped).toBe("cdn");
  });

  test("a relay session's DVR is judged on its relay's receipts (ADR 0016 Amendment 1)", () => {
    const relay = { assignedSource: "relay" as const, watchSeconds: 180, dvrSeconds: 120 };
    // 60 live seconds at 1 s segments plus 120 DVR seconds at 4 s: 90 objects expected.
    const ok = fetchChecks(relay, { relayObjects: 90, claimedSeconds: 60, claimedDvrSeconds: 120 }, ctx);
    expect(ok).toMatchObject({ checks: [], mediaUnconfirmed: false, skipped: null });
    expect(ok.measures).toMatchObject({ expectedSegments: 90, claimedDvrSeconds: 120, segmentRatio: 1 });
    // All DVR: the receipts alone confirm it; the origin's DVR counters play no part.
    const allDvr = { ...relay, watchSeconds: 120 };
    expect(
      fetchChecks(
        allDvr,
        { relayObjects: 30, claimedSeconds: 0, claimedDvrSeconds: 120 },
        { ...ctx, dvrFetches: null },
      ),
    ).toMatchObject({ checks: [], mediaUnconfirmed: false });
    expect(fetchChecks(allDvr, { relayObjects: 0, claimedSeconds: 0, claimedDvrSeconds: 120 }, ctx).checks).toEqual([
      "no_media_fetched",
    ]);
    expect(fetchChecks(allDvr, { relayObjects: 5, claimedSeconds: 0, claimedDvrSeconds: 120 }, ctx).checks).toEqual([
      "too_few_segments",
    ]);
    // No receipt coverage holds it pending, whatever the origin counted.
    expect(fetchChecks(allDvr, null, { ...ctx, dvrFetches: dvrOk(120) })).toMatchObject({
      mediaUnconfirmed: true,
      skipped: "no_accounting",
    });
    expect(
      fetchChecks(allDvr, { relayObjects: null, claimedSeconds: 0 }, { ...ctx, dvrFetches: dvrOk(120) })
        .mediaUnconfirmed,
    ).toBe(true);
    // Absent `claimedDvrSeconds` is 0: the live-only judgement.
    expect(fetchChecks({ ...relay, dvrSeconds: 0 }, { relayObjects: 60, claimedSeconds: 60 }, ctx).checks).toEqual([]);
  });

  test("threshold edges on the DVR part (4 s segments, 10 expected)", () => {
    const at = (seconds: number, segments: number) =>
      fetchChecks({ ...origin, watchSeconds: seconds, dvrSeconds: seconds }, null, {
        ...ctx,
        dvrFetches: { playlists: 9, segments, parts: 0 },
      });
    // 39 s is under 10 expected segments: not judged.
    expect(at(39, 0)).toMatchObject({ checks: [], mediaUnconfirmed: false });
    // 40 s with no segments: no media (a playlist poller is caught by its own check first).
    expect(at(40, 0)).toMatchObject({ checks: ["no_media_fetched"], mediaUnconfirmed: true });
    const poller = fetchChecks({ ...origin, watchSeconds: 40, dvrSeconds: 40 }, null, {
      ...ctx,
      dvrFetches: { playlists: 10, segments: 0, parts: 0 },
    });
    expect(poller).toMatchObject({ checks: ["playlists_without_segments"], mediaUnconfirmed: true });
    // 25 % of 10 expected.
    expect(at(40, 2).checks).toEqual(["too_few_segments"]);
    expect(at(40, 3).checks).toEqual([]);
    // Too many: 4 × expected + the DVR allowance.
    const ceiling = 10 * 4 + DVR_TOO_MANY_ALLOWANCE_SECONDS / DVR_SEGMENT_SECONDS;
    expect(at(40, ceiling).checks).toEqual([]);
    expect(at(40, ceiling + 1).checks).toEqual(["too_many_segments"]);
  });

  test("the live part's threshold uses the live seconds only", () => {
    // 9 live seconds are under the bar even with no live media.
    const s = { ...origin, watchSeconds: 129, dvrSeconds: 120 };
    expect(fetchChecks(s, null, { ...ctx, dvrFetches: dvrOk(120) }).checks).toEqual([]);
    expect(fetchChecks({ ...s, watchSeconds: 130 }, null, { ...ctx, dvrFetches: dvrOk(120) }).checks).toEqual([
      "no_media_fetched",
    ]);
  });

  test("DVR seconds are clamped to the watch time and never negative", () => {
    const over = fetchChecks({ ...origin, watchSeconds: 60, dvrSeconds: 600 }, null, { ...ctx, dvrFetches: dvrOk(60) });
    expect(over.measures).toMatchObject({ dvrSeconds: 60, liveSeconds: 0 });
    expect(over.checks).toEqual([]);
    expect(fetchChecks({ ...origin, dvrSeconds: -5 }, liveOk(120), ctx)).toEqual(fetchChecks(origin, liveOk(120), ctx));
  });

  test("a custom DVR segment duration", () => {
    const r = fetchChecks({ ...origin, dvrSeconds: 120 }, null, {
      ...ctx,
      dvrSegmentDurationSeconds: 2,
      dvrFetches: dvrOk(120),
    });
    // 30 segments for 60 expected: still above a quarter.
    expect(r.measures.dvrExpectedSegments).toBe(60);
    expect(r.checks).toEqual([]);
  });
});

describe("claimedSecondsUntil by mode", () => {
  const beat = (
    at: number,
    playedSeconds: number,
    mode?: "live" | "dvr",
  ): HeartbeatSample & { mode?: "live" | "dvr" } => ({
    at,
    playedSeconds,
    bufferSeconds: 2,
    visible: true,
    muted: false,
    stalls: 0,
    bytesHttp: 0,
    bytesP2p: 0,
    ...(mode ? { mode } : {}),
  });
  const s = { watchSeconds: 100, dvrSeconds: 40, startedAt: new Date(0), lastHeartbeatAt: new Date(100_000) };

  test("beats: a mode counts only its beats; a beat without a mode is live", () => {
    const beats = [beat(10_000, 10), beat(20_000, 10, "dvr"), beat(30_000, 10, "live"), beat(40_000, 10, "dvr")];
    expect(claimedSecondsUntil(beats, 40_000, s)).toBe(40);
    expect(claimedSecondsUntil(beats, 40_000, s, { mode: "live" })).toBe(20);
    expect(claimedSecondsUntil(beats, 40_000, s, { mode: "dvr" })).toBe(20);
    expect(claimedSecondsUntil(beats, 25_000, s, { mode: "dvr" })).toBe(10);
  });

  test("no beats: the database split, spread over the session", () => {
    expect(claimedSecondsUntil([], 50_000, s)).toBe(50);
    expect(claimedSecondsUntil([], 50_000, s, { mode: "live" })).toBe(30);
    expect(claimedSecondsUntil([], 50_000, s, { mode: "dvr" })).toBe(20);
    expect(claimedSecondsUntil([], 50_000, { ...s, dvrSeconds: undefined }, { mode: "live" })).toBe(50);
    expect(claimedSecondsUntil([], 50_000, { ...s, dvrSeconds: 500 }, { mode: "dvr" })).toBe(50);
  });
});
