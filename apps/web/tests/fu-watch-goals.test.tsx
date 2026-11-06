// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Goals in the chat's pinned strip: the `channel.goal.*` frames (validated, invalid ones dropped),
 * the goal list merged under frames, a late frame never reopening an ended goal, visibility for
 * RESULTS_VISIBLE_MS after the end, the pinned items (priority after a giveaway, achieved/ended
 * labels, a dismissal that holds while the goal fills), the strip's line and bar, the goal card,
 * and the hook loading the list once per join.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { InteractClient } from "../src/chat/interact/client.ts";
import {
  RESULTS_VISIBLE_MS,
  applyGoalFrame,
  goalPercent,
  goalView,
  goalVisible,
  mergeLoadedGoals,
  parseGoalFrame,
  routeEventFrame,
  type GiveawayDto,
  type GoalDto,
  type GoalView,
} from "../src/chat/interact/state.ts";
import { useChatInteract } from "../src/chat/interact/use-chat-interact.ts";
import { GoalCard } from "../src/chat/pinned/goal-card.tsx";
import {
  DISMISS_KEYS,
  announcement,
  pinnedItems,
  pinnedPriority,
  progressLabel,
  stateLabel,
  undismissed,
} from "../src/chat/pinned/model.ts";
import { PinnedStrip } from "../src/chat/pinned/strip.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(() => cleanup());

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const GOAL = UUID(40);
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const broadcaster = {
  broadcaster_user_id: UUID(1),
  broadcaster_user_login: "rivertide",
  broadcaster_user_name: "Rivertide",
};

const frame = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  id: GOAL,
  type: "followers",
  description: "100 followers",
  current_amount: 40,
  target_amount: 100,
  started_at: "2026-11-06T11:00:00.000Z",
  ...over,
});
const endFrame = (over: Record<string, unknown> = {}) =>
  frame({ is_achieved: true, current_amount: 100, ended_at: "2026-11-06T11:59:00.000Z", ...over });

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

const giveaway = (): GiveawayDto => ({
  id: UUID(3),
  channelSlug: "rivertide",
  title: "Stickers",
  prize: "A sticker pack",
  winnerCount: 1,
  keyword: null,
  status: "open",
  eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
  seedCommitment: "a".repeat(64),
  opensAt: "2026-11-06T11:00:00.000Z",
  closesAt: null,
  drawnAt: null,
  entries: 3,
  me: null,
  winners: [],
});

