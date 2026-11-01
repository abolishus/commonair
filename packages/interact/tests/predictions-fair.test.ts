// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fair predictions (batch 7 decision (v), ADR 0039 decision 3), pure: the media-time lock and its
 * grace, DVR and catching-up refusals, the live-edge distance, a missing playhead, the team rule,
 * verified-watch standing, and settlement plans whose payouts always sum to the pool.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  BET_REFUSALS,
  betMediaTime,
  effectiveLock,
  FAIR_BET_RULES,
  hasVerifiedStanding,
  isPredictionTeam,
  judgeBetTiming,
  lockMediaAt,
  predictionResult,
  predictionView,
  settlementPlan,
  verifiedWatchMeasured,
  type BetTiming,
  type PredictionRow,
} from "../src/predictions.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const LIVE = at(-3_600_000);
const { edgeWindowMs: EDGE, graceMs: GRACE } = FAIR_BET_RULES;

const uid = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const BROADCAST = "0192f000-0000-7000-8000-00000000b001";

/** A prediction that locks at T0; `locked` stores a lock at T0 with the edge at T0. */
function timing(over: Partial<BetTiming> & { locked?: boolean } = {}): BetTiming {
  const { locked = false, ...rest } = over;
  return {
    now: at(-10_000),
    mediaTs: at(-12_000),
    playbackMode: "live",
    liveStartedAt: LIVE,
    prediction: {
      status: locked ? "locked" : "active",
      locksAt: at(60_000),
      lockedAt: locked ? at(0) : null,
      lockMediaTs: locked ? at(0) : null,
    },
    ...rest,
  };
}

describe("judgeBetTiming: before the lock", () => {
  test("a live playhead near the edge is accepted", () => {
    expect(judgeBetTiming(timing())).toBeNull();
  });

  test("the edge distance: exactly 30 s behind is accepted, 1 ms more is `behind`", () => {
    expect(judgeBetTiming(timing({ mediaTs: at(-10_000 - EDGE) }))).toBeNull();
    expect(judgeBetTiming(timing({ mediaTs: at(-10_000 - EDGE - 1) }))).toBe("behind");
  });

  test("a playhead ahead of the server is taken as now (never after receipt)", () => {
    expect(judgeBetTiming(timing({ mediaTs: at(3_600_000) }))).toBeNull();
    expect(betMediaTime(at(5_000), at(0))).toEqual(at(0));
    expect(betMediaTime(at(-5_000), at(0))).toEqual(at(-5_000));
  });

  test("a playhead before the broadcast began is taken as its start (the chat clamp's floor)", () => {
    expect(betMediaTime(at(-5_000), at(0), at(-1_000))).toEqual(at(-1_000));
    expect(betMediaTime(at(-500), at(0), at(-1_000))).toEqual(at(-500));
    // Offline (no start) keeps only the upper bound.
    expect(betMediaTime(at(-5_000), at(0), null)).toEqual(at(-5_000));
  });

  test("a missing or unreadable playhead is the wall clock now, so it is accepted before the lock", () => {
    expect(judgeBetTiming(timing({ mediaTs: null }))).toBeNull();
    expect(betMediaTime(null, at(0))).toEqual(at(0));
    expect(betMediaTime(new Date(Number.NaN), at(0))).toEqual(at(0));
  });

  test("a DVR (catching-up) session is refused, even near the edge and even with no playhead", () => {
    expect(judgeBetTiming(timing({ playbackMode: "dvr" }))).toBe("not_live");
    expect(judgeBetTiming(timing({ playbackMode: "dvr", mediaTs: null }))).toBe("not_live");
    expect(judgeBetTiming(timing({ playbackMode: "dvr", mediaTs: at(-3_000_000) }))).toBe("not_live");
  });
});

