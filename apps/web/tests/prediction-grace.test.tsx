// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Web betting in the grace after a lock (batch 8, B8-web; ADR 0039 §3; `prediction-grace`): shown
 * for a live channel whose player is live and before the lock, counting down from `lockedAt` by the
 * wall clock, gone after 30 s, never offline, in `dvr` or past the lock; the bet carries the
 * playhead and mode (`withPlayhead`); a refusal shows its reason and closes the form; the rules axe
 * would flag on the card in grace.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { withPlayhead, type InteractClient, type PlayheadClock } from "../src/chat/interact/client.ts";
import {
  ChatPredictionCard,
  GRACE_MS,
  graceEndsAt,
  graceOpen,
  type PredictionChannel,
} from "../src/chat/interact/prediction-card.tsx";
import type { LoyaltyBalanceDto, PredictionViewDto } from "../src/chat/interact/state.ts";
import { en } from "../src/i18n/en.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const LOCKED_AT = Date.parse("2026-11-03T12:00:00.000Z");
/** The media edge at the lock (PDT): a viewer 6 s behind still sees 5 s before it. */
const LOCK_MEDIA = LOCKED_AT - 1_000;

let nowMs = LOCKED_AT + 2_000;
const now = () => nowMs;

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = LOCKED_AT + 2_000;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const locked = (over: Partial<PredictionViewDto> = {}): PredictionViewDto => ({
  id: UUID(2),
  title: "Who wins?",
  outcomes: [
    { id: "o1", title: "Alpha", points: 400, users: 2 },
    { id: "o2", title: "Beta", points: 200, users: 1 },
  ],
  status: "locked",
  startedAt: "2026-11-03T11:58:00.000Z",
  locksAt: "2026-11-03T12:00:00.000Z",
  lockedAt: new Date(LOCKED_AT).toISOString(),
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
  lockMediaTs: new Date(LOCK_MEDIA).toISOString(),
  resolvedBy: null,
  result: null,
  ...over,
});

const balance: LoyaltyBalanceDto = {
  channelSlug: "rivertide",
  user: { id: UUID(50), username: "fan" },
  points: 500,
  pointsName: "acorns",
  enabled: true,
};

const LIVE: PredictionChannel = { id: UUID(9), live: true, slug: "rivertide" };

function fakeClock(mode: "live" | "dvr" = "live", playheadMs: number | null = LOCK_MEDIA - 5_000): PlayheadClock {
  return {
    playheadWallclock: () => (playheadMs === null ? null : new Date(playheadMs)),
    playbackMode: () => mode,
  };
}

function interact(bet: InteractClient["bet"]): InteractClient {
  return {
    pollCurrent: vi.fn<InteractClient["pollCurrent"]>(),
    vote: vi.fn<InteractClient["vote"]>(),
    predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(),
    bet,
    balance: vi.fn<InteractClient["balance"]>(),
    giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(),
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
  };
}

