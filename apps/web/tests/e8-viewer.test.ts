// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * E8-viewer pure logic: event-frame routing to the poll and prediction cards (malformed frames
 * dropped), the cards' state from frames, visibility, the bet bound, the raid follow decision,
 * the goals overlay's list and the chat overlay's lines.
 */
import { describe, expect, it } from "vite-plus/test";
import { interactErrorKey } from "../src/chat/interact/client.ts";
import {
  MAX_BET_POINTS,
  RESULTS_VISIBLE_MS,
  applyPollFrame,
  applyPredictionFrame,
  betAmount,
  parsePollFrame,
  parsePredictionFrame,
  pollVisible,
  predictionVisible,
  raidStep,
  routeEventFrame,
  type PollViewDto,
  type PredictionViewDto,
} from "../src/chat/interact/state.ts";
import {
  ACHIEVED_VISIBLE_MS,
  EMPTY_GOALS,
  goalValueText,
  goalsReducer,
  type GoalsState,
} from "../src/components/overlay-goals-page.tsx";
import {
  OVERLAY_CHAT_FADE_DURATION_MS,
  OVERLAY_CHAT_FADE_MS,
  OVERLAY_CHAT_MAX,
  isFading,
  overlayChatReducer,
  type OverlayChatLine,
} from "../src/components/overlay-chat-page.tsx";
import type { ChatMessageFrame } from "../src/chat/connection.ts";
import type { OverlayGoal } from "../src/lib/overlay-connection.ts";

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const POLL = UUID(1);
const PRED = UUID(2);
const broadcaster = {
  broadcaster_user_id: UUID(9),
  broadcaster_user_login: "rivertide",
  broadcaster_user_name: "Rivertide",
};
const choice = (id: string, votes: number) => ({ id, title: `Choice ${id}`, votes, channel_points_votes: 0 });
const pollBegin = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: POLL,
  title: "Which way?",
  choices: [choice("c1", 0), choice("c2", 0)],
  channel_points_voting: { is_enabled: true, amount_per_vote: 20 },
  started_at: "2026-10-29T12:00:00.000Z",
  ends_at: "2026-10-29T12:01:00.000Z",
  ...over,
});
const pollEnd = (over: Record<string, unknown> = {}) => {
  const { ends_at: _ends, ...rest } = pollBegin();
  return { ...rest, status: "completed", ended_at: "2026-10-29T12:01:00.000Z", ...over };
};
const outcome = (id: string, points: number, users: number) => ({
  id,
  title: `Outcome ${id}`,
  users,
  channel_points: points,
  top_predictors: [],
});
const predBegin = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: PRED,
  title: "Who wins?",
  outcomes: [outcome("o1", 0, 0), outcome("o2", 0, 0)],
  started_at: "2026-10-29T12:00:00.000Z",
  locks_at: "2026-10-29T12:02:00.000Z",
  ...over,
});
const predLock = (over: Record<string, unknown> = {}) => {
  const { locks_at: _l, ...rest } = predBegin();
  return { ...rest, locked_at: "2026-10-29T12:02:00.000Z", ...over };
};
const predEnd = (over: Record<string, unknown> = {}) => {
  const { locks_at: _l, ...rest } = predBegin();
  return { ...rest, winning_outcome_id: "o1", status: "resolved", ended_at: "2026-10-29T12:03:00.000Z", ...over };
};

const pollFrame = (type: string, data: unknown) => {
  const f = parsePollFrame(type, data);
  if (!f) throw new Error(`${type} did not parse`);
  return f;
};
const predFrame = (type: string, data: unknown) => {
  const f = parsePredictionFrame(type, data);
  if (!f) throw new Error(`${type} did not parse`);
  return f;
};

