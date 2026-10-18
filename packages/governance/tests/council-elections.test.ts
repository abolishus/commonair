// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { seatCouncil, termWindow } from "../src/council.ts";
import { canStandInElection, canVoteInElection, tallyElection } from "../src/elections.ts";
import type { ContributionInput } from "../src/inputs.ts";
import { streamerEligible, viewerEligible } from "../src/membership.ts";
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { membershipClassesOf } from "../src/settings.ts";

const weights = { revenue: 0.5, streamingHours: 0.2, relayBandwidth: 0.2, viewerHours: 0.1 };
const config = { size: 3, eligibilityWindowDays: 90, minStreamingHours: 10 };
const c = (userId: string, o: Partial<ContributionInput> = {}): ContributionInput => ({
  userId,
  revenueCents: 0,
  eligibleHours: 20,
  relayBytes: 0,
  viewerHours: 0,
  ...o,
});

describe("seatCouncil", () => {
  test("worked example: scores are weighted shares of each component", () => {
    const seating = seatCouncil(
      [
        c("a", { revenueCents: 3000, eligibleHours: 50, relayBytes: 0, viewerHours: 10 }),
        c("b", { revenueCents: 1000, eligibleHours: 50, relayBytes: 1000, viewerHours: 30 }),
      ],
      config,
      weights,
    );
    // a: 0.5*0.75 + 0.2*0.5 + 0.2*0 + 0.1*0.25 = 0.5
    // b: 0.5*0.25 + 0.2*0.5 + 0.2*1 + 0.1*0.75 = 0.5  → tie; equal hours; user id breaks it
    expect(seating.seats.map((s) => s.userId)).toEqual(["a", "b"]);
    expect(seating.seats[0]!.contributionScore).toBeCloseTo(0.5, 12);
    expect(seating.seats[1]!.contributionScore).toBeCloseTo(0.5, 12);
    expect(seating.method.totals).toEqual({
      revenueCents: 4000,
      eligibleHours: 100,
      relayBytes: 1000,
      viewerHours: 40,
    });
  });

  test("candidates under the minimum streaming hours are not eligible and do not dilute shares", () => {
    const seating = seatCouncil(
      [c("rich", { revenueCents: 1_000_000, eligibleHours: 9.99 }), c("x", { revenueCents: 100 })],
      config,
      weights,
    );
    expect(seating.seats.map((s) => s.userId)).toEqual(["x"]);
    expect(seating.method.eligible).toBe(1);
    expect(seating.seats[0]!.contributionScore).toBeCloseTo(0.5 + 0.2, 12);
  });

  test("only the top `size` are seated, ranked from 1", () => {
    const seating = seatCouncil(
      ["a", "b", "c", "d", "e"].map((id, i) => c(id, { revenueCents: (i + 1) * 100 })),
      config,
      weights,
    );
    expect(seating.seats).toHaveLength(3);
    expect(seating.seats.map((s) => [s.userId, s.rank])).toEqual([
      ["e", 1],
      ["d", 2],
      ["c", 3],
    ]);
  });

  test("ties break by eligible hours, then user id, independent of input order", () => {
    const input = [c("m", { eligibleHours: 30 }), c("k", { eligibleHours: 30 }), c("z", { eligibleHours: 40 })];
    // Equal shares except hours; z has the most hours so it wins on score already.
    const a = seatCouncil(input, config, { ...weights, streamingHours: 0 });
    const b = seatCouncil([...input].reverse(), config, { ...weights, streamingHours: 0 });
    expect(a.seats.map((s) => s.userId)).toEqual(["z", "k", "m"]);
    expect(b.seats).toEqual(a.seats);
  });

  test("empty components contribute nothing; no candidates seats nobody", () => {
    expect(seatCouncil([], config, weights).seats).toEqual([]);
    const s = seatCouncil([c("a", { eligibleHours: 10 })], config, weights);
    expect(s.seats[0]!.contributionScore).toBeCloseTo(0.2, 12);
  });

  test("non-finite or negative inputs count as zero", () => {
    const s = seatCouncil([c("a", { revenueCents: Number.NaN, relayBytes: -5 }), c("b")], config, weights);
    expect(s.seats.every((x) => Number.isFinite(x.contributionScore))).toBe(true);
  });

  test("term window is the UTC calendar month", () => {
    expect(termWindow(new Date("2026-12-31T23:59:59Z"))).toEqual({
      startsAt: new Date("2026-12-01T00:00:00Z"),
      endsAt: new Date("2027-01-01T00:00:00Z"),
    });
  });
});