describe("goal frames (pure)", () => {
  it("routes the three goal frames to the strip and drops ones that do not validate", () => {
    expect(routeEventFrame("channel.goal.begin", frame()).kind).toBe("goal");
    expect(routeEventFrame("channel.goal.progress", frame()).kind).toBe("goal");
    expect(routeEventFrame("channel.goal.end", endFrame()).kind).toBe("goal");
    expect(routeEventFrame("channel.goal.progress", { id: GOAL }).kind).toBe("drop");
    expect(routeEventFrame("channel.goal.end", frame()).kind).toBe("drop");
    expect(routeEventFrame("channel.goal.begin", frame({ type: "bits" })).kind).toBe("drop");
    // A zero target would divide by zero in the bar: not a goal.
    expect(parseGoalFrame("channel.goal.begin", frame({ target_amount: 0 }))).toBeNull();
    expect(parseGoalFrame("channel.goal.unknown", frame())).toBeNull();
  });

  it("maps a frame's fields onto the Goal shape", () => {
    expect(parseGoalFrame("channel.goal.progress", frame())?.goal).toEqual({
      ...goal(),
      achieved: null,
    });
    expect(parseGoalFrame("channel.goal.end", endFrame({ is_achieved: false, current_amount: 60 }))?.goal).toEqual({
      ...goal({ current: 60, endedAt: "2026-11-06T11:59:00.000Z" }),
      achieved: false,
    });
  });

  it("adds, replaces, and never reopens an ended goal", () => {
    const begin = parseGoalFrame("channel.goal.begin", frame({ current_amount: 0 }));
    const progress = parseGoalFrame("channel.goal.progress", frame({ current_amount: 70 }));
    const end = parseGoalFrame("channel.goal.end", endFrame());
    if (!begin || !progress || !end) throw new Error("frames");
    let goals = applyGoalFrame([], begin);
    expect(goals.map((g) => g.current)).toEqual([0]);
    goals = applyGoalFrame(goals, progress);
    expect(goals.map((g) => g.current)).toEqual([70]);
    goals = applyGoalFrame(goals, end);
    expect(goals[0]?.endedAt).not.toBeNull();
    expect(applyGoalFrame(goals, progress)).toEqual(goals);
  });

  it("keeps goals oldest first", () => {
    const later = parseGoalFrame("channel.goal.begin", frame({ id: UUID(41), started_at: "2026-11-06T11:30:00.000Z" }));
    const first = parseGoalFrame("channel.goal.begin", frame());
    if (!later || !first) throw new Error("frames");
    expect(applyGoalFrame(applyGoalFrame([], later), first).map((g) => g.id)).toEqual([GOAL, UUID(41)]);
  });

  it("merges the list under what frames already said", () => {
    const fromFrame = parseGoalFrame("channel.goal.progress", frame({ current_amount: 80 }))?.goal;
    if (!fromFrame) throw new Error("frame");
    const merged = mergeLoadedGoals([fromFrame], [goal({ current: 10 }), goal({ id: UUID(42), title: "Subs" })]);
    expect(merged.map((g) => [g.id, g.current])).toEqual([
      [GOAL, 80],
      [UUID(42), 40],
    ]);
  });

  it("reads a listed ended goal as achieved when it reached its target", () => {
    expect(goalView(goal()).achieved).toBeNull();
    expect(goalView(goal({ endedAt: "2026-11-06T11:59:00.000Z", current: 100 })).achieved).toBe(true);
    expect(goalView(goal({ endedAt: "2026-11-06T11:59:00.000Z", current: 99 })).achieved).toBe(false);
  });

  it("shows a running goal, and an ended one only for RESULTS_VISIBLE_MS", () => {
    const ended = Date.parse("2026-11-06T11:59:00.000Z");
    const g = goalView(goal({ endedAt: "2026-11-06T11:59:00.000Z" }));
    expect(goalVisible(goalView(goal()), NOW)).toBe(true);
    expect(goalVisible(g, ended + RESULTS_VISIBLE_MS - 1)).toBe(true);
    expect(goalVisible(g, ended + RESULTS_VISIBLE_MS)).toBe(false);
    expect(goalVisible(goalView(goal({ endedAt: "not a date" })), NOW)).toBe(false);
  });

  it("clamps the percentage to 0..100", () => {
    expect(goalPercent({ current: 40, target: 100 })).toBe(40);
    expect(goalPercent({ current: 1, target: 3 })).toBe(33);
    expect(goalPercent({ current: 250, target: 100 })).toBe(100);
    expect(goalPercent({ current: -5, target: 100 })).toBe(0);
    expect(goalPercent({ current: 5, target: 0 })).toBe(0);
  });
});

const view = (over: Partial<GoalView> = {}): GoalView => ({ ...goalView(goal()), ...over });