describe("routeEventFrame", () => {
  it("poll and prediction frames go to their cards", () => {
    expect(routeEventFrame("channel.poll.begin", pollBegin()).kind).toBe("poll");
    expect(routeEventFrame("channel.poll.progress", pollBegin()).kind).toBe("poll");
    expect(routeEventFrame("channel.poll.end", pollEnd()).kind).toBe("poll");
    expect(routeEventFrame("channel.prediction.begin", predBegin()).kind).toBe("prediction");
    expect(routeEventFrame("channel.prediction.progress", predBegin()).kind).toBe("prediction");
    expect(routeEventFrame("channel.prediction.lock", predLock()).kind).toBe("prediction");
    expect(routeEventFrame("channel.prediction.end", predEnd()).kind).toBe("prediction");
  });

  it("malformed card frames are dropped, never shown in the log", () => {
    expect(routeEventFrame("channel.poll.begin", { ...pollBegin(), choices: "no" }).kind).toBe("drop");
    expect(routeEventFrame("channel.poll.end", pollBegin()).kind).toBe("drop");
    expect(routeEventFrame("channel.prediction.lock", predBegin()).kind).toBe("drop");
    expect(routeEventFrame("channel.prediction.end", predEnd({ status: "maybe" })).kind).toBe("drop");
    expect(routeEventFrame("channel.prediction.begin", null).kind).toBe("drop");
  });

  it("everything else goes to the log's own view", () => {
    expect(routeEventFrame("channel.raid", {}).kind).toBe("row");
    expect(routeEventFrame("channel.tip", {}).kind).toBe("row");
    expect(routeEventFrame("channel.poll.unknown", pollBegin()).kind).toBe("row");
  });
});

describe("poll state from frames", () => {
  const view = (over: Partial<PollViewDto> = {}): PollViewDto => ({
    id: POLL,
    title: "Which way?",
    choices: [
      { id: "c1", title: "Choice c1", votes: 2 },
      { id: "c2", title: "Choice c2", votes: 1 },
    ],
    status: "active",
    startedAt: "2026-10-29T12:00:00.000Z",
    endsAt: "2026-10-29T12:01:00.000Z",
    endedAt: null,
    pointsPerExtraVote: 20,
    myVote: "c1",
    myVotes: 1,
    ...over,
  });

  it("begin: a fresh poll with no vote; points voting off means no extra votes", () => {
    const p = applyPollFrame(
      null,
      pollFrame("channel.poll.begin", pollBegin({ channel_points_voting: { is_enabled: false, amount_per_vote: 20 } })),
    );
    expect(p).toMatchObject({ id: POLL, status: "active", myVote: null, myVotes: 0, pointsPerExtraVote: 0 });
  });

  it("progress updates counts and keeps the viewer's vote", () => {
    const p = applyPollFrame(
      view(),
      pollFrame("channel.poll.progress", pollBegin({ choices: [choice("c1", 5), choice("c2", 3)] })),
    );
    expect(p.choices.map((c) => c.votes)).toEqual([5, 3]);
    expect([p.myVote, p.myVotes]).toEqual(["c1", 1]);
  });

  it("end switches to results with the final counts and keeps endsAt", () => {
    const p = applyPollFrame(
      view(),
      pollFrame("channel.poll.end", pollEnd({ choices: [choice("c1", 6), choice("c2", 3)] })),
    );
    expect(p).toMatchObject({
      status: "completed",
      endedAt: "2026-10-29T12:01:00.000Z",
      endsAt: "2026-10-29T12:01:00.000Z",
    });
    expect(p.choices.map((c) => c.votes)).toEqual([6, 3]);
  });

  it("a late progress cannot reopen an ended poll", () => {
    const ended = view({ status: "completed", endedAt: "2026-10-29T12:01:00.000Z" });
    expect(applyPollFrame(ended, pollFrame("channel.poll.progress", pollBegin()))).toBe(ended);
  });

  it("a frame for another poll replaces it and forgets the vote", () => {
    const p = applyPollFrame(view(), pollFrame("channel.poll.begin", pollBegin({ id: UUID(3) })));
    expect([p.id, p.myVote, p.myVotes]).toEqual([UUID(3), null, 0]);
  });

  it("visible while active and for a while after it ended, never once archived", () => {
    const end = Date.parse("2026-10-29T12:01:00.000Z");
    expect(pollVisible(null, end)).toBe(false);
    expect(pollVisible(view(), end + 10 * RESULTS_VISIBLE_MS)).toBe(true);
    const ended = view({ status: "terminated", endedAt: "2026-10-29T12:01:00.000Z" });
    expect(pollVisible(ended, end + RESULTS_VISIBLE_MS - 1)).toBe(true);
    expect(pollVisible(ended, end + RESULTS_VISIBLE_MS)).toBe(false);
    expect(pollVisible(view({ status: "archived", endedAt: "2026-10-29T12:01:00.000Z" }), end)).toBe(false);
  });
});

