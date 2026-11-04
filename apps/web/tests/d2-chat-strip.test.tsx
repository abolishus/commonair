// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-chat's pinned strip (design review F6): the priority order (an open prediction, then a poll,
 * then a giveaway, then whatever is no longer open), the state labels and countdown, "+N", expand
 * and collapse (Escape too), dismissal for this tab that returns when the item's state changes,
 * one polite announcement per change and none for a timer tick, and grace-window betting from the
 * expanded card.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { withPlayhead, type InteractClient, type PlayheadClock } from "../src/chat/interact/client.ts";
import { ChatPredictionCard } from "../src/chat/interact/prediction-card.tsx";
import type { GiveawayDto, LoyaltyBalanceDto, PollViewDto, PredictionViewDto } from "../src/chat/interact/state.ts";
import {
  MAX_DISMISSED,
  sessionDismissStore,
  useDismissed,
  withDismissed,
  type DismissStore,
} from "../src/chat/pinned/dismissed.ts";
import {
  announcement,
  newsworthy,
  pinnedItems,
  pinnedPriority,
  stateLabel,
  undismissed,
  type PinnedItem,
} from "../src/chat/pinned/model.ts";
import { PinnedStrip, usePinnedAnnouncement } from "../src/chat/pinned/strip.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const prediction = (over: Partial<PredictionViewDto> = {}): PredictionViewDto => ({
  id: UUID(2),
  title: "Who wins?",
  outcomes: [
    { id: "o1", title: "Alpha", points: 400, users: 2 },
    { id: "o2", title: "Beta", points: 200, users: 1 },
  ],
  status: "active",
  startedAt: "2026-11-04T11:58:00.000Z",
  locksAt: new Date(NOW + 151_000).toISOString(),
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
  ...over,
});

const poll = (over: Partial<PollViewDto> = {}): PollViewDto => ({
  id: UUID(1),
  title: "Which map?",
  choices: [
    { id: "c1", title: "Left", votes: 2 },
    { id: "c2", title: "Right", votes: 1 },
  ],
  status: "active",
  startedAt: "2026-11-04T11:59:00.000Z",
  endsAt: new Date(NOW + 60_000).toISOString(),
  endedAt: null,
  pointsPerExtraVote: 0,
  myVote: null,
  myVotes: 0,
  ...over,
});

const giveaway = (over: Partial<GiveawayDto> = {}): GiveawayDto => ({
  id: UUID(3),
  channelSlug: "rivertide",
  title: "Stickers",
  prize: "A sticker pack",
  winnerCount: 1,
  keyword: null,
  status: "open",
  eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
  seedCommitment: "a".repeat(64),
  opensAt: "2026-11-04T11:00:00.000Z",
  closesAt: null,
  drawnAt: null,
  entries: 3,
  me: null,
  winners: [],
  ...over,
});

const kinds = (items: readonly PinnedItem[]) => items.map((i) => `${i.kind}:${i.state.phase}`);

describe("pinnedItems (pure)", () => {
  it("puts an open prediction first, then a poll, then a giveaway", () => {
    const items = pinnedItems({ prediction: prediction(), poll: poll(), giveaway: giveaway() });
    expect(kinds(items)).toEqual(["prediction:open", "poll:open", "giveaway:open"]);
  });

  it("ranks anything still open above anything that is not", () => {
    const items = pinnedItems({
      prediction: prediction({ status: "locked", lockedAt: new Date(NOW).toISOString() }),
      poll: poll({ status: "completed" }),
      giveaway: giveaway(),
    });
    expect(kinds(items)).toEqual(["giveaway:open", "prediction:locked", "poll:won"]);
    expect(items.map(pinnedPriority)).toEqual([2, 3, 4]);
  });

  it("is empty with nothing pinned, and keeps a single item", () => {
    expect(pinnedItems({ prediction: null, poll: null, giveaway: null })).toEqual([]);
    expect(kinds(pinnedItems({ prediction: null, poll: null, giveaway: giveaway({ status: "drawn" }) }))).toEqual([
      "giveaway:drawn",
    ]);
  });

  it("keys a dismissal by state, and the card slot by id alone", () => {
    const [open] = pinnedItems({ prediction: prediction(), poll: null, giveaway: null });
    const [locked] = pinnedItems({ prediction: prediction({ status: "locked" }), poll: null, giveaway: null });
    expect(open?.slot).toBe(locked?.slot);
    expect(open?.key).not.toBe(locked?.key);
  });

  it("names the winner of a resolved prediction and of a poll without a tie", () => {
    const [p] = pinnedItems({
      prediction: prediction({ status: "resolved", winningOutcomeId: "o2" }),
      poll: null,
      giveaway: null,
    });
    expect(p?.state).toEqual({ phase: "won", by: "Beta" });
    const [tied] = pinnedItems({
      prediction: null,
      poll: poll({
        status: "completed",
        choices: [
          { id: "c1", title: "Left", votes: 2 },
          { id: "c2", title: "Right", votes: 2 },
        ],
      }),
      giveaway: null,
    });
    expect(tied?.state).toEqual({ phase: "ended" });
    const [none] = pinnedItems({
      prediction: null,
      poll: poll({ status: "terminated", choices: [{ id: "c1", title: "Left", votes: 0 }] }),
      giveaway: null,
    });
    expect(none?.state).toEqual({ phase: "ended" });
    const [unknown] = pinnedItems({
      prediction: prediction({ status: "resolved", winningOutcomeId: "gone" }),
      poll: null,
      giveaway: null,
    });
    expect(unknown?.state).toEqual({ phase: "ended" });
  });

  it("maps every giveaway and prediction status", () => {
    const g = (status: GiveawayDto["status"]) =>
      pinnedItems({ prediction: null, poll: null, giveaway: giveaway({ status }) })[0]?.state.phase;
    expect([g("open"), g("closed"), g("drawn"), g("cancelled")]).toEqual(["open", "closed", "drawn", "canceled"]);
    const p = (status: PredictionViewDto["status"]) =>
      pinnedItems({ prediction: prediction({ status }), poll: null, giveaway: null })[0]?.state.phase;
    expect([p("active"), p("locked"), p("canceled")]).toEqual(["open", "locked", "canceled"]);
  });
});

