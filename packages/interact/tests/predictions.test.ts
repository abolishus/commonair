// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Prediction payouts, totals and payloads (pure; ADR 0026 decision 3). */
import { describe, expect, test } from "vite-plus/test";
import { EVENTS } from "@commonair/contracts/events";
import {
  predictionEventPayload,
  predictionPayouts,
  predictionView,
  summarizeBets,
  TOP_PREDICTORS,
  type PredictionBet,
  type PredictionRow,
} from "../src/predictions.ts";

const channel = { id: "c0000000-0000-7000-8000-000000000000", ownerId: "o1", slug: "chan", displayName: "Chan" };
const uid = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const bet = (n: number, outcomeId: string, points: number, payout: number | null = null): PredictionBet => ({
  userId: uid(n),
  username: `u${n}`,
  name: `User ${n}`,
  outcomeId,
  points,
  payout,
});

function row(over: Partial<PredictionRow> = {}): PredictionRow {
  const at = new Date("2026-10-29T12:00:00Z");
  return {
    id: "p0000000-0000-7000-8000-000000000001",
    channelId: channel.id,
    title: "Who wins?",
    outcomes: [
      { id: "A", title: "Alpha", points: 0, users: 0 },
      { id: "B", title: "Beta", points: 0, users: 0 },
    ],
    status: "active",
    windowSeconds: 60,
    winningOutcomeId: null,
    createdById: null,
    startedAt: at,
    locksAt: new Date(at.getTime() + 60_000),
    lockedAt: null,
    resolvedAt: null,
    changedAt: null,
    progressAt: null,
    ...over,
  };
}

