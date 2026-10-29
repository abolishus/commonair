// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The viewer interactivity blocks: poll and prediction cards, goal bars (docs/testing/e8-selectors.md). */
import * as React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  GoalBar,
  OverlayGoalsView,
  ViewerPollCard,
  ViewerPredictionCard,
  percentOf,
  useThrottledValue,
  type ViewerPollCardProps,
  type ViewerPredictionCardProps,
} from "../src/blocks/interact-viewer/index.ts";

afterEach(cleanup);

const choices = [
  { id: "c1", title: "Left", votes: 3, votesLabel: "3 votes" },
  { id: "c2", title: "Right", votes: 1, votesLabel: "1 vote" },
];

function poll(over: Partial<ViewerPollCardProps> = {}): React.JSX.Element {
  return (
    <ViewerPollCard
      pollId="p1"
      status="active"
      title="Which way?"
      choices={choices}
      heading="Poll"
      myVote={null}
      canVote
      liveSummary="Left 3, Right 1"
      toggleLabel="Show or hide the poll"
      {...over}
    />
  );
}

describe("percentOf", () => {
  test("rounds, caps at 100 and is 0 for an empty total", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(0, 4)).toBe(0);
    expect(percentOf(9, 4)).toBe(100);
  });
});

describe("useThrottledValue", () => {
  test("passes the latest value at most once per interval", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 1000), { initialProps: { v: "a" } });
      expect(result.current).toBe("a");
      rerender({ v: "b" });
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(result.current).toBe("b");
      rerender({ v: "c" });
      rerender({ v: "d" });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(result.current).toBe("b");
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(result.current).toBe("d");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ViewerPollCard", () => {
  test("renders the contract ids and data attributes", () => {
    render(poll());
    const root = screen.getByTestId("chat-poll");
    expect(root.getAttribute("data-poll-id")).toBe("p1");
    expect(root.getAttribute("data-status")).toBe("active");
    const buttons = screen.getAllByTestId("chat-poll-choice");
    expect(buttons.map((b) => [b.getAttribute("data-choice-id"), b.getAttribute("data-votes")])).toEqual([
      ["c1", "3"],
      ["c2", "1"],
    ]);
    expect(buttons[0]?.textContent).toContain("75%");
    expect(screen.queryByTestId("chat-poll-voted")).toBeNull();
    expect(screen.queryByTestId("chat-poll-extra")).toBeNull();
  });

  test("one click votes", () => {
    const onVote = vi.fn<(choiceId: string) => void>();
    render(poll({ onVote }));
    fireEvent.click(screen.getAllByTestId("chat-poll-choice")[1] as HTMLElement);
    expect(onVote).toHaveBeenCalledWith("c2");
  });

  test("after voting: the voted line, other choices closed, own choice open only with extra votes", () => {
    const onValueChange = vi.fn<(value: number) => void>();
    const extra = { value: 0, max: 100, onValueChange, label: "Extra votes", costLabel: "0 points" };
    const { rerender } = render(poll({ myVote: { choiceId: "c1", votes: 1, label: "You voted" }, extra }));
    const voted = screen.getByTestId("chat-poll-voted");
    expect([voted.getAttribute("data-choice-id"), voted.getAttribute("data-votes")]).toEqual(["c1", "1"]);
    const [own, other] = screen.getAllByTestId("chat-poll-choice") as HTMLButtonElement[];
    expect(own?.disabled).toBe(true);
    expect(other?.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("chat-poll-extra"), { target: { value: "250" } });
    expect(onValueChange).toHaveBeenCalledWith(100);
    rerender(poll({ myVote: { choiceId: "c1", votes: 1, label: "You voted" }, extra: { ...extra, value: 3 } }));
    const [own2, other2] = screen.getAllByTestId("chat-poll-choice") as HTMLButtonElement[];
    expect(own2?.disabled).toBe(false);
    expect(other2?.disabled).toBe(true);
  });

  test("signed out or ended: no voting, the hint shown, the extra field hidden", () => {
    render(
      poll({
        canVote: false,
        status: "completed",
        hint: "Sign in to vote",
        extra: { value: 0, max: 100, onValueChange: () => {}, label: "Extra", costLabel: "x" },
      }),
    );
    expect(screen.getByTestId("chat-poll").getAttribute("data-status")).toBe("completed");
    for (const b of screen.getAllByTestId("chat-poll-choice") as HTMLButtonElement[]) expect(b.disabled).toBe(true);
    expect(screen.getByText("Sign in to vote")).toBeTruthy();
    expect(screen.queryByTestId("chat-poll-extra")).toBeNull();
  });

  test("errors are announced as alerts; the summary sits in a polite live region", () => {
    render(poll({ error: "Not enough points" }));
    expect(screen.getByRole("alert").textContent).toBe("Not enough points");
    const live = screen.getByTestId("chat-poll").querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Left 3, Right 1");
  });

  test("collapsible from a labelled toggle", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(poll({ onOpenChange }));
    fireEvent.click(screen.getByRole("button", { name: "Show or hide the poll" }));
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });
});

const outcomes = [
  { id: "o1", title: "Alpha", points: 400, users: 2, summary: "400 points · 2", betLabel: "Bet on Alpha" },
  { id: "o2", title: "Beta", points: 200, users: 1, summary: "200 points · 1", betLabel: "Bet on Beta" },
];