describe("goal pinned items (pure)", () => {
  it("ranks an open goal after an open giveaway and before anything that ended", () => {
    const items = pinnedItems({
      prediction: null,
      poll: null,
      giveaway: giveaway(),
      goals: [view({ id: UUID(41), endedAt: "2026-11-06T11:59:00.000Z", achieved: true }), view()],
    });
    expect(items.map((i) => `${i.kind}:${i.state.phase}`)).toEqual(["giveaway:open", "goal:open", "goal:achieved"]);
    expect(items.map(pinnedPriority)).toEqual([2, 3, 7]);
  });

  it("labels a running goal with its numbers, an ended one achieved or ended", () => {
    const [running] = pinnedItems({ prediction: null, poll: null, giveaway: null, goals: [view()] });
    if (!running) throw new Error("no item");
    expect(running.progress).toEqual({ type: "followers", current: 40, target: 100, percent: 40 });
    expect(stateLabel(running, NOW)).toBe(t("chat.strip.goal.progress", { current: "40", target: "100" }));
    const [achieved] = pinnedItems({
      prediction: null,
      poll: null,
      giveaway: null,
      goals: [view({ endedAt: "2026-11-06T11:59:00.000Z", achieved: true })],
    });
    expect(achieved && stateLabel(achieved)).toBe(t("chat.strip.state.achieved"));
    const [missed] = pinnedItems({
      prediction: null,
      poll: null,
      giveaway: null,
      goals: [view({ endedAt: "2026-11-06T11:59:00.000Z", achieved: false })],
    });
    expect(missed && stateLabel(missed)).toBe(t("chat.strip.state.ended"));
  });

  it("groups thousands, and reads a tips goal (minor units, no currency) as a percentage", () => {
    expect(progressLabel({ type: "subscriptions", current: 1200, target: 5000, percent: 24 })).toBe(
      t("chat.strip.goal.progress", { current: "1,200", target: "5,000" }),
    );
    expect(progressLabel({ type: "tips", current: 2500, target: 10000, percent: 25 })).toBe(
      t("chat.strip.goal.percent", { percent: 25 }),
    );
  });

  it("keys a dismissal by state, not progress: it holds while the goal fills and lifts when it ends", () => {
    const key = (g: GoalView) => pinnedItems({ prediction: null, poll: null, giveaway: null, goals: [g] })[0]?.key;
    const k = key(view());
    expect(key(view({ current: 90 }))).toBe(k);
    expect(key(view({ endedAt: "2026-11-06T11:59:00.000Z", achieved: true }))).not.toBe(k);
    const items = pinnedItems({ prediction: null, poll: null, giveaway: null, goals: [view({ current: 90 })] });
    expect(undismissed(items, new Set([k ?? ""]))).toEqual([]);
  });

  it("announces the goal's kind, numbers and title", () => {
    const [item] = pinnedItems({ prediction: null, poll: null, giveaway: null, goals: [view()] });
    if (!item) throw new Error("no item");
    expect(announcement(item)).toBe(
      t("chat.strip.announce", {
        kind: t("chat.strip.kind.goal"),
        state: t("chat.strip.goal.progress", { current: "40", target: "100" }),
        title: "100 followers",
      }),
    );
    expect(DISMISS_KEYS.goal).toBe("chat.strip.dismiss.goal");
  });
});

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

describe("the strip and card for a goal", () => {
  it("shows the goal's line with its numbers and a decorative bar", () => {
    const items = pinnedItems({ prediction: null, poll: null, giveaway: null, goals: [view()] });
    wrap(<PinnedStrip items={items} renderCard={() => null} onDismiss={() => {}} now={() => NOW} />);
    const strip = screen.getByTestId("chat-pinned-strip");
    expect(strip.dataset.kind).toBe("goal");
    expect(strip.dataset.state).toBe("open");
    expect(strip.querySelector('[data-part="title"]')?.textContent).toBe("100 followers");
    expect(strip.querySelector('[data-part="state"]')?.textContent).toBe(
      t("chat.strip.goal.progress", { current: "40", target: "100" }),
    );
    const bar = strip.querySelector<HTMLElement>('[data-part="bar"]');
    expect(bar?.dataset.percent).toBe("40");
    expect(bar?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: t("chat.strip.dismiss.goal") })).toBeTruthy();
  });

  it("has no bar for the other kinds", () => {
    const items = pinnedItems({ prediction: null, poll: null, giveaway: giveaway() });
    wrap(<PinnedStrip items={items} renderCard={() => null} onDismiss={() => {}} />);
    expect(screen.getByTestId("chat-pinned-strip").querySelector('[data-part="bar"]')).toBeNull();
  });

  it("the card shows the title, a labelled progress bar, and the end state once ended", () => {
    const ended = view({ endedAt: "2026-11-06T11:59:00.000Z", achieved: true, current: 100 });
    const [item] = pinnedItems({ prediction: null, poll: null, giveaway: null, goals: [ended] });
    if (!item) throw new Error("no item");
    wrap(<GoalCard goal={ended} item={item} />);
    const card = screen.getByTestId("chat-goal");
    expect(card.dataset.state).toBe("achieved");
    expect(card.dataset.current).toBe("100");
    expect(card.textContent).toContain("100 followers");
    expect(card.textContent).toContain(t("chat.strip.state.achieved"));
    const bar = screen.getByRole("progressbar", { name: t("chat.strip.goal.label") });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
  });
});

