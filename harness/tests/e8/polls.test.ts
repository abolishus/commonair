// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of `interact` steps 1 and 2 (polls and predictions). */
import { describe, expect, test } from "vite-plus/test";
import { expectedVotes, pollOutboxProblems, POLL_VOTES, refusedWith, type OutboxRow } from "../../src/e8/polls.ts";
import { expectedPayouts, predictionEndProblems, PREDICTION_BETS } from "../../src/e8/predictions.ts";

describe("expectedVotes", () => {
  test("the scenario's votes are 2/1/0", () => {
    expect(expectedVotes(POLL_VOTES, 3)).toEqual([2, 1, 0]);
    expect(expectedVotes([], 2)).toEqual([0, 0]);
  });
});

describe("pollOutboxProblems", () => {
  const choices = (votes: number[]) => votes.map((v, i) => ({ id: `c${i}`, votes: v }));
  const rows = (end: Record<string, unknown>): OutboxRow[] => [
    { type: "channel.poll.begin", payload: { id: "p1" } },
    { type: "channel.poll.progress", payload: { id: "p1" } },
    { type: "channel.poll.end", payload: { id: "p1", ...end } },
    { type: "channel.poll.begin", payload: { id: "other" } },
  ];

  test("all present and matching: no problems", () => {
    expect(
      pollOutboxProblems(rows({ status: "completed", choices: choices([2, 1, 0]) }), "p1", {
        votes: [2, 1, 0],
        status: "completed",
      }),
    ).toEqual([]);
  });

  test("names a missing progress, a wrong status and wrong counts", () => {
    const r = rows({ status: "terminated", choices: choices([1, 1, 0]) }).filter(
      (x) => x.type !== "channel.poll.progress",
    );
    const problems = pollOutboxProblems(r, "p1", { votes: [2, 1, 0], status: "completed" });
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/progress/);
    expect(problems.join("\n")).toMatch(/status terminated/);
    expect(problems.join("\n")).toMatch(/1\/1\/0/);
  });

  test("a second end is a problem", () => {
    const r = rows({ status: "completed", choices: choices([2, 1, 0]) });
    r.push({ type: "channel.poll.end", payload: { id: "p1", status: "completed", choices: choices([2, 1, 0]) } });
    expect(pollOutboxProblems(r, "p1", { votes: [2, 1, 0], status: "completed" })).toEqual([
      "expected 1 channel.poll.end, got 2",
    ]);
  });
});

describe("refusedWith", () => {
  test("matches the oRPC code", () => {
    expect(refusedWith({ code: "CONFLICT", status: 409 }, "CONFLICT")).toBe(true);
    expect(refusedWith({ code: "FORBIDDEN" }, "CONFLICT")).toBe(false);
    expect(refusedWith(null, "CONFLICT")).toBe(false);
  });
});

describe("expectedPayouts", () => {
  const uid = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;
  const bets = PREDICTION_BETS.map(([outcome, points], i) => ({
    userId: uid(i + 1),
    outcomeId: `o${outcome}`,
    points,
  }));

  test("the scenario: 150 and 450, summing to the pool of 600", () => {
    const p = expectedPayouts(bets, "o0");
    expect([...p]).toEqual([
      [uid(1), 150],
      [uid(2), 450],
    ]);
    expect([...p.values()].reduce((s, x) => s + x, 0)).toBe(600);
  });

  test("nobody on the winner: no payouts (a refund)", () => {
    expect(expectedPayouts(bets, "o9").size).toBe(0);
  });

  test("ties go to the lower user id whatever the input order", () => {
    const p = expectedPayouts(
      [
        { userId: uid(9), outcomeId: "a", points: 1 },
        { userId: uid(2), outcomeId: "a", points: 1 },
        { userId: uid(5), outcomeId: "b", points: 3 },
      ],
      "a",
    );
    expect([...p]).toEqual([
      [uid(2), 3],
      [uid(9), 2],
    ]);
  });
});

describe("predictionEndProblems", () => {
  const end = (payload: Record<string, unknown>): OutboxRow[] => [
    { type: "channel.prediction.end", payload: { id: "q", ...payload } },
  ];
  const outcomes = [
    {
      top_predictors: [
        { user_id: "u2", channel_points_won: 450 },
        { user_id: "u1", channel_points_won: 150 },
      ],
    },
    { top_predictors: [{ user_id: "u3", channel_points_won: 0 }] },
  ];

  test("a matching resolved end", () => {
    expect(
      predictionEndProblems(end({ status: "resolved", winning_outcome_id: "A", outcomes }), "q", {
        status: "resolved",
        winningOutcomeId: "A",
        payouts: new Map([
          ["u1", 150],
          ["u2", 450],
        ]),
      }),
    ).toEqual([]);
  });

  test("wrong payout, status and winner are each named; a missing row too", () => {
    const problems = predictionEndProblems(end({ status: "canceled", winning_outcome_id: null, outcomes }), "q", {
      status: "resolved",
      winningOutcomeId: "A",
      payouts: new Map([["u1", 151]]),
    });
    expect(problems).toHaveLength(3);
    expect(predictionEndProblems([], "q", { status: "canceled", winningOutcomeId: null, payouts: new Map() })).toEqual([
      "expected 1 channel.prediction.end, got 0",
    ]);
  });
});