describe("prediction state from frames", () => {
  const view = (over: Partial<PredictionViewDto> = {}): PredictionViewDto => ({
    id: PRED,
    title: "Who wins?",
    outcomes: [
      { id: "o1", title: "Outcome o1", points: 100, users: 1 },
      { id: "o2", title: "Outcome o2", points: 0, users: 0 },
    ],
    status: "active",
    startedAt: "2026-10-29T12:00:00.000Z",
    locksAt: "2026-10-29T12:02:00.000Z",
    lockedAt: null,
    endedAt: null,
    winningOutcomeId: null,
    myBet: { outcomeId: "o1", points: 100, payout: null },
    ...over,
  });

  it("progress maps channel_points and users, keeping the viewer's bet", () => {
    const p = applyPredictionFrame(
      view(),
      predFrame("channel.prediction.progress", predBegin({ outcomes: [outcome("o1", 400, 2), outcome("o2", 200, 1)] })),
    );
    expect(p.outcomes.map((o) => [o.points, o.users])).toEqual([
      [400, 2],
      [200, 1],
    ]);
    expect(p.myBet).toEqual({ outcomeId: "o1", points: 100, payout: null });
  });

  it("lock → locked with lockedAt; end → resolved with the winner", () => {
    const locked = applyPredictionFrame(view(), predFrame("channel.prediction.lock", predLock()));
    expect([locked.status, locked.lockedAt, locked.locksAt]).toEqual([
      "locked",
      "2026-10-29T12:02:00.000Z",
      "2026-10-29T12:02:00.000Z",
    ]);
    const ended = applyPredictionFrame(locked, predFrame("channel.prediction.end", predEnd()));
    expect([ended.status, ended.winningOutcomeId, ended.lockedAt]).toEqual([
      "resolved",
      "o1",
      "2026-10-29T12:02:00.000Z",
    ]);
  });

  it("never moves back: a late progress after lock or end is ignored", () => {
    const locked = view({ status: "locked", lockedAt: "2026-10-29T12:02:00.000Z" });
    expect(applyPredictionFrame(locked, predFrame("channel.prediction.progress", predBegin()))).toBe(locked);
    const canceled = view({ status: "canceled", endedAt: "2026-10-29T12:03:00.000Z" });
    expect(applyPredictionFrame(canceled, predFrame("channel.prediction.lock", predLock()))).toBe(canceled);
  });

  it("a canceled end has no winner", () => {
    const p = applyPredictionFrame(
      null,
      predFrame("channel.prediction.end", predEnd({ status: "canceled", winning_outcome_id: null })),
    );
    expect([p.status, p.winningOutcomeId, p.myBet]).toEqual(["canceled", null, null]);
  });

  it("visible while active or locked, then for a while", () => {
    const end = Date.parse("2026-10-29T12:03:00.000Z");
    expect(predictionVisible(view({ status: "locked" }), end + 10 * RESULTS_VISIBLE_MS)).toBe(true);
    const done = view({ status: "resolved", endedAt: "2026-10-29T12:03:00.000Z" });
    expect(predictionVisible(done, end + 1)).toBe(true);
    expect(predictionVisible(done, end + RESULTS_VISIBLE_MS)).toBe(false);
  });
});

describe("betAmount", () => {
  it("a whole number from 1 to the smaller of the balance and 250,000", () => {
    expect(betAmount("1", 10)).toBe(1);
    expect(betAmount(" 10 ", 10)).toBe(10);
    expect(betAmount("11", 10)).toBeNull();
    expect(betAmount("0", 10)).toBeNull();
    expect(betAmount("", 10)).toBeNull();
    expect(betAmount("1.5", 10)).toBeNull();
    expect(betAmount("-3", 10)).toBeNull();
    expect(betAmount("1e3", 5000)).toBeNull();
    expect(betAmount(String(MAX_BET_POINTS), 1_000_000)).toBe(MAX_BET_POINTS);
    expect(betAmount(String(MAX_BET_POINTS + 1), 1_000_000)).toBeNull();
    expect(betAmount("1", 0)).toBeNull();
  });
});