describe("stateLabel and announcement (pure)", () => {
  const [open] = pinnedItems({ prediction: prediction(), poll: null, giveaway: null });

  it("counts down while open and drops the countdown at the deadline", () => {
    if (!open) throw new Error("no item");
    expect(stateLabel(open, NOW)).toBe(t("chat.strip.state.openLeft", { time: "2:31" }));
    expect(stateLabel(open, NOW + 151_000)).toBe(t("chat.strip.state.open"));
    expect(stateLabel(open)).toBe(t("chat.strip.state.open"));
  });

  it("has no countdown for an open giveaway without a closing time", () => {
    const [g] = pinnedItems({ prediction: null, poll: null, giveaway: giveaway() });
    if (!g) throw new Error("no item");
    expect(stateLabel(g, NOW)).toBe(t("chat.strip.state.open"));
  });

  it("announces kind, state and title, never the countdown", () => {
    if (!open) throw new Error("no item");
    expect(announcement(open)).toBe(
      t("chat.strip.announce", {
        kind: t("chat.strip.kind.prediction"),
        state: t("chat.strip.state.open"),
        title: "Who wins?",
      }),
    );
    expect(announcement(open)).not.toMatch(/\d:\d\d/);
  });

  it("finds news only after the first render, and only for a new key", () => {
    const items = pinnedItems({ prediction: prediction(), poll: poll(), giveaway: null });
    expect(newsworthy(null, items)).toBeNull();
    expect(newsworthy(new Set(items.map((i) => i.key)), items)).toBeNull();
    const seen = new Set([items[0]?.key ?? ""]);
    expect(newsworthy(seen, items)?.kind).toBe("poll");
  });

  it("filters dismissed keys", () => {
    const items = pinnedItems({ prediction: prediction(), poll: poll(), giveaway: null });
    expect(kinds(undismissed(items, new Set([items[0]?.key ?? ""])))).toEqual(["poll:open"]);
    expect(undismissed(items, new Set())).toHaveLength(2);
  });
});