describe("judgeBetTiming: after the lock (stored at T0, edge T0)", () => {
  const after = (nowMs: number, mediaMs: number | null, over: Partial<BetTiming> = {}) =>
    judgeBetTiming(timing({ locked: true, now: at(nowMs), mediaTs: mediaMs === null ? null : at(mediaMs), ...over }));

  test("exactly at lock_media_ts is refused; 1 ms before is accepted", () => {
    expect(after(2_000, 0)).toBe("closed");
    expect(after(2_000, -1)).toBeNull();
  });

  test("the far viewer (~9 s back) betting just after the wall-clock lock counts; the near viewer does not", () => {
    expect(after(2_000, 2_000 - 9_000)).toBeNull();
    expect(after(2_000, 2_000 - 500)).toBe("closed");
  });

  test("the grace: up to 30 s after the lock, 1 ms later is closed whatever the playhead", () => {
    // Both bounds hold at once (ADR 0039: at most 30 s behind, only for 30 s after the lock), so
    // the last bet in time is a playhead 1 ms before the lock, 30 s behind the edge.
    expect(after(GRACE - 1, -1)).toBeNull();
    expect(after(GRACE, -1)).toBe("behind");
    expect(after(GRACE, 0)).toBe("closed");
    expect(after(GRACE + 1, -1)).toBe("closed");
    expect(after(GRACE + 1, GRACE)).toBe("closed");
  });

  test("past the grace even a DVR session reads `closed`", () => {
    expect(after(GRACE + 1, -1, { playbackMode: "dvr" })).toBe("closed");
    expect(after(1_000, -1, { playbackMode: "dvr" })).toBe("not_live");
  });

  test("a missing playhead is now, so it is refused after the lock", () => {
    expect(after(1, null)).toBe("closed");
    expect(after(GRACE, null)).toBe("closed");
  });

  test("the edge distance still bounds a client claiming to be far behind", () => {
    // 25 s after the lock, a claimed 55 s delay puts the playhead before the lock but too far back.
    expect(after(25_000, 25_000 - 55_000)).toBe("behind");
    expect(after(25_000, 25_000 - EDGE)).toBeNull();
  });

  test("locked while offline (no lock_media_ts) takes nothing once live", () => {
    expect(
      judgeBetTiming({
        ...timing({ locked: true, now: at(1_000), mediaTs: at(-5_000) }),
        prediction: { status: "locked", locksAt: at(60_000), lockedAt: at(0), lockMediaTs: null },
      }),
    ).toBe("closed");
  });

  test("a manual lock before locksAt runs the grace from the lock; a late auto-lock from locksAt", () => {
    expect(effectiveLock({ locksAt: at(60_000), lockedAt: at(0), lockMediaTs: at(0) }, at(1), LIVE)).toEqual({
      wall: at(0),
      media: at(0),
    });
    expect(effectiveLock({ locksAt: at(0), lockedAt: at(1_800), lockMediaTs: at(0) }, at(2_000), LIVE)).toEqual({
      wall: at(0),
      media: at(0),
    });
  });
});

describe("live after locksAt, before the worker locks", () => {
  // Created offline, locksAt at 0, the broadcast began at 10 s: the worker will store the start.
  const started = at(10_000);
  const prediction = { status: "active", locksAt: at(0), lockedAt: null, lockMediaTs: null } as const;

  test("the lock is what the worker would store now, never before the broadcast began", () => {
    expect(effectiveLock(prediction, at(20_000), started)).toEqual({ wall: at(0), media: started });
  });

  test("a playhead from before the broadcast is clamped to its start, so it is refused", () => {
    const judge = (mediaMs: number) =>
      judgeBetTiming({
        now: at(20_000),
        mediaTs: at(mediaMs),
        playbackMode: "live",
        liveStartedAt: started,
        prediction,
      });
    expect(judge(5_000)).toBe("closed");
    expect(judge(10_000)).toBe("closed");
  });
});

describe("judgeBetTiming: past locksAt before the worker locks", () => {
  const due = (nowMs: number, mediaMs: number | null) =>
    judgeBetTiming({
      now: at(nowMs),
      mediaTs: mediaMs === null ? null : at(mediaMs),
      playbackMode: "live",
      liveStartedAt: LIVE,
      prediction: { status: "active", locksAt: at(0), lockedAt: null, lockMediaTs: null },
    });

  test("judged as if locked at locksAt", () => {
    expect(effectiveLock({ locksAt: at(0), lockedAt: null, lockMediaTs: null }, at(-1), LIVE)).toBeNull();
    expect(effectiveLock({ locksAt: at(0), lockedAt: null, lockMediaTs: null }, at(0), LIVE)).toEqual({
      wall: at(0),
      media: at(0),
    });
    expect(due(1_500, -1)).toBeNull();
    expect(due(1_500, 0)).toBe("closed");
    expect(due(1_500, null)).toBe("closed");
    expect(due(GRACE + 1, -1)).toBe("closed");
  });
});