function card(
  prediction: PredictionViewDto,
  opts: {
    channel?: PredictionChannel | null;
    clock?: PlayheadClock;
    bet?: InteractClient["bet"];
    onBet?: (p: PredictionViewDto) => void;
  } = {},
) {
  const clock = opts.clock ?? fakeClock();
  const bet = opts.bet ?? vi.fn<InteractClient["bet"]>();
  // As the chat panel does: every bet carries this channel's playhead and mode.
  const client = withPlayhead(interact(bet), "rivertide", clock);
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <ChatPredictionCard
          prediction={prediction}
          channel={opts.channel === undefined ? LIVE : opts.channel}
          clock={clock}
          now={now}
          signedIn
          staff={false}
          points={balance}
          client={client}
          onBet={opts.onBet ?? (() => {})}
          onPointsSpent={() => {}}
        />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

const grace = () => screen.queryByTestId("prediction-grace");
const tickTo = (ms: number) =>
  act(() => {
    const step = ms - nowMs;
    nowMs = ms;
    vi.advanceTimersByTime(Math.max(step, 1_000));
  });

describe("graceOpen (pure)", () => {
  const base = {
    prediction: locked(),
    channel: LIVE,
    nowMs: LOCKED_AT + 1_000,
    mode: "live" as const,
    playhead: new Date(LOCK_MEDIA - 1),
  };
  it("is open for a live viewer before the lock, within 30 s of lockedAt", () => {
    expect(graceEndsAt(locked())).toBe(LOCKED_AT + GRACE_MS);
    expect(graceOpen(base)).toBe(true);
    expect(graceOpen({ ...base, nowMs: LOCKED_AT + GRACE_MS - 1 })).toBe(true);
  });
  it("is closed at 30 s, in dvr, at or past the lock, without a playhead, offline, or with a bet", () => {
    expect(graceOpen({ ...base, nowMs: LOCKED_AT + GRACE_MS })).toBe(false);
    expect(graceOpen({ ...base, mode: "dvr" })).toBe(false);
    expect(graceOpen({ ...base, playhead: new Date(LOCK_MEDIA) })).toBe(false);
    expect(graceOpen({ ...base, playhead: null })).toBe(false);
    expect(graceOpen({ ...base, channel: { ...LIVE, live: false } })).toBe(false);
    expect(graceOpen({ ...base, channel: { id: LIVE.id, live: true } })).toBe(false);
    expect(graceOpen({ ...base, channel: null })).toBe(false);
    expect(graceOpen({ ...base, prediction: locked({ lockMediaTs: null }) })).toBe(false);
    expect(graceOpen({ ...base, prediction: locked({ status: "active" }) })).toBe(false);
    expect(graceOpen({ ...base, prediction: locked({ myBet: { outcomeId: "o1", points: 5, payout: null } }) })).toBe(
      false,
    );
  });
});

describe("the grace bet form", () => {
  it("shows a countdown from lockedAt and hides after 30 s", () => {
    card(locked());
    const g = grace() as HTMLElement;
    expect(g.dataset.predictionId).toBe(UUID(2));
    expect(g.dataset.graceEndsAt).toBe(new Date(LOCKED_AT + GRACE_MS).toISOString());
    const countdown = () => screen.getByTestId("prediction-grace-countdown");
    expect(countdown().dataset.seconds).toBe("28");
    expect(countdown().textContent).toBe(t("fairPrediction.grace.countdown", { seconds: 28 }));
    tickTo(LOCKED_AT + 12_000);
    expect(countdown().dataset.seconds).toBe("18");
    tickTo(LOCKED_AT + GRACE_MS);
    expect(grace()).toBeNull();
  });

  it("recomputes from lockedAt after a hidden tab, not from when its timer started", () => {
    card(locked());
    act(() => {
      nowMs = LOCKED_AT + 25_500;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByTestId("prediction-grace-countdown").dataset.seconds).toBe("5");
  });

  it("is not offered offline, in dvr, past the lock, or before a lock", () => {
    card(locked(), { channel: { ...LIVE, live: false } });
    expect(grace()).toBeNull();
    cleanup();
    card(locked({ lockMediaTs: null }));
    expect(grace()).toBeNull();
    cleanup();
    card(locked(), { clock: fakeClock("dvr") });
    expect(grace()).toBeNull();
    cleanup();
    card(locked(), { clock: fakeClock("live", LOCK_MEDIA + 500) });
    expect(grace()).toBeNull();
    cleanup();
    card(locked({ status: "active", lockedAt: null, lockMediaTs: null }));
    expect(grace()).toBeNull();
  });

  it("bets with the playhead and mode, and the server's answer replaces the form", async () => {
    const view = locked({ myBet: { outcomeId: "o1", points: 50, payout: null } });
    const bet = vi.fn<InteractClient["bet"]>(async () => view);
    const onBet = vi.fn<(p: PredictionViewDto) => void>();
    card(locked(), { bet, onBet });
    const form = grace() as HTMLElement;
    fireEvent.change(form.querySelector('[data-testid="chat-prediction-amount"]') as HTMLElement, {
      target: { value: "50" },
    });
    await act(async () => {
      fireEvent.click(form.querySelector('[data-testid="chat-prediction-bet-o1"]') as HTMLElement);
    });
    expect(bet).toHaveBeenCalledWith({
      id: UUID(2),
      outcomeId: "o1",
      points: 50,
      mediaTs: new Date(LOCK_MEDIA - 5_000).toISOString(),
      playbackMode: "live",
    });
    expect(onBet).toHaveBeenCalledWith(view);
  });

  it("a refusal shows its reason and closes the form", async () => {
    const bet = vi.fn<InteractClient["bet"]>(async () => {
      throw Object.assign(new Error("closed"), { code: "CONFLICT", data: {} });
    });
    card(locked(), { bet });
    const form = grace() as HTMLElement;
    fireEvent.change(form.querySelector('[data-testid="chat-prediction-amount"]') as HTMLElement, {
      target: { value: "10" },
    });
    await act(async () => {
      fireEvent.click(form.querySelector('[data-testid="chat-prediction-bet-o2"]') as HTMLElement);
    });
    const refused = screen.getByTestId("chat-prediction-refused");
    expect(refused.dataset.reason).toBe("closed");
    expect(refused.textContent).toBe(en["fairPrediction.refused.closed"]);
    expect(grace()).toBeNull();
    tickTo(LOCKED_AT + 5_000);
    expect(grace()).toBeNull();
  });

  it("passes the accessibility checks in grace", () => {
    const { container } = card(locked());
    const problems: string[] = [];
    for (const el of container.querySelectorAll("button"))
      if (!(el.getAttribute("aria-label") ?? el.textContent ?? "").trim()) problems.push(el.outerHTML.slice(0, 80));
    for (const el of container.querySelectorAll("input"))
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby")) problems.push("input label");
    for (const el of container.querySelectorAll("[aria-labelledby]"))
      for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) problems.push(`missing #${id}`);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    if (new Set(ids).size !== ids.length) problems.push("duplicate-id");
    expect(problems).toEqual([]);
    expect(grace()?.getAttribute("aria-labelledby")).toBeTruthy();
  });
});