describe("raidStep", () => {
  const frame = (status: "pending" | "completed" | "canceled", raidId = UUID(7)) => ({
    raidId,
    status,
    to: "mothwing",
    toDisplayName: "Mothwing",
    executeAt: "2026-10-29T12:00:30.000Z",
  });

  it("pending shows the banner; completed follows the raid and drops it", () => {
    const pending = raidStep(null, frame("pending"), false);
    expect(pending).toEqual({
      banner: { raidId: UUID(7), to: "mothwing", toDisplayName: "Mothwing", executeAt: "2026-10-29T12:00:30.000Z" },
      navigateTo: null,
    });
    expect(raidStep(pending.banner, frame("completed"), false)).toEqual({ banner: null, navigateTo: "mothwing" });
  });

  it("the broadcaster's own page never navigates", () => {
    expect(raidStep(null, frame("completed"), true)).toEqual({ banner: null, navigateTo: null });
  });

  it("canceled removes the banner of that raid only", () => {
    const banner = raidStep(null, frame("pending"), false).banner;
    expect(raidStep(banner, frame("canceled"), false)).toEqual({ banner: null, navigateTo: null });
    expect(raidStep(banner, frame("canceled", UUID(8)), false).banner).toBe(banner);
  });
});

describe("interactErrorKey", () => {
  const err = (code: string, requirement?: string) => Object.assign(new Error("x"), { code, data: { requirement } });
  it("maps refusals to the viewer's messages", () => {
    expect(interactErrorKey(err("PRECONDITION_FAILED", "insufficient_points"), "poll")).toBe("chatPoints.insufficient");
    expect(interactErrorKey(err("PRECONDITION_FAILED", "points_disabled"), "prediction")).toBe("chatPoints.disabled");
    expect(interactErrorKey(err("CONFLICT"), "poll")).toBe("chatPoll.error.closed");
    expect(interactErrorKey(err("CONFLICT"), "prediction")).toBe("chatPrediction.error.closed");
    expect(interactErrorKey(err("FORBIDDEN"), "prediction")).toBe("chatPrediction.error.staff");
    expect(interactErrorKey(err("UNAUTHORIZED"), "poll")).toBe("chatPoll.signIn");
    expect(interactErrorKey(err("TOO_MANY_REQUESTS"), "poll")).toBe("chatPoints.error.slowDown");
    expect(interactErrorKey(new Error("network"), "prediction")).toBe("chatPrediction.error.failed");
  });
});

