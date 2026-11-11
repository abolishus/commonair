// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The chat panel's interactivity seams beyond the existing suites: the parsers' unknown-type
 * and malformed-payload edges, the out-of-order guards (poll, prediction, giveaway), visibility
 * at its window edges, `goalPercent` and `raidStep` boundaries; the browser client's calls and
 * every `interactErrorKey` branch; and `useChatInteract`'s join loads (a frame landing before
 * `current`, refusals, a channel switch dropping late answers), frame refreshes, points, raids
 * and the setters. Plus the pinned model's remaining state labels, the goal card without
 * progress, and the strip without items.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  browserInteractClient,
  interactErrorKey,
  isStaffRefusal,
  withPlayhead,
  type InteractClient,
} from "../src/chat/interact/client.ts";
import {
  POINTS_REFRESH_MS,
  RESULTS_VISIBLE_MS,
  applyGiveawayFrame,
  applyGoalFrame,
  applyPollFrame,
  applyPredictionFrame,
  betAmount,
  giveawayVisible,
  goalPercent,
  goalView,
  goalVisible,
  mergeLoadedGoals,
  parseGiveawayFrame,
  parseGoalFrame,
  parsePollFrame,
  parsePredictionFrame,
  pollVisible,
  predictionVisible,
  raidStep,
  type GiveawayDto,
  type GoalDto,
  type LoyaltyBalanceDto,
  type PollViewDto,
  type PredictionViewDto,
} from "../src/chat/interact/state.ts";
import { useChatInteract } from "../src/chat/interact/use-chat-interact.ts";
import { GoalCard } from "../src/chat/pinned/goal-card.tsx";
import {
  kindLabel,
  newsworthy,
  pinnedItems,
  pinnedPriority,
  stateLabel,
  type PinnedItem,
} from "../src/chat/pinned/model.ts";
import { PinnedStrip } from "../src/chat/pinned/strip.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const calls = vi.hoisted(() => ({ log: [] as [string, unknown][], giveawaysOn: true }));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const rec =
    (name: string, out: unknown = null) =>
    async (input: unknown) => {
      calls.log.push([name, input]);
      return out;
    };
  const client = {
    instance: { info: async () => ({ features: { giveaways: true } }) },
    interact: {
      polls: { current: rec("polls.current"), vote: rec("polls.vote") },
      predictions: { current: rec("predictions.current"), bet: rec("predictions.bet") },
      giveaways: { current: rec("giveaways.current"), enter: rec("giveaways.enter") },
      goals: { list: rec("goals.list", []) },
    },
    bot: { points: { balance: rec("points.balance") } },
  };
  // A second API client for an instance with giveaways off (the flag is cached per client).
  const off = { ...client, instance: { info: async () => ({ features: { giveaways: false } }) } };
  return {
    ...(await importOriginal<typeof import("../src/lib/api.ts")>()),
    api: () => (calls.giveawaysOn ? client : off),
  };
});

afterEach(() => {
  cleanup();
  calls.log.length = 0;
  calls.giveawaysOn = true;
  vi.useRealTimers();
});

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const POLL = UUID(1);
const PRED = UUID(2);
const GIVE = UUID(3);
const GOAL = UUID(4);
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
const outcome = (id: string) => ({ id, title: `Outcome ${id}`, users: 1, channel_points: 10, top_predictors: [] });
const predBegin = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: PRED,
  title: "Who wins?",
  outcomes: [outcome("o1"), outcome("o2")],
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
const giveBegin = () => ({
  ...broadcaster,
  id: GIVE,
  title: "Stickers",
  winner_count: 2,
  keyword: "!enter",
  seed_commitment: "a".repeat(64),
  started_at: "2026-11-01T12:00:00.000Z",
  closes_at: null,
});
const giveEnd = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: GIVE,
  title: "Stickers",
  status: "drawn",
  entries: 7,
  winners: 2,
  seed: "b".repeat(64),
  started_at: "2026-11-01T12:00:00.000Z",
  ended_at: "2026-11-01T12:10:00.000Z",
  ...over,
});
const goalFrame = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: GOAL,
  type: "followers",
  description: "100 followers",
  current_amount: 40,
  target_amount: 100,
  started_at: "2026-11-06T11:00:00.000Z",
  ...over,
});