/** A small deterministic PRNG so the random cases are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 2 ** 32;
  };
}

describe("predictionPayouts", () => {
  test("the scenario's split: 100 + 300 on A, 200 on B, A wins → 150 and 450", () => {
    const bets = [bet(1, "A", 100), bet(2, "A", 300), bet(3, "B", 200)];
    expect(predictionPayouts(bets, "A")).toEqual([
      { userId: uid(1), payout: 150 },
      { userId: uid(2), payout: 450 },
    ]);
  });

  test("random stakes always sum to the pool", () => {
    const next = rng(42);
    for (let round = 0; round < 500; round++) {
      const n = 1 + Math.floor(next() * 30);
      const bets = Array.from({ length: n }, (_, i) =>
        bet(i + 1, next() < 0.4 ? "A" : next() < 0.5 ? "B" : "C", 1 + Math.floor(next() * 250_000)),
      );
      const pool = bets.reduce((s, b) => s + b.points, 0);
      for (const winner of ["A", "B", "C"]) {
        const payouts = predictionPayouts(bets, winner);
        const onWinner = bets.filter((b) => b.outcomeId === winner);
        // Nobody on the winner pays nothing (a refund); otherwise the parts sum to the pool.
        expect(payouts.reduce((s, p) => s + p.payout, 0)).toBe(onWinner.length === 0 ? 0 : pool);
        expect(payouts.length).toBe(onWinner.length);
        expect(payouts.every((p) => p.payout >= 0)).toBe(true);
      }
    }
  });

  test("one winner takes the whole pool", () => {
    expect(predictionPayouts([bet(1, "A", 7), bet(2, "B", 500), bet(3, "B", 1)], "A")).toEqual([
      { userId: uid(1), payout: 508 },
    ]);
  });

  test("everyone on the winner: each gets their stake back", () => {
    const bets = [bet(3, "A", 30), bet(1, "A", 10), bet(2, "A", 20)];
    expect(predictionPayouts(bets, "A")).toEqual([
      { userId: uid(1), payout: 10 },
      { userId: uid(2), payout: 20 },
      { userId: uid(3), payout: 30 },
    ]);
  });

  test("a tie in the remainder goes to the lower user id, whatever the input order", () => {
    // A pool of 5 over two equal stakes: 2.5 each, the leftover point goes to the lower id.
    const bets = [bet(9, "A", 1), bet(2, "A", 1), bet(5, "B", 3)];
    expect(predictionPayouts(bets, "A")).toEqual([
      { userId: uid(2), payout: 3 },
      { userId: uid(9), payout: 2 },
    ]);
  });

  test("nobody on the winner: no payouts (the caller refunds)", () => {
    expect(predictionPayouts([bet(1, "A", 10)], "B")).toEqual([]);
  });

  test("a zero stake is never paid", () => {
    const payouts = predictionPayouts([bet(1, "A", 0), bet(2, "A", 5), bet(3, "B", 6)], "A");
    expect(payouts).toEqual([
      { userId: uid(1), payout: 0 },
      { userId: uid(2), payout: 11 },
    ]);
  });
});

describe("summarizeBets", () => {
  test("totals per outcome; top predictors by points then user id, capped at 10", () => {
    const bets = [...Array.from({ length: 12 }, (_, i) => bet(20 - i, "A", i < 4 ? 50 : 10)), bet(30, "B", 5)];
    const totals = summarizeBets(bets);
    const a = totals.get("A");
    expect(a?.users).toBe(12);
    expect(a?.points).toBe(4 * 50 + 8 * 10);
    expect(a?.top).toHaveLength(TOP_PREDICTORS);
    // The four 50s first in user-id order (17..20), then the 10s from the lowest id up.
    expect(a?.top.map((b) => b.userId)).toEqual([17, 18, 19, 20, 9, 10, 11, 12, 13, 14].map(uid));
    expect(totals.get("B")).toEqual({ points: 5, users: 1, top: [bet(30, "B", 5)] });
    expect(totals.get("C")).toBeUndefined();
  });

  test("no bets: an empty map", () => {
    expect(summarizeBets([]).size).toBe(0);
  });
});

describe("prediction payloads validate against the catalog", () => {
  const totals = summarizeBets([bet(1, "A", 100, 150), bet(2, "B", 50, 0)]);

  test("begin and progress carry locks_at and no winnings", () => {
    for (const kind of ["begin", "progress"] as const) {
      const p = predictionEventPayload(kind, channel, row(), totals);
      expect(EVENTS[`channel.prediction.${kind}`].payload.safeParse(p).success).toBe(true);
      expect(p.outcomes[0]?.top_predictors[0]?.channel_points_won).toBeNull();
      expect(p.outcomes[1]).toMatchObject({ id: "B", users: 1, channel_points: 50 });
    }
  });

  test("an outcome nobody bet on has zero totals and no predictors", () => {
    const p = predictionEventPayload("begin", channel, row(), new Map());
    expect(p.outcomes).toEqual([
      { id: "A", title: "Alpha", users: 0, channel_points: 0, top_predictors: [] },
      { id: "B", title: "Beta", users: 0, channel_points: 0, top_predictors: [] },
    ]);
  });

  test("lock carries locked_at", () => {
    const lockedAt = new Date("2026-10-29T12:00:30Z");
    const p = predictionEventPayload("lock", channel, row({ status: "locked", lockedAt }), totals);
    expect(EVENTS["channel.prediction.lock"].payload.safeParse(p).success).toBe(true);
    expect(p.locked_at).toBe(lockedAt.toISOString());
    expect(() => predictionEventPayload("lock", channel, row(), totals)).toThrow(/lockedAt/);
  });

  test("end: resolved fills channel_points_won (0 for a loss); canceled leaves it null", () => {
    const resolvedAt = new Date("2026-10-29T12:01:00Z");
    const resolved = predictionEventPayload(
      "end",
      channel,
      row({ status: "resolved", winningOutcomeId: "A", resolvedAt }),
      totals,
    );
    expect(EVENTS["channel.prediction.end"].payload.safeParse(resolved).success).toBe(true);
    expect(resolved).toMatchObject({ status: "resolved", winning_outcome_id: "A", ended_at: resolvedAt.toISOString() });
    expect(resolved.outcomes.map((o) => o.top_predictors[0]?.channel_points_won)).toEqual([150, 0]);

    const canceled = predictionEventPayload("end", channel, row({ status: "canceled", resolvedAt }), totals);
    expect(EVENTS["channel.prediction.end"].payload.safeParse(canceled).success).toBe(true);
    expect(canceled.winning_outcome_id).toBeNull();
    expect(canceled.outcomes[0]?.top_predictors[0]?.channel_points_won).toBeNull();
    expect(() => predictionEventPayload("end", channel, row({ status: "locked" }), totals)).toThrow(
      /settled prediction/,
    );
  });
});

describe("predictionView", () => {
  test("maps resolvedAt to endedAt and the caller's bet", () => {
    const resolvedAt = new Date("2026-10-29T12:01:00Z");
    const v = predictionView(row({ status: "resolved", winningOutcomeId: "A", resolvedAt }), {
      outcomeId: "A",
      points: 100,
      payout: 150,
    });
    expect(v).toMatchObject({
      status: "resolved",
      endedAt: resolvedAt.toISOString(),
      lockedAt: null,
      winningOutcomeId: "A",
      myBet: { outcomeId: "A", points: 100, payout: 150 },
    });
    expect(predictionView(row(), null).myBet).toBeNull();
  });
});
