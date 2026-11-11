// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Fair predictions in the DOM (batch 7 decision (v), docs/testing/b7-selectors.md "Fair
 * predictions"): the viewer card's "locks at what you see" note, each refusal reason and its
 * message, the result card after a resolve and a cancel; the studio panel's team note and who
 * resolved it.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { InteractClient } from "../src/chat/interact/client.ts";
import { ChatPredictionCard, betRefusalMessage, betRefusalReason } from "../src/chat/interact/prediction-card.tsx";
import type { LoyaltyBalanceDto, PredictionViewDto } from "../src/chat/interact/state.ts";
import { PredictionPanel } from "../src/components/interact-studio/prediction-panel.tsx";
import type { StudioApi } from "../src/components/interact-studio/shared.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const view = (over: Partial<PredictionViewDto> = {}): PredictionViewDto => ({
  id: UUID(2),
  title: "Who wins?",
  outcomes: [
    { id: "o1", title: "Alpha", points: 400, users: 2 },
    { id: "o2", title: "Beta", points: 200, users: 1 },
  ],
  status: "active",
  startedAt: "2026-11-01T12:00:00.000Z",
  locksAt: new Date(Date.now() + 120_000).toISOString(),
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
  lockMediaTs: null,
  resolvedBy: null,
  result: null,
  ...over,
});

const balance: LoyaltyBalanceDto = {
  channelSlug: "rivertide",
  user: { id: UUID(50), username: "fan" },
  points: 500,
  pointsName: "acorns",
  accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
  earnedToday: null,
  enabled: true,
};

const refusal = (code: string, data: Record<string, string> = {}) =>
  Object.assign(new Error("refused"), { code, data });

function card(prediction: PredictionViewDto, bet: InteractClient["bet"] = vi.fn<InteractClient["bet"]>()) {
  const client: InteractClient = {
    pollCurrent: vi.fn<InteractClient["pollCurrent"]>(),
    vote: vi.fn<InteractClient["vote"]>(),
    predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(),
    bet,
    balance: vi.fn<InteractClient["balance"]>(),
    giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(),
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
  };
  return wrap(
    <ChatPredictionCard
      prediction={prediction}
      signedIn
      staff={false}
      points={balance}
      client={client}
      onBet={() => {}}
      onPointsSpent={() => {}}
    />,
  );
}

describe("betRefusalReason", () => {
  it("maps each API refusal to its reason and message", () => {
    const cases: [unknown, string, string][] = [
      [refusal("FORBIDDEN", { reason: "staff" }), "team", "chatPrediction.error.staff"],
      [refusal("PRECONDITION_FAILED", { requirement: "not_live" }), "not_live", "fairPrediction.refused.notLive"],
      [refusal("PRECONDITION_FAILED", { requirement: "behind" }), "behind", "fairPrediction.refused.behind"],
      [
        refusal("PRECONDITION_FAILED", { requirement: "unverified" }),
        "unverified",
        "fairPrediction.refused.unverified",
      ],
      [refusal("CONFLICT"), "closed", "fairPrediction.refused.closed"],
      // A second bet is a CONFLICT that says nothing about the lock.
      [refusal("CONFLICT", { reason: "already_bet" }), "other", "fairPrediction.refused.alreadyBet"],
      // Anything else keeps the E8 messages.
      [refusal("PRECONDITION_FAILED", { requirement: "insufficient_points" }), "other", "chatPoints.insufficient"],
      [refusal("FORBIDDEN"), "other", "chatPrediction.error.forbidden"],
      [new Error("network"), "other", "chatPrediction.error.failed"],
    ];
    for (const [err, reason, key] of cases) {
      expect(betRefusalReason(err)).toBe(reason);
      expect(betRefusalMessage(err)).toBe(key);
    }
  });
});