const pollView = (over: Partial<PollViewDto> = {}): PollViewDto => ({
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
const predView = (over: Partial<PredictionViewDto> = {}): PredictionViewDto =>
  ({
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
    lockMediaTs: null,
    resolvedBy: null,
    result: null,
    ...over,
  }) as PredictionViewDto;
const giveaway = (over: Partial<GiveawayDto> = {}): GiveawayDto => ({
  id: GIVE,
  channelSlug: "rivertide",
  title: "Stickers",
  prize: "A sticker pack",
  winnerCount: 2,
  keyword: "!enter",
  status: "open",
  eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
  seedCommitment: "a".repeat(64),
  opensAt: "2026-11-01T12:00:00.000Z",
  closesAt: null,
  drawnAt: null,
  entries: 3,
  me: null,
  winners: [],
  ...over,
});
const goal = (over: Partial<GoalDto> = {}): GoalDto => ({
  id: GOAL,
  type: "followers",
  title: "100 followers",
  target: 100,
  current: 40,
  startedAt: "2026-11-06T11:00:00.000Z",
  endedAt: null,
  ...over,
});
const balance = (points: number, enabled = true): LoyaltyBalanceDto => ({
  channelSlug: "rivertide",
  user: { id: UUID(7), username: "viewer" },
  points,
  pointsName: "seeds",
  accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
  enabled,
});

function need<T>(v: T | null): T {
  if (v === null) throw new Error("expected a value");
  return v;
}

// ── state.ts edges ───────────────────────────────────────────────────────────────────────────

describe("frame parsers: unknown types and malformed payloads", () => {
  it("each parser answers null for a type it does not own", () => {
    expect(parsePollFrame("channel.poll.unknown", pollBegin())).toBeNull();
    expect(parsePredictionFrame("channel.prediction.unknown", predBegin())).toBeNull();
    expect(parseGiveawayFrame("channel.giveaway.unknown", giveBegin())).toBeNull();
    expect(parseGoalFrame("channel.goal.unknown", goalFrame())).toBeNull();
  });

  it("each parser answers null for a payload that does not validate", () => {
    expect(parsePollFrame("channel.poll.end", { id: POLL })).toBeNull();
    expect(parsePollFrame("channel.poll.progress", { id: POLL })).toBeNull();
    expect(parsePredictionFrame("channel.prediction.progress", { id: PRED })).toBeNull();
    expect(parsePredictionFrame("channel.prediction.lock", predBegin())).toBeNull();
    expect(parsePredictionFrame("channel.prediction.end", predBegin())).toBeNull();
    expect(parseGiveawayFrame("channel.giveaway.end", giveBegin())).toBeNull();
    expect(parseGoalFrame("channel.goal.end", goalFrame({ target_amount: 0 }))).toBeNull();
  });

  it("an ended poll frame without a prior poll takes its end time as endsAt", () => {
    const p = applyPollFrame(null, need(parsePollFrame("channel.poll.end", pollEnd())));
    expect(p.endsAt).toBe("2026-10-29T12:01:00.000Z");
    expect(p.myVote).toBeNull();
  });
});

describe("out-of-order guards and visibility edges", () => {
  it("a late begin never moves a locked or ended prediction back", () => {
    const locked = predView({ status: "locked", lockedAt: "2026-10-29T12:02:00.000Z" });
    expect(applyPredictionFrame(locked, need(parsePredictionFrame("channel.prediction.progress", predBegin())))).toBe(
      locked,
    );
    const resolved = predView({ status: "resolved", endedAt: "2026-10-29T12:03:00.000Z" });
    expect(applyPredictionFrame(resolved, need(parsePredictionFrame("channel.prediction.lock", predLock())))).toBe(
      resolved,
    );
  });

  it("a lock keeps the known lock time and what only `current` returned", () => {
    const cur = predView({ lockMediaTs: "2026-10-29T12:01:59.000Z", result: null });
    const locked = applyPredictionFrame(cur, need(parsePredictionFrame("channel.prediction.lock", predLock())));
    expect(locked).toMatchObject({
      status: "locked",
      locksAt: "2026-10-29T12:02:00.000Z",
      lockedAt: "2026-10-29T12:02:00.000Z",
      lockMediaTs: "2026-10-29T12:01:59.000Z",
      myBet: cur.myBet,
    });
    // A fresh prediction from an end frame: no lock time known, so locksAt falls back to the start.
    const fresh = applyPredictionFrame(null, need(parsePredictionFrame("channel.prediction.end", predEnd())));
    expect(fresh.locksAt).toBe("2026-10-29T12:00:00.000Z");
    expect(fresh.lockedAt).toBeNull();
  });

  it("prediction visibility: active and locked always; ended for RESULTS_VISIBLE_MS by endedAt, else locksAt", () => {
    const end = Date.parse("2026-10-29T12:03:00.000Z");
    expect(predictionVisible(null, end)).toBe(false);
    expect(predictionVisible(predView({ status: "locked" }), end * 2)).toBe(true);
    const ended = predView({ status: "canceled", endedAt: "2026-10-29T12:03:00.000Z" });
    expect(predictionVisible(ended, end + RESULTS_VISIBLE_MS - 1)).toBe(true);
    expect(predictionVisible(ended, end + RESULTS_VISIBLE_MS)).toBe(false);
    const noEnd = predView({ status: "resolved", endedAt: null });
    expect(predictionVisible(noEnd, Date.parse("2026-10-29T12:02:00.000Z") + 1)).toBe(true);
    expect(predictionVisible(predView({ status: "resolved", endedAt: "garbage" }), end)).toBe(false);
  });

  it("poll visibility falls back to endsAt when it has no end time, and hides an unparsable one", () => {
    const at = Date.parse("2026-10-29T12:01:00.000Z");
    expect(pollVisible(pollView({ status: "completed", endedAt: null }), at + 1)).toBe(true);
    expect(pollVisible(pollView({ status: "completed", endedAt: null, endsAt: "nope" }), at)).toBe(false);
  });

  it("a giveaway frame never moves it back, and changes nothing for another giveaway or a begin", () => {
    const drawn = giveaway({ status: "drawn", drawnAt: "2026-11-01T12:09:00.000Z" });
    const cancelEnd = need(parseGiveawayFrame("channel.giveaway.end", giveEnd({ status: "cancelled", seed: null })));
    // drawn and cancelled rank equal: the cancel applies, keeping the earlier draw time.
    expect(applyGiveawayFrame(drawn, cancelEnd)).toMatchObject({
      status: "cancelled",
      drawnAt: "2026-11-01T12:09:00.000Z",
    });
    const drawEnd = need(parseGiveawayFrame("channel.giveaway.end", giveEnd()));
    expect(applyGiveawayFrame(drawn, drawEnd)?.drawnAt).toBe("2026-11-01T12:09:00.000Z");
    const g = giveaway();
    expect(applyGiveawayFrame(g, need(parseGiveawayFrame("channel.giveaway.begin", giveBegin())))).toBe(g);
    expect(applyGiveawayFrame(giveaway({ id: UUID(30) }), drawEnd)?.status).toBe("open");
    expect(applyGiveawayFrame(null, drawEnd)).toBeNull();
    // A closed giveaway (awaiting the draw) moves on; an "open" end cannot exist, so ranks only rise.
    expect(applyGiveawayFrame(giveaway({ status: "closed" }), drawEnd)?.status).toBe("drawn");
  });

  it("giveaway visibility: open and closed always, drawn for the window, cancelled never", () => {
    const at = Date.parse("2026-11-01T12:10:00.000Z");
    expect(giveawayVisible(null, at)).toBe(false);
    expect(giveawayVisible(giveaway({ status: "closed" }), at)).toBe(true);
    expect(giveawayVisible(giveaway({ status: "cancelled" }), at)).toBe(false);
    const drawn = giveaway({ status: "drawn", drawnAt: "2026-11-01T12:10:00.000Z" });
    expect(giveawayVisible(drawn, at + RESULTS_VISIBLE_MS - 1)).toBe(true);
    expect(giveawayVisible(drawn, at + RESULTS_VISIBLE_MS)).toBe(false);
    expect(giveawayVisible(giveaway({ status: "drawn", drawnAt: null }), at)).toBe(false);
  });

  it("goals: percent clamps to 0..100 and is 0 for a zero target; an unparsable end hides the goal", () => {
    expect(goalPercent({ current: 50, target: 0 })).toBe(0);
    expect(goalPercent({ current: -5, target: 10 })).toBe(0);
    expect(goalPercent({ current: 250, target: 100 })).toBe(100);
    expect(goalPercent({ current: 1, target: 3 })).toBe(33);
    expect(goalVisible(goalView(goal({ endedAt: "nope" })), 0)).toBe(false);
    expect(goalView(goal({ endedAt: "2026-11-06T11:59:00.000Z", current: 99 })).achieved).toBe(false);
    expect(goalView(goal({ endedAt: "2026-11-06T11:59:00.000Z", current: 100 })).achieved).toBe(true);
  });

  it("goals with the same start sort by id; a listed goal a frame already touched keeps the frame's", () => {
    const a = goalView(goal({ id: UUID(51) }));
    const b = goalView(goal({ id: UUID(50) }));
    expect(
      mergeLoadedGoals([a], [goal({ id: UUID(50) }), goal({ id: UUID(51), current: 1 })]).map((g) => [g.id, g.current]),
    ).toEqual([
      [UUID(50), 40],
      [UUID(51), 40],
    ]);
    expect(applyGoalFrame([a], { type: "channel.goal.begin", goal: b }).map((g) => g.id)).toEqual([UUID(50), UUID(51)]);
  });

  it("bet amounts: whole numbers from 1 to the smaller of the balance and the cap", () => {
    expect(betAmount(" 5 ", 10)).toBe(5);
    expect(betAmount("0", 10)).toBeNull();
    expect(betAmount("11", 10)).toBeNull();
    expect(betAmount("1.5", 10)).toBeNull();
    expect(betAmount("1", -4)).toBeNull();
  });

  it("raids: a cancel for another raid keeps the banner; completed navigates viewers, never the broadcaster", () => {
    const banner = { raidId: "r1", to: "lumen", toDisplayName: "Lumen", executeAt: "2026-11-06T12:00:00.000Z" };
    const frame = (status: "pending" | "completed" | "canceled", raidId = "r1") => ({ ...banner, raidId, status });
    expect(raidStep(banner, frame("canceled", "r2"), false)).toEqual({ banner, navigateTo: null });
    expect(raidStep(banner, frame("canceled"), false)).toEqual({ banner: null, navigateTo: null });
    expect(raidStep(null, frame("canceled"), false)).toEqual({ banner: null, navigateTo: null });
    expect(raidStep(banner, frame("completed"), true)).toEqual({ banner: null, navigateTo: null });
    expect(raidStep(banner, frame("completed"), false)).toEqual({ banner: null, navigateTo: "lumen" });
  });
});

// ── client.ts ────────────────────────────────────────────────────────────────────────────────

describe("browserInteractClient", () => {
  it("routes each call to its API procedure with the channel", async () => {
    const c = browserInteractClient();
    await c.pollCurrent("rivertide");
    await c.vote({ id: POLL, choiceId: "c1", extraVotes: 2 });
    await c.predictionCurrent("rivertide");
    await c.bet({ id: PRED, outcomeId: "o1", points: 5 });
    await c.balance("rivertide", "viewer");
    await c.giveawayEnter({ id: GIVE });
    await c.goals?.("rivertide");
    expect(calls.log).toEqual([
      ["polls.current", { channel: "rivertide" }],
      ["polls.vote", { id: POLL, choiceId: "c1", extraVotes: 2 }],
      ["predictions.current", { channel: "rivertide" }],
      ["predictions.bet", { id: PRED, outcomeId: "o1", points: 5 }],
      ["points.balance", { channel: "rivertide", username: "viewer" }],
      ["giveaways.enter", { id: GIVE }],
      ["goals.list", { channel: "rivertide" }],
    ]);
  });

  it("asks for the current giveaway only while the instance has giveaways on", async () => {
    expect(await browserInteractClient().giveawayCurrent("rivertide")).toBeNull();
    expect(calls.log).toEqual([["giveaways.current", { channel: "rivertide" }]]);
    calls.log.length = 0;
    calls.giveawaysOn = false;
    expect(await browserInteractClient().giveawayCurrent("rivertide")).toBeNull();
    expect(calls.log).toEqual([]);
  });

  it("withPlayhead keeps a caller's own playhead, even an explicit null", async () => {
    const bet = vi.fn<InteractClient["bet"]>(async () => predView());
    const base = { bet } as unknown as InteractClient;
    const clock = { playheadWallclock: () => new Date(0), playbackMode: () => "dvr" as const };
    await withPlayhead(base, "rivertide", clock).bet({ id: PRED, outcomeId: "o1", points: 1, mediaTs: null });
    expect(bet.mock.calls[0]?.[0]).toMatchObject({ mediaTs: null, playbackMode: "dvr" });
    await withPlayhead(base, "rivertide", { ...clock, playheadWallclock: () => null }).bet({
      id: PRED,
      outcomeId: "o1",
      points: 1,
      playbackMode: "live",
    });
    expect(bet.mock.calls[1]?.[0]).toMatchObject({ mediaTs: null, playbackMode: "live" });
  });
});

describe("interactErrorKey", () => {
  const err = (code: string | null, data: Record<string, unknown> = {}) => ({ code, data });
  it("points requirements win over the code", () => {
    expect(interactErrorKey(err("PRECONDITION_FAILED", { requirement: "insufficient_points" }), "poll")).toBe(
      "chatPoints.insufficient",
    );
    expect(interactErrorKey(err("PRECONDITION_FAILED", { requirement: "points_disabled" }), "prediction")).toBe(
      "chatPoints.disabled",
    );
  });

  it("maps each code for polls and for predictions", () => {
    const cases: [string | null, string, string][] = [
      ["UNAUTHORIZED", "chatPoll.signIn", "chatPrediction.signIn"],
      ["FORBIDDEN", "chatPoll.error.forbidden", "chatPrediction.error.forbidden"],
      ["CONFLICT", "chatPoll.error.closed", "chatPrediction.error.closed"],
      ["TOO_MANY_REQUESTS", "chatPoints.error.slowDown", "chatPoints.error.slowDown"],
      ["INTERNAL_SERVER_ERROR", "chatPoll.error.failed", "chatPrediction.error.failed"],
      [null, "chatPoll.error.failed", "chatPrediction.error.failed"],
    ];
    for (const [code, poll, prediction] of cases) {
      expect(interactErrorKey(err(code), "poll")).toBe(poll);
      expect(interactErrorKey(err(code), "prediction")).toBe(prediction);
    }
    expect(interactErrorKey(new Error("x"), "poll")).toBe("chatPoll.error.failed");
  });

  it("only a staff reason on a refused bet earns the staff message", () => {
    const staff = err("FORBIDDEN", { reason: "staff" });
    expect(isStaffRefusal(staff)).toBe(true);
    expect(isStaffRefusal(err("FORBIDDEN", { reason: "banned" }))).toBe(false);
    expect(isStaffRefusal(err("CONFLICT", { reason: "staff" }))).toBe(false);
    expect(interactErrorKey(staff, "prediction")).toBe("chatPrediction.error.staff");
    expect(interactErrorKey(staff, "poll")).toBe("chatPoll.error.forbidden");
  });
});

// ── useChatInteract ──────────────────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClient(over: Partial<InteractClient> = {}) {
  const c = {
    pollCurrent: vi.fn<InteractClient["pollCurrent"]>(async () => null),
    vote: vi.fn<InteractClient["vote"]>(async () => pollView()),
    predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(async () => null),
    bet: vi.fn<InteractClient["bet"]>(async () => predView()),
    balance: vi.fn<InteractClient["balance"]>(async () => balance(10)),
    giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(async () => null),
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(async () => giveaway()),
  };
  return { ...c, ...over } as typeof c;
}

type HookProps = { channel: string; signedIn: boolean; self: string | null };
function hook(client: InteractClient, initial: Partial<HookProps> = {}, onFollowRaid = vi.fn<(to: string) => void>()) {
  const r = renderHook(
    (p: HookProps) =>
      useChatInteract({ channel: p.channel, signedIn: p.signedIn, selfUsername: p.self, client, onFollowRaid }),
    { initialProps: { channel: "rivertide", signedIn: false, self: null, ...initial } },
  );
  return { ...r, onFollowRaid };
}

describe("useChatInteract: join", () => {
  it("is loaded once all four calls settle, refusals included, and works without a goals call", async () => {
    const client = fakeClient({
      pollCurrent: vi.fn<InteractClient["pollCurrent"]>(async () => {
        throw new Error("down");
      }),
      predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(async () => {
        throw new Error("down");
      }),
      giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(async () => {
        throw new Error("down");
      }),
    });
    const { result } = hook(client);
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect([result.current.poll, result.current.prediction, result.current.giveaway]).toEqual([null, null, null]);
    expect(result.current.goals).toEqual([]);
  });

  it("a goals call that throws, or returns none, leaves the strip without goals", async () => {
    const throwing = fakeClient({
      goals: () => {
        throw new Error("sync failure");
      },
    });
    const a = hook(throwing);
    await waitFor(() => expect(a.result.current.loaded).toBe(true));
    expect(a.result.current.goals).toEqual([]);
    const empty = fakeClient({ goals: vi.fn<NonNullable<InteractClient["goals"]>>(async () => []) });
    const b = hook(empty);
    await waitFor(() => expect(b.result.current.loaded).toBe(true));
    expect(b.result.current.goals).toEqual([]);
  });

  it("a poll frame that lands before `current` keeps its counts and takes the viewer's vote", async () => {
    const poll = deferred<PollViewDto | null>();
    const client = fakeClient({ pollCurrent: vi.fn<InteractClient["pollCurrent"]>(() => poll.promise) });
    const { result } = hook(client);
    act(() => {
      result.current.onEvent(
        "channel.poll.progress",
        pollBegin({ ends_at: "2999-01-01T00:00:00.000Z", choices: [choice("c1", 9), choice("c2", 4)] }),
      );
    });
    expect(result.current.poll?.myVote).toBeNull();
    await act(async () => poll.resolve(pollView({ myVote: "c2", myVotes: 3, endsAt: "2999-01-01T00:00:00.000Z" })));
    expect(result.current.poll?.choices.map((c) => c.votes)).toEqual([9, 4]);
    expect([result.current.poll?.myVote, result.current.poll?.myVotes]).toEqual(["c2", 3]);
  });

  it("a `current` for another poll than the frame's keeps the frame's", async () => {
    const poll = deferred<PollViewDto | null>();
    const { result } = hook(fakeClient({ pollCurrent: vi.fn<InteractClient["pollCurrent"]>(() => poll.promise) }));
    act(() => {
      result.current.onEvent("channel.poll.begin", pollBegin({ id: UUID(60) }));
    });
    await act(async () => poll.resolve(pollView()));
    expect(result.current.poll?.id).toBe(UUID(60));
  });

  it("a prediction frame first keeps its status and takes the bet and result from `current`", async () => {
    const pred = deferred<PredictionViewDto | null>();
    const client = fakeClient({ predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(() => pred.promise) });
    const { result } = hook(client);
    act(() => {
      result.current.onEvent("channel.prediction.progress", predBegin());
    });
    expect(result.current.prediction?.myBet).toBeNull();
    await act(async () =>
      pred.resolve(predView({ status: "active", myBet: { outcomeId: "o2", points: 7, payout: null } })),
    );
    expect(result.current.prediction?.myBet).toEqual({ outcomeId: "o2", points: 7, payout: null });
    // Without a frame first, `current` is taken as is.
    const b = hook(
      fakeClient({
        predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(async () => predView({ id: UUID(61) })),
      }),
      {
        channel: "lumen",
      },
    );
    await waitFor(() => expect(b.result.current.prediction?.id).toBe(UUID(61)));
  });

  it("answers for a channel the panel left are dropped", async () => {
    const poll = deferred<PollViewDto | null>();
    const pred = deferred<PredictionViewDto | null>();
    const give = deferred<GiveawayDto | null>();
    const goals = deferred<GoalDto[]>();
    const client = fakeClient({
      pollCurrent: vi.fn<InteractClient["pollCurrent"]>((ch: string) =>
        ch === "rivertide" ? poll.promise : Promise.resolve(null),
      ),
      predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>((ch: string) =>
        ch === "rivertide" ? pred.promise : Promise.resolve(null),
      ),
      giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>((ch: string) =>
        ch === "rivertide" ? give.promise : Promise.resolve(null),
      ),
      goals: vi.fn<NonNullable<InteractClient["goals"]>>((ch: string) =>
        ch === "rivertide" ? goals.promise : Promise.resolve([]),
      ),
    });
    const { result, rerender } = hook(client);
    rerender({ channel: "lumen", signedIn: false, self: null });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      poll.resolve(pollView({ endsAt: "2999-01-01T00:00:00.000Z" }));
      pred.resolve(predView());
      give.resolve(giveaway());
      goals.resolve([goal()]);
    });
    expect([result.current.poll, result.current.prediction, result.current.giveaway]).toEqual([null, null, null]);
    expect(result.current.goals).toEqual([]);
  });
});