function prediction(over: Partial<ViewerPredictionCardProps> = {}): React.JSX.Element {
  return (
    <ViewerPredictionCard
      predictionId="pr1"
      status="active"
      title="Who wins?"
      outcomes={outcomes}
      heading="Prediction"
      canBet
      amount={{ value: "50", onValueChange: () => {}, min: 1, max: 900, label: "Points to bet" }}
      myBet={null}
      liveSummary="Alpha 400, Beta 200"
      toggleLabel="Show or hide the prediction"
      {...over}
    />
  );
}

describe("ViewerPredictionCard", () => {
  test("outcomes, the amount field and one bet button per outcome", () => {
    const onBet = vi.fn<(outcomeId: string) => void>();
    render(prediction({ onBet }));
    const root = screen.getByTestId("chat-prediction");
    expect([root.getAttribute("data-prediction-id"), root.getAttribute("data-status")]).toEqual(["pr1", "active"]);
    const rows = screen.getAllByTestId("chat-prediction-outcome");
    expect(rows.map((r) => [r.getAttribute("data-outcome-id"), r.dataset.points, r.dataset.users])).toEqual([
      ["o1", "400", "2"],
      ["o2", "200", "1"],
    ]);
    const amount = screen.getByTestId("chat-prediction-amount") as HTMLInputElement;
    expect([amount.min, amount.max, amount.value]).toEqual(["1", "900", "50"]);
    fireEvent.click(screen.getByTestId("chat-prediction-bet-o2"));
    expect(onBet).toHaveBeenCalledWith("o2");
  });

  test("betDisabled disables every bet button", () => {
    render(prediction({ betDisabled: true }));
    expect((screen.getByTestId("chat-prediction-bet-o1") as HTMLButtonElement).disabled).toBe(true);
  });

  test.each(["locked", "resolved", "canceled"] as const)("%s: no amount, no bet buttons", (status) => {
    render(prediction({ status }));
    expect(screen.queryByTestId("chat-prediction-amount")).toBeNull();
    expect(screen.queryByTestId("chat-prediction-bet-o1")).toBeNull();
  });

  test("staff (canBet false): no betting controls, outcomes still shown", () => {
    render(prediction({ canBet: false }));
    expect(screen.getAllByTestId("chat-prediction-outcome")).toHaveLength(2);
    expect(screen.queryByTestId("chat-prediction-amount")).toBeNull();
  });

  test("my bet: empty payout until resolved, then the payout; no more betting", () => {
    const { rerender } = render(
      prediction({ myBet: { outcomeId: "o1", points: 100, payout: null, label: "You bet 100 on Alpha" } }),
    );
    let mine = screen.getByTestId("chat-prediction-my-bet");
    expect([mine.dataset.outcomeId, mine.dataset.points, mine.dataset.payout]).toEqual(["o1", "100", ""]);
    expect(screen.queryByTestId("chat-prediction-bet-o1")).toBeNull();
    rerender(
      prediction({
        status: "resolved",
        outcomes: outcomes.map((o) => ({ ...o, winner: o.id === "o1" })),
        myBet: { outcomeId: "o1", points: 100, payout: 150, label: "You won 150" },
      }),
    );
    mine = screen.getByTestId("chat-prediction-my-bet");
    expect(mine.dataset.payout).toBe("150");
    expect(screen.getAllByTestId("chat-prediction-outcome")[0]?.dataset.winner).toBe("true");
  });
});

describe("GoalBar and OverlayGoalsView", () => {
  const goal = {
    id: "g1",
    type: "followers" as const,
    title: "Two follows",
    current: 1,
    target: 2,
    valueText: "1 / 2",
  };

  test("the contract attributes and the bar's value", () => {
    render(<GoalBar goal={goal} reducedMotion={false} />);
    const el = screen.getByTestId("overlay-goal");
    expect([el.dataset.goalId, el.dataset.type, el.dataset.current, el.dataset.target]).toEqual([
      "g1",
      "followers",
      "1",
      "2",
    ]);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(el.dataset.motion).toBe("full");
  });

  test("an achieved goal is drawn full; reduced motion drops the transition", () => {
    render(<GoalBar goal={{ ...goal, current: 2, achieved: true }} reducedMotion />);
    const el = screen.getByTestId("overlay-goal");
    expect(el.dataset.achieved).toBe("true");
    expect(el.dataset.motion).toBe("reduced");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(el.querySelector('[data-slot="progress-indicator"]')?.className).toContain("transition-none");
  });

  test("the overlay draws goals only while live; connecting reads as loading", () => {
    const { rerender } = render(<OverlayGoalsView state="connecting" goals={[goal]} />);
    expect(screen.getByTestId("overlay-goals").dataset.state).toBe("loading");
    expect(screen.queryByTestId("overlay-goal")).toBeNull();
    rerender(<OverlayGoalsView state="live" goals={[goal]} />);
    expect(screen.getAllByTestId("overlay-goal")).toHaveLength(1);
    rerender(<OverlayGoalsView state="refused" goals={[goal]} />);
    expect(screen.getByTestId("overlay-goals").dataset.state).toBe("refused");
    expect(screen.queryByTestId("overlay-goal")).toBeNull();
  });
});
