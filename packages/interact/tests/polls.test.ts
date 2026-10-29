// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Poll views and payloads (pure). */
import { describe, expect, test } from "vite-plus/test";
import { EVENTS } from "@commonair/contracts/events";
import { pollEventPayload, pollProgressDue, pollView, type PollCounts, type PollRow } from "../src/polls.ts";

const channel = { id: "c0000000-0000-7000-8000-000000000000", ownerId: "o1", slug: "chan", displayName: "Chan" };
const at = new Date("2026-10-29T12:00:00Z");

function row(over: Partial<PollRow> = {}): PollRow {
  return {
    id: "a0000000-0000-7000-8000-000000000001",
    channelId: channel.id,
    title: "Best map?",
    choices: [
      { id: "x", title: "Ex", votes: 0 },
      { id: "y", title: "Why", votes: 0 },
      { id: "z", title: "Zed", votes: 0 },
    ],
    status: "active",
    durationSeconds: 20,
    pointsPerExtraVote: 0,
    createdById: null,
    startedAt: at,
    endsAt: new Date(at.getTime() + 20_000),
    endedAt: null,
    changedAt: null,
    progressAt: null,
    ...over,
  };
}

const counts: PollCounts = new Map([
  ["x", { votes: 5, bought: 3 }],
  ["y", { votes: 1, bought: 0 }],
]);

describe("pollEventPayload", () => {
  test("begin and progress validate; choices carry votes and the bought part; zeros for no votes", () => {
    for (const kind of ["begin", "progress"] as const) {
      const p = pollEventPayload(kind, channel, row({ pointsPerExtraVote: 25 }), counts);
      expect(EVENTS[`channel.poll.${kind}`].payload.safeParse(p).success).toBe(true);
      expect(p.choices).toEqual([
        { id: "x", title: "Ex", votes: 5, channel_points_votes: 3 },
        { id: "y", title: "Why", votes: 1, channel_points_votes: 0 },
        { id: "z", title: "Zed", votes: 0, channel_points_votes: 0 },
      ]);
      expect(p.channel_points_voting).toEqual({ is_enabled: true, amount_per_vote: 25 });
      expect(p).toMatchObject({
        broadcaster_user_id: "o1",
        broadcaster_user_login: "chan",
        ends_at: row().endsAt.toISOString(),
      });
    }
  });

  test("points voting is off when pointsPerExtraVote is 0", () => {
    expect(pollEventPayload("begin", channel, row(), counts).channel_points_voting).toEqual({
      is_enabled: false,
      amount_per_vote: 0,
    });
  });

  test("end validates for every ended status and refuses an active poll", () => {
    const endedAt = new Date(at.getTime() + 20_000);
    for (const status of ["completed", "terminated", "archived"] as const) {
      const p = pollEventPayload("end", channel, row({ status, endedAt }), counts);
      expect(EVENTS["channel.poll.end"].payload.safeParse(p).success).toBe(true);
      expect(p).toMatchObject({ status, ended_at: endedAt.toISOString() });
    }
    expect(() => pollEventPayload("end", channel, row(), counts)).toThrow(/ended poll/);
  });
});

describe("pollView", () => {
  test("counts from the map, the caller's vote, ISO timestamps", () => {
    const v = pollView(row(), counts, { choiceId: "x", votes: 4 });
    expect(v.choices.map((c) => c.votes)).toEqual([5, 1, 0]);
    expect(v).toMatchObject({ myVote: "x", myVotes: 4, endedAt: null, startedAt: at.toISOString() });
    expect(pollView(row(), new Map(), null)).toMatchObject({ myVote: null, myVotes: 0 });
  });
});

describe("pollProgressDue", () => {
  const t = (s: number) => new Date(at.getTime() + s * 1000);
  test("only after a change newer than the last progress (or the start)", () => {
    expect(pollProgressDue({ changedAt: null, progressAt: null, startedAt: at })).toBe(false);
    expect(pollProgressDue({ changedAt: t(1), progressAt: null, startedAt: at })).toBe(true);
    expect(pollProgressDue({ changedAt: t(1), progressAt: t(2), startedAt: at })).toBe(false);
    expect(pollProgressDue({ changedAt: t(3), progressAt: t(2), startedAt: at })).toBe(true);
    expect(pollProgressDue({ changedAt: t(2), progressAt: t(2), startedAt: at })).toBe(false);
  });
});