describe("useChatInteract: frames", () => {
  it("non-card frames go to the log", async () => {
    const { result } = hook(fakeClient());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    let handled = true;
    act(() => {
      handled = result.current.onEvent("channel.tip", {});
    });
    expect(handled).toBe(false);
  });

  it("a prediction end refetches `current` (the payout) and the points", async () => {
    const client = fakeClient({
      predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(async () => null),
      balance: vi.fn<InteractClient["balance"]>(async () => balance(10)),
    });
    const { result } = hook(client, { signedIn: true, self: "Viewer" });
    await waitFor(() => expect(result.current.points?.points).toBe(10));
    act(() => {
      result.current.onEvent("channel.prediction.begin", predBegin());
    });
    client.predictionCurrent.mockResolvedValueOnce(
      predView({ status: "resolved", endedAt: new Date().toISOString(), winningOutcomeId: "o1" }),
    );
    client.balance.mockResolvedValueOnce(balance(250));
    act(() => {
      result.current.onEvent("channel.prediction.end", predEnd({ ended_at: new Date().toISOString() }));
    });
    await waitFor(() => expect(result.current.points?.points).toBe(250));
    await waitFor(() => expect(result.current.prediction?.status).toBe("resolved"));
    expect(client.balance).toHaveBeenCalledWith("rivertide", "viewer");
  });

  it("a lock merges `current`'s lock media time under the frame's status", async () => {
    const client = fakeClient();
    const { result } = hook(client);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.onEvent("channel.prediction.begin", predBegin());
    });
    client.predictionCurrent.mockResolvedValueOnce(predView({ lockMediaTs: "2026-10-29T12:01:58.000Z" }));
    act(() => {
      result.current.onEvent("channel.prediction.lock", predLock());
    });
    await waitFor(() => expect(result.current.prediction?.lockMediaTs).toBe("2026-10-29T12:01:58.000Z"));
    expect(result.current.prediction?.status).toBe("locked");
  });

  it("a refused refresh after a prediction frame changes nothing", async () => {
    const client = fakeClient();
    const { result } = hook(client);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      result.current.onEvent("channel.prediction.begin", predBegin());
    });
    client.predictionCurrent.mockRejectedValueOnce(new Error("down"));
    act(() => {
      result.current.onEvent("channel.prediction.lock", predLock());
    });
    await waitFor(() => expect(client.predictionCurrent).toHaveBeenCalledTimes(2));
    expect(result.current.prediction?.status).toBe("locked");
  });

  it("a giveaway frame refetches `current`; a refusal keeps what the frame said", async () => {
    const client = fakeClient({ giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(async () => giveaway()) });
    const { result } = hook(client);
    await waitFor(() => expect(result.current.giveaway?.status).toBe("open"));
    client.giveawayCurrent.mockRejectedValueOnce(new Error("down"));
    act(() => {
      result.current.onEvent("channel.giveaway.end", giveEnd({ status: "cancelled", seed: null }));
    });
    await waitFor(() => expect(client.giveawayCurrent).toHaveBeenCalledTimes(2));
    // Cancelled giveaways are never pinned.
    expect(result.current.giveaway).toBeNull();
  });

  it("a giveaway refresh answering after a channel switch is dropped", async () => {
    const late = deferred<GiveawayDto | null>();
    const client = fakeClient();
    const { result, rerender } = hook(client);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    client.giveawayCurrent.mockReturnValueOnce(late.promise);
    act(() => {
      result.current.onEvent("channel.giveaway.begin", giveBegin());
    });
    rerender({ channel: "lumen", signedIn: false, self: null });
    await act(async () => late.resolve(giveaway()));
    expect(result.current.giveaway).toBeNull();
  });

  it("a prediction refresh answering after a channel switch is dropped", async () => {
    const late = deferred<PredictionViewDto | null>();
    const client = fakeClient();
    const { result, rerender } = hook(client);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    client.predictionCurrent.mockReturnValueOnce(late.promise);
    act(() => {
      result.current.onEvent("channel.prediction.end", predEnd());
    });
    rerender({ channel: "lumen", signedIn: false, self: null });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => late.resolve(predView({ id: UUID(70) })));
    expect(result.current.prediction?.id).not.toBe(UUID(70));
  });
});