describe("judgeBetTiming: no live broadcast, settled", () => {
  test("offline, the wall-clock lock alone applies (no media clock)", () => {
    const offline = { liveStartedAt: null, mediaTs: null };
    expect(judgeBetTiming(timing(offline))).toBeNull();
    expect(judgeBetTiming(timing({ ...offline, now: at(60_000) }))).toBe("closed");
    expect(judgeBetTiming(timing({ ...offline, now: at(59_999) }))).toBeNull();
    expect(judgeBetTiming(timing({ ...offline, locked: true, now: at(1) }))).toBe("closed");
  });

  test("resolved and canceled take nothing", () => {
    for (const status of ["resolved", "canceled"] as const)
      expect(
        judgeBetTiming({
          ...timing(),
          prediction: { status, locksAt: at(60_000), lockedAt: null, lockMediaTs: null },
        }),
      ).toBe("closed");
  });

  test("every refusal is a declared reason", () => {
    expect([...BET_REFUSALS]).toEqual(["closed", "not_live", "behind", "team", "unverified"]);
  });
});

describe("lockMediaAt", () => {
  test("the edge now for a manual lock, locksAt for a late auto-lock", () => {
    expect(lockMediaAt(at(0), at(60_000), LIVE)).toEqual(at(0));
    expect(lockMediaAt(at(1_900), at(0), LIVE)).toEqual(at(0));
  });

  test("never before the broadcast started, never after now; null offline", () => {
    expect(lockMediaAt(at(5_000), at(0), at(3_000))).toEqual(at(3_000));
    expect(lockMediaAt(at(1_000), at(2_000), at(9_000))).toEqual(at(1_000));
    expect(lockMediaAt(at(0), at(0), null)).toBeNull();
  });
});

describe("the team and verified watching", () => {
  const owner = uid(1);
  const viewer = uid(2);

  test("the owner, each team role refused; VIPs and viewers are not team", () => {
    expect(isPredictionTeam(owner, owner, [])).toBe(true);
    expect(isPredictionTeam(viewer, owner, ["moderator"])).toBe(true);
    expect(isPredictionTeam(viewer, owner, ["editor"])).toBe(true);
    expect(isPredictionTeam(viewer, owner, ["vip", "editor"])).toBe(true);
    expect(isPredictionTeam(viewer, owner, ["vip"])).toBe(false);
    expect(isPredictionTeam(viewer, owner, [])).toBe(false);
  });

  test("standing needs a key for the live broadcast; VIPs (no key, exempt) keep it", () => {
    const key = { b: BROADCAST, s: 120, f: 0 as const };
    expect(hasVerifiedStanding(key, BROADCAST)).toBe(true);
    expect(hasVerifiedStanding({ ...key, s: 0 }, BROADCAST)).toBe(true);
    expect(hasVerifiedStanding({ ...key, b: uid(9) }, BROADCAST)).toBe(false);
    expect(hasVerifiedStanding(null, BROADCAST)).toBe(false);
    expect(hasVerifiedStanding(key, null)).toBe(false);
    expect(hasVerifiedStanding(null, BROADCAST, ["vip"])).toBe(true);
    expect(hasVerifiedStanding(null, null, ["vip"])).toBe(false);
  });

  test("standing is asked for only where the instance writes the keys", () => {
    const off = { minVerifiedWatchSeconds: 0, surgeGuard: { enabled: false } };
    const gate = { minVerifiedWatchSeconds: 60, surgeGuard: { enabled: false } };
    const guard = { minVerifiedWatchSeconds: 0, surgeGuard: { enabled: true } };
    const both = { watchGate: true, surgeGuard: true };
    expect(verifiedWatchMeasured(both, off)).toBe(false);
    expect(verifiedWatchMeasured(both, gate)).toBe(true);
    expect(verifiedWatchMeasured(both, guard)).toBe(true);
    expect(verifiedWatchMeasured({ watchGate: false, surgeGuard: true }, gate)).toBe(false);
    expect(verifiedWatchMeasured({ watchGate: true, surgeGuard: false }, guard)).toBe(false);
  });
});