describe("goalsReducer", () => {
  const goal = (n: number, over: Partial<OverlayGoal> = {}): OverlayGoal => ({
    id: UUID(100 + n),
    type: "followers",
    title: `Goal ${n}`,
    target: 2,
    current: 0,
    startedAt: "2026-10-29T12:00:00.000Z",
    endedAt: null,
    ...over,
  });
  const ids = (s: GoalsState) => s.goals.map((g) => g.id);

  it("loaded keeps the open goals of the state call", () => {
    const s = goalsReducer(EMPTY_GOALS, {
      type: "loaded",
      goals: [goal(1), goal(2, { endedAt: "2026-10-29T12:05:00.000Z" })],
    });
    expect(ids(s)).toEqual([UUID(101)]);
  });

  it("a goal frame updates in place or appends", () => {
    let s = goalsReducer(EMPTY_GOALS, { type: "loaded", goals: [goal(1), goal(2)] });
    s = goalsReducer(s, { type: "goal", goal: goal(1, { current: 1 }), now: 0 });
    expect(ids(s)).toEqual([UUID(101), UUID(102)]);
    expect(s.goals[0]?.current).toBe(1);
    s = goalsReducer(s, { type: "goal", goal: goal(3), now: 0 });
    expect(ids(s)).toEqual([UUID(101), UUID(102), UUID(103)]);
  });

  it("an achieved goal stays full for a moment, then leaves; an unachieved end leaves at once", () => {
    let s = goalsReducer(EMPTY_GOALS, { type: "loaded", goals: [goal(1), goal(2)] });
    s = goalsReducer(s, {
      type: "goal",
      goal: goal(1, { current: 2, endedAt: "2026-10-29T12:01:00.000Z" }),
      now: 1000,
    });
    expect(s.leaving).toEqual({ [UUID(101)]: 1000 + ACHIEVED_VISIBLE_MS });
    s = goalsReducer(s, {
      type: "goal",
      goal: goal(2, { current: 1, endedAt: "2026-10-29T12:01:00.000Z" }),
      now: 1000,
    });
    expect(ids(s)).toEqual([UUID(101)]);
    // A reconnect while it is leaving does not cut it short.
    s = goalsReducer(s, { type: "loaded", goals: [] });
    expect(ids(s)).toEqual([UUID(101)]);
    expect(goalsReducer(s, { type: "expire", now: 1000 + ACHIEVED_VISIBLE_MS - 1 })).toBe(s);
    s = goalsReducer(s, { type: "expire", now: 1000 + ACHIEVED_VISIBLE_MS });
    expect(s).toEqual(EMPTY_GOALS);
  });

  it("clear empties it", () => {
    const s = goalsReducer(EMPTY_GOALS, { type: "loaded", goals: [goal(1)] });
    expect(goalsReducer(s, { type: "clear" })).toEqual(EMPTY_GOALS);
  });

  it("tips goals format as money in the instance currency, counts as numbers", () => {
    expect(goalValueText(goal(1, { type: "tips", current: 1250, target: 5000 }), "usd", "en")).toBe("$12.50 / $50.00");
    expect(goalValueText(goal(1, { current: 1200, target: 2000 }), "usd", "en")).toBe("1,200 / 2,000");
  });
});

describe("overlayChatReducer", () => {
  const msg = (n: number, userId = UUID(500 + n)): ChatMessageFrame => ({
    id: UUID(n),
    channelId: UUID(999),
    user: { id: userId, username: `user${n}`, displayName: `User ${n}`, color: null, badges: [], accountType: "human" },
    body: `hello ${n}`,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  const add = (lines: OverlayChatLine[], n: number, now = 0, userId?: string) =>
    overlayChatReducer(lines, { type: "message", message: msg(n, userId), now });

  it("keeps the last 30 and ignores duplicates", () => {
    let lines: OverlayChatLine[] = [];
    for (let n = 1; n <= OVERLAY_CHAT_MAX + 5; n++) lines = add(lines, n);
    expect(lines).toHaveLength(OVERLAY_CHAT_MAX);
    expect(lines[0]?.message.id).toBe(UUID(6));
    expect(add(lines, OVERLAY_CHAT_MAX + 5)).toBe(lines);
  });

  it("delete, ban and clear remove at once", () => {
    let lines = add(add(add([], 1, 0, UUID(77)), 2), 3, 0, UUID(77));
    lines = overlayChatReducer(lines, { type: "delete", messageId: UUID(2) });
    expect(lines.map((l) => l.message.id)).toEqual([UUID(1), UUID(3)]);
    lines = overlayChatReducer(add(lines, 4), { type: "ban", userId: UUID(77) });
    expect(lines.map((l) => l.message.id)).toEqual([UUID(4)]);
    expect(overlayChatReducer(lines, { type: "clear" })).toEqual([]);
  });

  it("fades after a minute and is removed after the fade; with reduced motion, at the minute", () => {
    const lines = add([], 1, 0);
    const line = lines[0] as OverlayChatLine;
    expect(isFading(line, OVERLAY_CHAT_FADE_MS - 1)).toBe(false);
    expect(isFading(line, OVERLAY_CHAT_FADE_MS)).toBe(true);
    expect(overlayChatReducer(lines, { type: "expire", now: OVERLAY_CHAT_FADE_MS, reducedMotion: false })).toBe(lines);
    expect(
      overlayChatReducer(lines, {
        type: "expire",
        now: OVERLAY_CHAT_FADE_MS + OVERLAY_CHAT_FADE_DURATION_MS,
        reducedMotion: false,
      }),
    ).toEqual([]);
    expect(overlayChatReducer(lines, { type: "expire", now: OVERLAY_CHAT_FADE_MS, reducedMotion: true })).toEqual([]);
  });
});