describe("tallyElection", () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const cand = (userId: string, minutes = 0) => ({ userId, nominatedAt: new Date(t0.getTime() + minutes * 60_000) });

  test("the seats with the most approvals win", () => {
    const r = tallyElection({
      seats: 2,
      candidates: [cand("a"), cand("b"), cand("c")],
      ballots: [
        { voterId: "1", candidateIds: ["a", "b"] },
        { voterId: "2", candidateIds: ["b"] },
        { voterId: "3", candidateIds: ["c", "b"] },
      ],
    });
    expect(r.results.map((x) => [x.userId, x.votes, x.elected])).toEqual([
      ["b", 3, true],
      ["a", 1, true],
      ["c", 1, false],
    ]);
    expect(r.ballotsCounted).toBe(3);
  });

  test("ties break by earlier nomination, then user id", () => {
    const r = tallyElection({
      seats: 1,
      candidates: [cand("z", 0), cand("a", 5), cand("b", 5)],
      ballots: [
        { voterId: "1", candidateIds: ["z", "a", "b"].slice(0, 1) },
        { voterId: "2", candidateIds: ["a"] },
      ],
    });
    expect(r.results.map((x) => x.userId)).toEqual(["z", "a", "b"]);
    const r2 = tallyElection({
      seats: 1,
      candidates: [cand("b", 5), cand("a", 5)],
      ballots: [
        { voterId: "1", candidateIds: ["a"] },
        { voterId: "2", candidateIds: ["b"] },
      ],
    });
    expect(r2.results[0]!.userId).toBe("a");
  });

  test("ballots over the seat limit, from ineligible voters, or repeated are spoiled", () => {
    const r = tallyElection({
      seats: 1,
      candidates: [cand("a"), cand("b")],
      eligibleVoters: new Set(["1", "2"]),
      ballots: [
        { voterId: "1", candidateIds: ["a", "b"] },
        { voterId: "2", candidateIds: ["b", "b", "ghost"] },
        { voterId: "2", candidateIds: ["a"] },
        { voterId: "3", candidateIds: ["a"] },
      ],
    });
    expect(r.spoiled).toEqual([
      { voterId: "1", reason: "too_many_approvals" },
      { voterId: "2", reason: "duplicate_ballot" },
      { voterId: "3", reason: "ineligible_voter" },
    ]);
    // Voter 2's duplicate approval of b counts once; "ghost" is not a candidate.
    expect(r.results[0]).toMatchObject({ userId: "b", votes: 1, elected: true });
    expect(r.ignoredApprovals).toBe(1);
  });

  test("candidates without approvals are never elected, even with open seats", () => {
    const r = tallyElection({
      seats: 3,
      candidates: [cand("a"), cand("b")],
      ballots: [{ voterId: "1", candidateIds: ["a"] }],
    });
    expect(r.results.filter((x) => x.elected).map((x) => x.userId)).toEqual(["a"]);
  });

  test("eligibility: voters and candidates must hold the election's class", () => {
    expect(canVoteInElection(["viewer", "streamer"], "streamer")).toBe(true);
    expect(canVoteInElection(["viewer"], "streamer")).toBe(false);
    expect(canStandInElection([], "worker")).toBe(false);
    expect(canStandInElection(["worker"], "worker")).toBe(true);
  });
});

describe("membership eligibility", () => {
  const rules = membershipClassesOf(Object.fromEntries(DEFAULT_GOVERNANCE_SETTINGS.map((s) => [s.key, s.value])));

  test("streamers need the minimum eligible hours", () => {
    expect(streamerEligible(10, rules)).toBe(true);
    expect(streamerEligible(9.999, rules)).toBe(false);
    expect(streamerEligible(Number.NaN, rules)).toBe(false);
  });

  test("viewers need a held share of the full amount or an active subscription", () => {
    expect(viewerEligible({ status: "held", amountCents: 500 }, false, rules)).toBe(true);
    expect(viewerEligible({ status: "held", amountCents: 499 }, false, rules)).toBe(false);
    expect(viewerEligible({ status: "pending", amountCents: 500 }, false, rules)).toBe(false);
    expect(viewerEligible({ status: "refunded", amountCents: 500 }, false, rules)).toBe(false);
    expect(viewerEligible(null, true, rules)).toBe(true);
    expect(viewerEligible(null, true, { viewer: { ...rules.viewer, activeSubscriptionQualifies: false } })).toBe(false);
    expect(viewerEligible(null, false, rules)).toBe(false);
  });
});