describe("dismissal storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("keeps the newest MAX_DISMISSED keys without duplicates", () => {
    let keys: string[] = [];
    for (let i = 0; i < MAX_DISMISSED + 5; i++) keys = withDismissed(keys, `k${i}`);
    expect(keys).toHaveLength(MAX_DISMISSED);
    expect(keys[0]).toBe("k5");
    expect(withDismissed(["a", "b"], "a")).toEqual(["b", "a"]);
  });

  it("lives in this tab's sessionStorage and survives a remount", () => {
    const a = renderHook(() => useDismissed());
    act(() => a.result.current.dismiss("prediction:x:active"));
    a.unmount();
    const b = renderHook(() => useDismissed());
    expect(b.result.current.dismissed.has("prediction:x:active")).toBe(true);
    expect(sessionDismissStore().read()).toEqual(["prediction:x:active"]);
  });

  it("reads garbage or a throwing storage as nothing", () => {
    sessionStorage.setItem("commonair.chat.pinnedDismissed", "{not json");
    expect(sessionDismissStore().read()).toEqual([]);
    sessionStorage.setItem("commonair.chat.pinnedDismissed", JSON.stringify(["a", 3, null]));
    expect(sessionDismissStore().read()).toEqual(["a"]);
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked });
    try {
      expect(sessionDismissStore().read()).toEqual([]);
      expect(() => sessionDismissStore().write(["a"])).not.toThrow();
      // Dismissals still work for the tab, in memory.
      const h = renderHook(() => useDismissed());
      act(() => h.result.current.dismiss("poll:x:active"));
      expect(h.result.current.dismissed.has("poll:x:active")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function memoryStore(): DismissStore {
  let keys: string[] = [];
  return { read: () => keys, write: (k) => (keys = [...k]) };
}

/** The strip as the chat panel wires it: dismissals filtered, the announcement beside it. */
function Harness({
  prediction: p = null,
  poll: q = null,
  giveaway: g = null,
  ready = true,
  store,
  now,
  renderCard,
}: {
  prediction?: PredictionViewDto | null;
  poll?: PollViewDto | null;
  giveaway?: GiveawayDto | null;
  ready?: boolean;
  store: DismissStore;
  now?: () => number;
  renderCard?: (item: PinnedItem) => React.ReactNode;
}) {
  const all = pinnedItems({ prediction: p, poll: q, giveaway: g });
  const { dismissed, dismiss } = useDismissed(store);
  const shown = undismissed(all, dismissed);
  const news = usePinnedAnnouncement(all, ready);
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        {shown.length > 0 && (
          <PinnedStrip
            items={shown}
            now={now}
            onDismiss={(item) => dismiss(item.key)}
            renderCard={
              renderCard ??
              ((item) => (
                <div data-testid={`card-${item.kind}`} data-key={item.key}>
                  {item.title}
                </div>
              ))
            }
          />
        )}
        <p data-testid="announce" aria-live="polite">
          {news}
        </p>
      </TooltipProvider>
    </LocaleProvider>
  );
}

const strip = () => screen.getByTestId("chat-pinned-strip");
const part = (name: string) => strip().querySelector(`[data-part="${name}"]`) as HTMLElement;

describe("PinnedStrip", () => {
  it("shows one line for the top item with +N, and the cards stay mounted but hidden", () => {
    render(<Harness prediction={prediction()} poll={poll()} giveaway={giveaway()} store={memoryStore()} />);
    expect(strip().dataset.kind).toBe("prediction");
    expect(strip().dataset.count).toBe("3");
    expect(part("title").textContent).toBe("Who wins?");
    expect(part("more").textContent).toContain(t("chat.strip.more", { count: 2 }));
    expect(part("more").textContent).toContain(t("chat.strip.moreLabel", { count: 2 }));
    expect(part("toggle").getAttribute("aria-expanded")).toBe("false");
    expect(part("cards").hidden).toBe(true);
    // Mounted in priority order, so a half-typed bet survives a collapse.
    expect(screen.getAllByTestId(/^card-/).map((c) => c.dataset.testid)).toEqual([
      "card-prediction",
      "card-poll",
      "card-giveaway",
    ]);
  });

  it("has no +N chip for a single item", () => {
    render(<Harness giveaway={giveaway()} store={memoryStore()} />);
    expect(part("more")).toBeNull();
    expect(strip().dataset.kind).toBe("giveaway");
  });

  it("expands and collapses from the line, and Escape folds it back with focus on the line", () => {
    render(<Harness prediction={prediction()} poll={poll()} store={memoryStore()} />);
    const toggle = part("toggle");
    expect(toggle.getAttribute("aria-controls")).toBe(part("cards").id);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(strip().dataset.expanded).toBe("true");
    expect(part("cards").hidden).toBe(false);
    fireEvent.click(toggle);
    expect(part("cards").hidden).toBe(true);
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByTestId("card-poll"), { key: "Escape" });
    expect(part("cards").hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("counts down the open item each second", () => {
    vi.useFakeTimers();
    let at = NOW;
    render(<Harness prediction={prediction()} store={memoryStore()} now={() => at} />);
    expect(part("state").textContent).toBe(t("chat.strip.state.openLeft", { time: "2:31" }));
    act(() => {
      at += 1_000;
      vi.advanceTimersByTime(1_000);
    });
    expect(part("state").textContent).toBe(t("chat.strip.state.openLeft", { time: "2:30" }));
  });

  it("dismissal hides that item for the tab until its state changes", () => {
    const store = memoryStore();
    const view = render(<Harness prediction={prediction()} poll={poll()} store={store} />);
    expect(part("dismiss").getAttribute("aria-label")).toBe(t("chat.strip.dismiss.prediction"));
    fireEvent.click(part("dismiss"));
    expect(strip().dataset.kind).toBe("poll");
    expect(screen.queryByTestId("card-prediction")).toBeNull();
    expect(store.read()).toEqual([`prediction:${UUID(2)}:active`]);
    // The same state again (a progress frame): still hidden.
    view.rerender(<Harness prediction={prediction({ outcomes: [] })} poll={poll()} store={store} />);
    expect(strip().dataset.kind).toBe("poll");
    // Locked: a new state, so it is back (below the open poll).
    view.rerender(<Harness prediction={prediction({ status: "locked" })} poll={poll()} store={store} />);
    expect(screen.getByTestId("card-prediction").dataset.key).toBe(`prediction:${UUID(2)}:locked`);
    expect(strip().dataset.count).toBe("2");
  });

  it("renders nothing once every item is dismissed", () => {
    render(<Harness giveaway={giveaway()} store={memoryStore()} />);
    fireEvent.click(part("dismiss"));
    expect(screen.queryByTestId("chat-pinned-strip")).toBeNull();
  });
});

describe("the strip's announcement", () => {
  it("says nothing for what was there on load, then once per change, never per tick", () => {
    vi.useFakeTimers();
    let at = NOW;
    const store = memoryStore();
    const announce = () => screen.getByTestId("announce").textContent;
    const view = render(<Harness ready={false} store={store} now={() => at} />);
    // The first load brings the open poll: not news.
    view.rerender(<Harness ready={false} poll={poll()} store={store} now={() => at} />);
    view.rerender(<Harness ready poll={poll()} store={store} now={() => at} />);
    expect(announce()).toBe("");
    // A prediction begins: one announcement.
    view.rerender(<Harness ready poll={poll()} prediction={prediction()} store={store} now={() => at} />);
    const first = announce();
    expect(first).toBe(
      t("chat.strip.announce", {
        kind: t("chat.strip.kind.prediction"),
        state: t("chat.strip.state.open"),
        title: "Who wins?",
      }),
    );
    // Ticks and progress frames change nothing.
    for (let i = 0; i < 3; i++)
      act(() => {
        at += 1_000;
        vi.advanceTimersByTime(1_000);
      });
    view.rerender(
      <Harness ready poll={poll()} prediction={prediction({ outcomes: [] })} store={store} now={() => at} />,
    );
    expect(announce()).toBe(first);
    // It locks: the next announcement, once.
    view.rerender(
      <Harness ready poll={poll()} prediction={prediction({ status: "locked" })} store={store} now={() => at} />,
    );
    expect(announce()).toBe(
      t("chat.strip.announce", {
        kind: t("chat.strip.kind.prediction"),
        state: t("chat.strip.state.locked"),
        title: "Who wins?",
      }),
    );
    // Removing an item is not news.
    const locked = announce();
    view.rerender(<Harness ready prediction={prediction({ status: "locked" })} store={store} now={() => at} />);
    expect(announce()).toBe(locked);
  });
});

describe("grace-window betting from the expanded card", () => {
  const LOCKED_AT = NOW;
  const LOCK_MEDIA = LOCKED_AT - 1_000;
  const balance: LoyaltyBalanceDto = {
    channelSlug: "rivertide",
    user: { id: UUID(50), username: "fan" },
    points: 500,
    pointsName: "acorns",
    enabled: true,
  };
  const clock: PlayheadClock = {
    playheadWallclock: () => new Date(LOCK_MEDIA - 5_000),
    playbackMode: () => "live",
  };

  it("bets with the playhead after expanding the strip", async () => {
    vi.useFakeTimers();
    const at = LOCKED_AT + 2_000;
    const locked = prediction({
      status: "locked",
      locksAt: new Date(LOCKED_AT).toISOString(),
      lockedAt: new Date(LOCKED_AT).toISOString(),
      lockMediaTs: new Date(LOCK_MEDIA).toISOString(),
    });
    const bet = vi.fn<InteractClient["bet"]>(async () => ({
      ...locked,
      myBet: { outcomeId: "o1", points: 50, payout: null },
    }));
    const client = withPlayhead(
      {
        pollCurrent: vi.fn<InteractClient["pollCurrent"]>(),
        vote: vi.fn<InteractClient["vote"]>(),
        predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(),
        bet,
        balance: vi.fn<InteractClient["balance"]>(),
        giveawayCurrent: vi.fn<InteractClient["giveawayCurrent"]>(),
        giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
      },
      "rivertide",
      clock,
    );
    render(
      <Harness
        prediction={locked}
        giveaway={giveaway()}
        store={memoryStore()}
        now={() => at}
        renderCard={(item) =>
          item.kind === "prediction" ? (
            <ChatPredictionCard
              prediction={locked}
              channel={{ id: UUID(9), live: true, slug: "rivertide" }}
              clock={clock}
              now={() => at}
              signedIn
              staff={false}
              points={balance}
              client={client}
              onBet={() => {}}
              onPointsSpent={() => {}}
            />
          ) : null
        }
      />,
    );
    // The open giveaway leads; the locked prediction in its grace is in the expanded stack.
    expect(strip().dataset.kind).toBe("giveaway");
    fireEvent.click(part("toggle"));
    const form = screen.getByTestId("prediction-grace");
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
  });
});