describe("useChatInteract: points, raids and setters", () => {
  it("signed out: no balance asked and no chip; disabled points show no chip either", async () => {
    const client = fakeClient();
    const { result } = hook(client);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.refreshPoints());
    expect(client.balance).not.toHaveBeenCalled();
    expect(result.current.points).toBeNull();
    const off = fakeClient({ balance: vi.fn<InteractClient["balance"]>(async () => balance(5, false)) });
    const b = hook(off, { signedIn: true, self: "viewer" });
    await waitFor(() => expect(off.balance).toHaveBeenCalled());
    expect(b.result.current.points).toBeNull();
  });

  it("refreshes points every POINTS_REFRESH_MS; a refusal keeps the last balance", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = fakeClient({ balance: vi.fn<InteractClient["balance"]>(async () => balance(10)) });
    const { result } = hook(client, { signedIn: true, self: "viewer" });
    await waitFor(() => expect(result.current.points?.points).toBe(10));
    client.balance.mockRejectedValueOnce(new Error("down"));
    await act(async () => {
      vi.advanceTimersByTime(POINTS_REFRESH_MS);
    });
    expect(client.balance).toHaveBeenCalledTimes(2);
    expect(result.current.points?.points).toBe(10);
  });

  it("a balance answering after a channel switch is dropped, and the chip resets on the switch", async () => {
    const late = deferred<LoyaltyBalanceDto>();
    const client = fakeClient({ balance: vi.fn<InteractClient["balance"]>(() => late.promise) });
    const { result, rerender } = hook(client, { signedIn: true, self: "viewer" });
    client.balance.mockResolvedValue(balance(3));
    rerender({ channel: "lumen", signedIn: true, self: "viewer" });
    await waitFor(() => expect(result.current.points?.points).toBe(3));
    await act(async () => late.resolve(balance(999)));
    expect(result.current.points?.points).toBe(3);
  });

  it("a raid: pending shows the banner, completed follows it for a viewer", async () => {
    const { result, onFollowRaid } = hook(fakeClient(), { signedIn: true, self: "viewer" });
    const raid = { raidId: "r1", to: "lumen", toDisplayName: "Lumen", executeAt: "2026-11-06T12:00:00.000Z" };
    act(() => result.current.onRaid({ ...raid, status: "pending" } as never));
    expect(result.current.raid).toEqual(raid);
    act(() => result.current.onRaid({ ...raid, status: "completed" } as never));
    expect(result.current.raid).toBeNull();
    expect(onFollowRaid).toHaveBeenCalledWith("lumen");
  });

  it("the broadcaster's own page (any case) never follows its raid", async () => {
    const { result, onFollowRaid } = hook(fakeClient(), { signedIn: true, self: "RiverTide" });
    const raid = { raidId: "r1", to: "lumen", toDisplayName: "Lumen", executeAt: "2026-11-06T12:00:00.000Z" };
    act(() => result.current.onRaid({ ...raid, status: "completed" } as never));
    expect(onFollowRaid).not.toHaveBeenCalled();
  });

  it("setPoll, setPrediction and setGiveaway replace what is shown", async () => {
    const { result } = hook(fakeClient());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.setPoll(pollView({ endsAt: "2999-01-01T00:00:00.000Z", myVote: "c2" })));
    act(() => result.current.setPrediction(predView({ title: "Mine" })));
    act(() => result.current.setGiveaway(giveaway({ entries: 9 })));
    expect(result.current.poll?.myVote).toBe("c2");
    expect(result.current.prediction?.title).toBe("Mine");
    expect(result.current.giveaway?.entries).toBe(9);
  });

  it("an ended poll leaves once RESULTS_VISIBLE_MS has passed (the results tick)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = hook(fakeClient());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const endedAt = new Date().toISOString();
    act(() => result.current.setPoll(pollView({ status: "completed", endedAt })));
    expect(result.current.poll).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(RESULTS_VISIBLE_MS + 5_000);
    });
    expect(result.current.poll).toBeNull();
  });
});