describe("the viewer card", () => {
  it("says betting locks at what the viewer sees while it is open", () => {
    card(view());
    expect(screen.getByTestId("chat-prediction-locks-note").textContent).toBe(en["fairPrediction.locksNote"]);
    cleanup();
    card(view({ status: "locked", lockedAt: "2026-11-01T12:01:00.000Z" }));
    expect(screen.queryByTestId("chat-prediction-locks-note")).toBeNull();
  });

  for (const [data, code, reason, key] of [
    [{ requirement: "not_live" }, "PRECONDITION_FAILED", "not_live", "fairPrediction.refused.notLive"],
    [{ requirement: "behind" }, "PRECONDITION_FAILED", "behind", "fairPrediction.refused.behind"],
    [{ requirement: "unverified" }, "PRECONDITION_FAILED", "unverified", "fairPrediction.refused.unverified"],
    [{ reason: "staff" }, "FORBIDDEN", "team", "chatPrediction.error.staff"],
    [{}, "CONFLICT", "closed", "fairPrediction.refused.closed"],
    [{ reason: "already_bet" }, "CONFLICT", "other", "fairPrediction.refused.alreadyBet"],
  ] as const) {
    it(`a refused bet shows why (${reason})`, async () => {
      const bet = vi.fn<InteractClient["bet"]>().mockRejectedValue(refusal(code, data));
      card(view(), bet);
      fireEvent.change(screen.getByTestId("chat-prediction-amount"), { target: { value: "50" } });
      await act(async () => {
        fireEvent.click(screen.getByTestId("chat-prediction-bet-o1"));
      });
      const refused = await screen.findByTestId("chat-prediction-refused");
      expect(refused.getAttribute("data-reason")).toBe(reason);
      expect(refused.textContent).toBe(en[key]);
      expect(bet).toHaveBeenCalledWith({ id: UUID(2), outcomeId: "o1", points: 50 });
      // The team loses the bet controls for good; every other refusal keeps them.
      expect(screen.queryByTestId("chat-prediction-amount") === null).toBe(reason === "team");
    });
  }

  it("shows the result card after a resolve: pool, winners, shares that add up to the total", () => {
    card(
      view({
        status: "resolved",
        winningOutcomeId: "o1",
        endedAt: "2026-11-01T12:05:00.000Z",
        resolvedBy: { id: UUID(9), username: "mod" },
        result: { pool: 600, winners: 2, payoutSum: 600 },
      }),
    );
    const result = screen.getByTestId("chat-prediction-result");
    expect([
      result.getAttribute("data-pool"),
      result.getAttribute("data-winners"),
      result.getAttribute("data-payout-sum"),
    ]).toEqual(["600", "2", "600"]);
    expect(result.textContent).toContain("600 acorns predicted");
    expect(result.textContent).toContain("2 winners");
    expect(result.textContent).toContain("600 acorns went to the winners: every point that was predicted.");
  });

  it("a cancel's card returns every stake; an open prediction has none", () => {
    card(view({ status: "canceled", result: { pool: 75, winners: 0, payoutSum: 75 } }));
    const result = screen.getByTestId("chat-prediction-result");
    expect(result.textContent).toContain("no winners");
    expect(result.textContent).toContain("75 acorns returned to everyone who predicted.");
    cleanup();
    card(view());
    expect(screen.queryByTestId("chat-prediction-result")).toBeNull();
  });
});

describe("the studio panel", () => {
  const client = (current: PredictionViewDto | null) =>
    ({
      interact: {
        predictions: {
          current: vi.fn<() => Promise<PredictionViewDto | null>>(async () => current),
          create: vi.fn<() => Promise<PredictionViewDto>>(),
          lock: vi.fn<() => Promise<PredictionViewDto>>(),
          resolve: vi.fn<() => Promise<PredictionViewDto>>(),
          cancel: vi.fn<() => Promise<PredictionViewDto>>(),
        },
      },
    }) as unknown as StudioApi;

  it("notes that the team cannot bet, with or without a prediction", () => {
    wrap(<PredictionPanel channel="ann" initial={null} client={client(null)} />);
    expect(screen.getByTestId("prediction-team-note").textContent).toBe(en["fairPrediction.studio.teamNote"]);
    expect(screen.queryByTestId("prediction-resolved-by")).toBeNull();
  });

  it("names who resolved it, or who canceled it", () => {
    const resolved = view({
      status: "resolved",
      winningOutcomeId: "o1",
      resolvedBy: { id: UUID(9), username: "mod" },
      result: { pool: 600, winners: 2, payoutSum: 600 },
    });
    wrap(<PredictionPanel channel="ann" initial={resolved} client={client(resolved)} />);
    const by = screen.getByTestId("prediction-resolved-by");
    expect(by.getAttribute("data-user-id")).toBe(UUID(9));
    expect(by.textContent).toBe("Resolved by mod");
    cleanup();
    const canceled = view({ status: "canceled", resolvedBy: { id: UUID(3), username: "ann" } });
    wrap(<PredictionPanel channel="ann" initial={canceled} client={client(canceled)} />);
    expect(screen.getByTestId("prediction-resolved-by").textContent).toBe("Canceled by ann");
  });

  it("an open prediction names nobody", () => {
    const open = view();
    wrap(<PredictionPanel channel="ann" initial={open} client={client(open)} refreshMs={60_000} />);
    expect(screen.queryByTestId("prediction-resolved-by")).toBeNull();
  });
});