/** A small deterministic PRNG so the property cases are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 2 ** 32;
  };
}

describe("settlementPlan", () => {
  const b = (n: number, outcomeId: string, points: number) => ({ userId: uid(n), outcomeId, points });

  test("payoutSum equals the pool across random pools (property)", () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const outcomes = ["A", "B", "C"].slice(0, 2 + Math.floor(r() * 2));
      const n = 1 + Math.floor(r() * 40);
      const bets = Array.from({ length: n }, (_, j) =>
        b(j + 1, outcomes[Math.floor(r() * outcomes.length)] ?? "A", 1 + Math.floor(r() * (r() < 0.2 ? 250_000 : 999))),
      );
      const winner = outcomes[Math.floor(r() * outcomes.length)] ?? "A";
      const plan = settlementPlan(bets, winner);
      const pool = bets.reduce((s, x) => s + x.points, 0);
      expect(plan.pool).toBe(pool);
      expect(plan.payoutSum).toBe(pool);
      expect(plan.credits.reduce((s, c) => s + c.delta, 0)).toBe(pool);
      const onWinner = bets.filter((x) => x.outcomeId === winner).length;
      expect(plan.kind).toBe(onWinner > 0 ? "payout" : "refund");
      expect(plan.winners).toBe(onWinner);
      expect(plan.credits.every((c) => Number.isInteger(c.delta) && c.delta >= 0)).toBe(true);
    }
  });

  test("ties split by largest remainder, the extra point to the lower user id", () => {
    const plan = settlementPlan([b(3, "A", 1), b(2, "A", 1), b(1, "B", 1)], "A");
    expect(plan.credits).toEqual([
      { userId: uid(1), delta: 0 },
      { userId: uid(2), delta: 2 },
      { userId: uid(3), delta: 1 },
    ]);
    expect(plan.payoutSum).toBe(3);
  });

  test("a single winner takes the whole pool", () => {
    const plan = settlementPlan([b(1, "A", 10), b(2, "B", 500), b(3, "B", 90)], "A");
    expect(plan).toMatchObject({ kind: "payout", pool: 600, winners: 1, payoutSum: 600 });
    expect(plan.credits.find((c) => c.userId === uid(1))?.delta).toBe(600);
  });

  test("an outcome with no bets refunds every stake; a cancel too; no bets at all is an empty refund", () => {
    const bets = [b(1, "A", 10), b(2, "A", 5)];
    for (const winner of ["B", null]) {
      const plan = settlementPlan(bets, winner);
      expect(plan).toMatchObject({ kind: "refund", pool: 15, winners: 0, payoutSum: 15 });
      expect(plan.credits).toEqual([
        { userId: uid(1), delta: 10 },
        { userId: uid(2), delta: 5 },
      ]);
    }
    expect(settlementPlan([], "A")).toEqual({ kind: "refund", pool: 0, winners: 0, credits: [], payoutSum: 0 });
  });
});

describe("the result card", () => {
  const row = (over: Partial<PredictionRow> = {}): PredictionRow => ({
    id: "p0000000-0000-7000-8000-000000000001",
    channelId: "c0000000-0000-7000-8000-000000000000",
    title: "Who wins?",
    outcomes: [
      { id: "A", title: "Alpha", points: 400, users: 2 },
      { id: "B", title: "Beta", points: 200, users: 1 },
    ],
    status: "resolved",
    windowSeconds: 60,
    winningOutcomeId: "A",
    createdById: null,
    startedAt: at(-60_000),
    locksAt: at(0),
    lockedAt: at(0),
    lockMediaTs: at(-100),
    resolvedById: uid(5),
    resolvedAt: at(10_000),
    changedAt: null,
    progressAt: null,
    ...over,
  });

  test("resolved: the pool, the winners on the winning outcome and the payout sum", () => {
    expect(predictionResult(row(), 600)).toEqual({ pool: 600, winners: 2, payoutSum: 600 });
  });

  test("canceled: no winners, every stake back", () => {
    expect(predictionResult(row({ status: "canceled", winningOutcomeId: null }), 600)).toEqual({
      pool: 600,
      winners: 0,
      payoutSum: 600,
    });
  });

  test("none while open or without a payout sum", () => {
    expect(predictionResult(row({ status: "locked" }), 600)).toBeNull();
    expect(predictionResult(row({ status: "active" }), 0)).toBeNull();
    expect(predictionResult(row(), null)).toBeNull();
  });

  test("the view carries the media lock, the resolver and the card", () => {
    const v = predictionView(row(), null, { resolvedBy: { id: uid(5), username: "mod" }, payoutSum: 600 });
    expect(v).toMatchObject({
      lockMediaTs: at(-100).toISOString(),
      resolvedBy: { id: uid(5), username: "mod" },
      result: { pool: 600, winners: 2, payoutSum: 600 },
    });
    // A resolver whose account was deleted (`resolved_by` set null) shows nobody.
    expect(
      predictionView(row({ resolvedById: null }), null, { resolvedBy: null, payoutSum: 600 }).resolvedBy,
    ).toBeNull();
    expect(predictionView(row({ status: "active", lockMediaTs: null }), null)).toMatchObject({
      lockMediaTs: null,
      resolvedBy: null,
      result: null,
    });
  });
});