function fakeClient(goals?: () => Promise<GoalDto[]>): {
  client: InteractClient;
  list: ReturnType<typeof vi.fn<NonNullable<InteractClient["goals"]>>>;
} {
  const list = vi.fn<NonNullable<InteractClient["goals"]>>(goals ?? (async () => []));
  const client: InteractClient = {
    pollCurrent: async () => null,
    vote: vi.fn<InteractClient["vote"]>(),
    predictionCurrent: async () => null,
    bet: vi.fn<InteractClient["bet"]>(),
    balance: async () => ({
      channelSlug: "rivertide",
      user: { id: UUID(50), username: "fan" },
      points: 0,
      pointsName: "points",
      enabled: false,
    }),
    giveawayCurrent: async () => null,
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
    ...(goals ? { goals: list } : {}),
  };
  return { client, list };
}

describe("useChatInteract goals", () => {
  const hook = (client: InteractClient) =>
    renderHook(() =>
      useChatInteract({ channel: "rivertide", signedIn: false, selfUsername: null, client, onFollowRaid: () => {} }),
    );

  it("loads the goals once on join, hides long-ended ones, and follows frames that never reach the log", async () => {
    const { client, list } = fakeClient(async () => [
      goal(),
      goal({ id: UUID(41), endedAt: "2026-01-01T00:00:00.000Z", current: 100 }),
    ]);
    const { result } = hook(client);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("rivertide");
    expect(result.current.goals.map((g) => g.id)).toEqual([GOAL]);
    let handled = false;
    act(() => {
      handled = result.current.onEvent("channel.goal.progress", frame({ current_amount: 75 }));
    });
    expect(handled).toBe(true);
    expect(result.current.goals[0]?.current).toBe(75);
    act(() => {
      handled = result.current.onEvent("channel.goal.progress", { broken: true });
    });
    expect(handled).toBe(true);
    expect(result.current.goals[0]?.current).toBe(75);
    act(() => {
      result.current.onEvent(
        "channel.goal.begin",
        frame({ id: UUID(43), description: "Subs", type: "subscriptions", started_at: "2026-11-06T11:40:00.000Z" }),
      );
    });
    expect(result.current.goals.map((g) => g.id)).toEqual([GOAL, UUID(43)]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("an ended goal stays with its result, then leaves after RESULTS_VISIBLE_MS", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(NOW);
      const { client } = fakeClient(async () => [goal()]);
      const { result } = hook(client);
      await vi.waitFor(() => expect(result.current.goals).toHaveLength(1));
      act(() => {
        result.current.onEvent("channel.goal.end", endFrame({ ended_at: new Date(NOW).toISOString() }));
      });
      expect(result.current.goals[0]?.achieved).toBe(true);
      act(() => {
        vi.advanceTimersByTime(RESULTS_VISIBLE_MS + 5_000);
      });
      expect(result.current.goals).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a client without goals, or a failed list, pins none and still finishes loading", async () => {
    const without = hook(fakeClient().client);
    await waitFor(() => expect(without.result.current.loaded).toBe(true));
    expect(without.result.current.goals).toEqual([]);
    const failing = hook(
      fakeClient(async () => {
        throw new Error("down");
      }).client,
    );
    await waitFor(() => expect(failing.result.current.loaded).toBe(true));
    expect(failing.result.current.goals).toEqual([]);
  });
});