// ── pinned model, goal card, strip ───────────────────────────────────────────────────────────

describe("pinned model labels", () => {
  const base = { endsAt: null, progress: null };
  it("names every phase", () => {
    expect(stateLabel({ ...base, state: { phase: "locked" } })).toBe(t("chat.strip.state.locked"));
    expect(stateLabel({ ...base, state: { phase: "won", by: "Alpha" } })).toBe(
      t("chat.strip.state.won", { name: "Alpha" }),
    );
    expect(stateLabel({ ...base, state: { phase: "ended" } })).toBe(t("chat.strip.state.ended"));
    expect(stateLabel({ ...base, state: { phase: "canceled" } })).toBe(t("chat.strip.state.canceled"));
    expect(stateLabel({ ...base, state: { phase: "closed" } })).toBe(t("chat.strip.state.closed"));
    expect(stateLabel({ ...base, state: { phase: "drawn" } })).toBe(t("chat.strip.state.drawn"));
    expect(stateLabel({ ...base, state: { phase: "achieved" } })).toBe(t("chat.strip.state.achieved"));
  });

  it("an open item counts down only with a clock and a future deadline", () => {
    const open = { state: { phase: "open" as const }, endsAt: 10_000, progress: null };
    expect(stateLabel(open)).toBe(t("chat.strip.state.open"));
    expect(stateLabel(open, 10_000)).toBe(t("chat.strip.state.open"));
    expect(stateLabel({ ...open, endsAt: null }, 0)).toBe(t("chat.strip.state.open"));
    expect(stateLabel(open, 9_000)).not.toBe(t("chat.strip.state.open"));
  });

  it("items: canceled predictions, closed and drawn and canceled giveaways, unparsable deadlines", () => {
    const items = pinnedItems({
      prediction: predView({ status: "canceled" }),
      poll: pollView({ endsAt: "nope" }),
      giveaway: giveaway({ status: "closed" }),
    });
    expect(items.map((i) => [i.kind, i.state.phase, i.endsAt])).toEqual([
      ["poll", "open", null],
      ["prediction", "canceled", null],
      ["giveaway", "closed", null],
    ]);
    expect(pinnedItems({ prediction: null, poll: null, giveaway: giveaway({ status: "drawn" }) })[0]?.state).toEqual({
      phase: "drawn",
    });
    expect(
      pinnedItems({ prediction: null, poll: null, giveaway: giveaway({ status: "cancelled" }) })[0]?.state,
    ).toEqual({ phase: "canceled" });
    // A resolved prediction whose winner is not among its outcomes: ended, no name.
    expect(
      pinnedItems({
        prediction: predView({ status: "resolved", winningOutcomeId: "zz" }),
        poll: null,
        giveaway: null,
      })[0]?.state,
    ).toEqual({ phase: "ended" });
  });

  it("a poll tie or a poll with no votes has no winner", () => {
    const tied = pollView({
      status: "completed",
      choices: [
        { id: "c1", title: "A", votes: 2 },
        { id: "c2", title: "B", votes: 2 },
      ],
    });
    expect(pinnedItems({ prediction: null, poll: tied, giveaway: null })[0]?.state).toEqual({ phase: "ended" });
    const none = pollView({ status: "completed", choices: [{ id: "c1", title: "A", votes: 0 }] });
    expect(pinnedItems({ prediction: null, poll: none, giveaway: null })[0]?.state).toEqual({ phase: "ended" });
    const clear = pollView({
      status: "completed",
      choices: [
        { id: "c1", title: "A", votes: 1 },
        { id: "c2", title: "B", votes: 3 },
      ],
    });
    expect(pinnedItems({ prediction: null, poll: clear, giveaway: null })[0]?.state).toEqual({ phase: "won", by: "B" });
  });

  it("priority: open first by kind, then the rest by kind; newsworthy ignores the first render", () => {
    expect(pinnedPriority({ kind: "goal", state: { phase: "open" } })).toBeLessThan(
      pinnedPriority({ kind: "prediction", state: { phase: "locked" } }),
    );
    const items = pinnedItems({
      prediction: null,
      poll: pollView({ endsAt: "2999-01-01T00:00:00.000Z" }),
      giveaway: null,
    });
    expect(newsworthy(null, items)).toBeNull();
    expect(newsworthy(new Set(items.map((i) => i.key)), items)).toBeNull();
    expect(newsworthy(new Set(), items)).toBe(items[0]);
    expect(kindLabel("giveaway")).toBe(t("chat.strip.kind.giveaway"));
  });
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

describe("GoalCard and PinnedStrip edges", () => {
  it("a goal card without the item's progress labels the goal's own numbers; an ended one shows its state", () => {
    const g = goalView(goal({ endedAt: "2026-11-06T11:59:00.000Z", current: 100 }));
    const item: PinnedItem = {
      kind: "goal",
      id: g.id,
      slot: `goal:${g.id}`,
      key: `goal:${g.id}:achieved`,
      title: g.title,
      state: { phase: "achieved" },
      endsAt: null,
      progress: null,
    };
    wrap(<GoalCard goal={g} item={item} />);
    const card = screen.getByTestId("chat-goal");
    expect(card.dataset.state).toBe("achieved");
    expect(card.textContent).toContain(t("chat.strip.state.achieved"));
    expect(card.textContent).toContain(t("chat.strip.goal.progress", { current: "100", target: "100" }));
  });

  it("only Escape folds the expanded strip, and not when a card already handled it", () => {
    const items = pinnedItems({
      prediction: null,
      poll: pollView({ endsAt: "2999-01-01T00:00:00.000Z" }),
      giveaway: null,
    });
    wrap(
      <PinnedStrip
        items={items}
        renderCard={() => <input data-testid="card-field" />}
        onDismiss={() => {}}
        now={() => 0}
      />,
    );
    const strip = screen.getByTestId("chat-pinned-strip");
    const toggle = strip.querySelector<HTMLButtonElement>('[data-part="toggle"]');
    if (!toggle) throw new Error("no toggle");
    act(() => toggle.click());
    expect(strip.dataset.expanded).toBe("true");
    const field = screen.getByTestId("card-field");
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(strip.dataset.expanded).toBe("true");
    act(() => {
      const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      handled.preventDefault();
      field.dispatchEvent(handled);
    });
    expect(strip.dataset.expanded).toBe("true");
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(strip.dataset.expanded).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("a strip with no items renders only the (empty) card region", () => {
    wrap(<PinnedStrip items={[]} renderCard={() => null} onDismiss={() => {}} />);
    const strip = screen.getByTestId("chat-pinned-strip");
    expect(strip.dataset.count).toBe("0");
    expect(strip.dataset.kind).toBeUndefined();
    expect(strip.querySelector('[data-part="toggle"]')).toBeNull();
  });
});
