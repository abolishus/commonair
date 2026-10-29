// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * E8-viewer in the DOM with the API mocked: the poll card's vote and extra-vote flows, the
 * prediction card's bounds and locked/staff states, the points chip by `enabled` and sign-in,
 * the raid banner and the follow (none for the broadcaster), event frames routed through the
 * real chat panel, and the goals and chat overlays (state + frames, refused, reduced motion).
 * Every e8-selectors.md Viewer and Overlays id is checked on the rendered DOM.
 */
import { POLL_RULES } from "@commonair/contracts/enums";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatPanel } from "../src/chat/chat-panel.tsx";
import type { ChatDeps, ChatMessageFrame, SocketLike } from "../src/chat/connection.ts";
import type { InteractClient } from "../src/chat/interact/client.ts";
import { PointsChip } from "../src/chat/interact/points-chip.tsx";
import { ChatPollCard } from "../src/chat/interact/poll-card.tsx";
import { ChatPredictionCard } from "../src/chat/interact/prediction-card.tsx";
import { RaidBanner } from "../src/chat/interact/raid-banner.tsx";
import type { LoyaltyBalanceDto, PollViewDto, PredictionViewDto } from "../src/chat/interact/state.ts";
import { useChatInteract } from "../src/chat/interact/use-chat-interact.ts";
import { OverlayChatPage, type OverlayChatDeps } from "../src/components/overlay-chat-page.tsx";
import { OverlayGoalsPage } from "../src/components/overlay-goals-page.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { EventSourceLike, OverlayConnectionDeps, OverlayGoal } from "../src/lib/overlay-connection.ts";

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = { chat: { connectToken: async () => ({ token: "t", url: "ws://chat.test/ws" }) } };
  return { ...actual, api: () => client };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const seen = new Set<string>();
const testId = (el: Element) => {
  const id = el.getAttribute("data-testid");
  if (id) seen.add(id);
  return el;
};
const byId = (id: string) => testId(screen.getByTestId(id));

function wrap(node: React.ReactNode) {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>
  );
}

const pollView = (over: Partial<PollViewDto> = {}): PollViewDto => ({
  id: UUID(1),
  title: "Which way?",
  choices: [
    { id: "c1", title: "Left", votes: 2 },
    { id: "c2", title: "Right", votes: 1 },
  ],
  status: "active",
  startedAt: "2026-10-29T12:00:00.000Z",
  endsAt: new Date(Date.now() + 60_000).toISOString(),
  endedAt: null,
  pointsPerExtraVote: 0,
  myVote: null,
  myVotes: 0,
  ...over,
});

const predictionView = (over: Partial<PredictionViewDto> = {}): PredictionViewDto => ({
  id: UUID(2),
  title: "Who wins?",
  outcomes: [
    { id: "o1", title: "Alpha", points: 400, users: 2 },
    { id: "o2", title: "Beta", points: 200, users: 1 },
  ],
  status: "active",
  startedAt: "2026-10-29T12:00:00.000Z",
  locksAt: new Date(Date.now() + 120_000).toISOString(),
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
  ...over,
});

const balance = (over: Partial<LoyaltyBalanceDto> = {}): LoyaltyBalanceDto => ({
  channelSlug: "rivertide",
  user: { id: UUID(50), username: "fan" },
  points: 500,
  pointsName: "acorns",
  enabled: true,
  ...over,
});

function fakeClient(over: Partial<InteractClient> = {}) {
  const calls = {
    vote: vi.fn<InteractClient["vote"]>(),
    bet: vi.fn<InteractClient["bet"]>(),
    balance: vi.fn<InteractClient["balance"]>(),
    pollCurrent: vi.fn<InteractClient["pollCurrent"]>(),
    predictionCurrent: vi.fn<InteractClient["predictionCurrent"]>(),
  };
  calls.pollCurrent.mockResolvedValue(null);
  calls.predictionCurrent.mockResolvedValue(null);
  calls.balance.mockResolvedValue(balance());
  const client: InteractClient = {
    pollCurrent: over.pollCurrent ?? calls.pollCurrent,
    vote: over.vote ?? calls.vote,
    predictionCurrent: over.predictionCurrent ?? calls.predictionCurrent,
    bet: over.bet ?? calls.bet,
    balance: over.balance ?? calls.balance,
  };
  return { client, calls };
}

const refusal = (code: string, requirement?: string, reason?: string) =>
  Object.assign(new Error("refused"), {
    code,
    data: { ...(requirement ? { requirement } : {}), ...(reason ? { reason } : {}) },
  });

describe("ChatPollCard", () => {
  it("one click votes, then shows chat-poll-voted and refreshes the points", async () => {
    const { client, calls } = fakeClient();
    calls.vote.mockResolvedValue(pollView({ myVote: "c2", myVotes: 1 }));
    const onVoted = vi.fn<(p: PollViewDto) => void>();
    const onPointsSpent = vi.fn<() => void>();
    const { rerender } = render(
      wrap(
        <ChatPollCard
          poll={pollView()}
          signedIn
          points={balance()}
          client={client}
          onVoted={onVoted}
          onPointsSpent={onPointsSpent}
        />,
      ),
    );
    const root = byId("chat-poll");
    expect([root.getAttribute("data-poll-id"), root.getAttribute("data-status")]).toEqual([UUID(1), "active"]);
    // pointsPerExtraVote 0: no extra field.
    expect(screen.queryByTestId("chat-poll-extra")).toBeNull();
    const choices = screen.getAllByTestId("chat-poll-choice").map(testId);
    expect(choices.map((c) => c.getAttribute("data-votes"))).toEqual(["2", "1"]);
    fireEvent.click(choices[1] as Element);
    await waitFor(() => expect(onVoted).toHaveBeenCalled());
    expect(calls.vote).toHaveBeenCalledWith({ id: UUID(1), choiceId: "c2", extraVotes: 0 });
    expect(onPointsSpent).toHaveBeenCalled();
    rerender(
      wrap(
        <ChatPollCard
          poll={onVoted.mock.calls[0]?.[0] as PollViewDto}
          signedIn
          points={balance()}
          client={client}
          onVoted={onVoted}
          onPointsSpent={onPointsSpent}
        />,
      ),
    );
    const voted = byId("chat-poll-voted");
    expect([voted.getAttribute("data-choice-id"), voted.getAttribute("data-votes")]).toEqual(["c2", "1"]);
  });

  it("extra votes: the cost in points, sent with the vote; insufficient_points inline", async () => {
    const { client, calls } = fakeClient();
    calls.vote.mockRejectedValueOnce(refusal("PRECONDITION_FAILED", "insufficient_points"));
    render(
      wrap(
        <ChatPollCard
          poll={pollView({ pointsPerExtraVote: 20 })}
          signedIn
          points={balance()}
          client={client}
          onVoted={() => {}}
          onPointsSpent={() => {}}
        />,
      ),
    );
    const extra = byId("chat-poll-extra") as HTMLInputElement;
    fireEvent.change(extra, { target: { value: "3" } });
    expect(screen.getByText(/60 acorns \(20 each\)/)).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("chat-poll-choice")[0] as Element);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You do not have enough points for that."));
    expect(calls.vote).toHaveBeenCalledWith({ id: UUID(1), choiceId: "c1", extraVotes: 3 });
  });

  it("no extra field when the channel's points are off (points null)", () => {
    const { client } = fakeClient();
    render(
      wrap(
        <ChatPollCard
          poll={pollView({ pointsPerExtraVote: 20 })}
          signedIn
          points={null}
          client={client}
          onVoted={() => {}}
          onPointsSpent={() => {}}
        />,
      ),
    );
    expect(screen.queryByTestId("chat-poll-extra")).toBeNull();
  });

  it("signed out: counts, disabled choices and the sign-in hint; ended polls are results", () => {
    const { client } = fakeClient();
    render(
      wrap(
        <ChatPollCard
          poll={pollView({ status: "completed", endedAt: new Date().toISOString() })}
          signedIn={false}
          points={null}
          client={client}
          onVoted={() => {}}
          onPointsSpent={() => {}}
        />,
      ),
    );
    expect(byId("chat-poll").getAttribute("data-status")).toBe("completed");
    for (const b of screen.getAllByTestId("chat-poll-choice") as HTMLButtonElement[]) expect(b.disabled).toBe(true);
    expect(screen.getByText("Sign in to vote in polls.")).toBeTruthy();
    expect(screen.getByText("Poll results")).toBeTruthy();
  });

  it("extra votes already bought count against the per-poll cap; none left hides the field", () => {
    const { client } = fakeClient();
    const props = { signedIn: true, points: balance(), client, onVoted: () => {}, onPointsSpent: () => {} };
    const { rerender } = render(
      wrap(<ChatPollCard poll={pollView({ pointsPerExtraVote: 20, myVote: "c1", myVotes: 61 })} {...props} />),
    );
    expect(byId("chat-poll-extra").getAttribute("max")).toBe(String(POLL_RULES.maxExtraVotesPerUser - 60));
    rerender(
      wrap(
        <ChatPollCard
          poll={pollView({ pointsPerExtraVote: 20, myVote: "c1", myVotes: POLL_RULES.maxExtraVotesPerUser + 1 })}
          {...props}
        />,
      ),
    );
    expect(screen.queryByTestId("chat-poll-extra")).toBeNull();
  });

  it("a banned or timed-out viewer's refused vote is not called a staff refusal", async () => {
    const { client, calls } = fakeClient();
    calls.vote.mockRejectedValue(refusal("FORBIDDEN"));
    render(
      wrap(
        <ChatPollCard
          poll={pollView()}
          signedIn
          points={balance()}
          client={client}
          onVoted={() => {}}
          onPointsSpent={() => {}}
        />,
      ),
    );
    fireEvent.click(screen.getAllByTestId("chat-poll-choice")[0] as Element);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("You can't vote in this channel right now."),
    );
  });
});

describe("ChatPredictionCard", () => {
  const card = (over: Partial<React.ComponentProps<typeof ChatPredictionCard>> = {}) => {
    const { client, calls } = fakeClient();
    calls.bet.mockResolvedValue(predictionView({ myBet: { outcomeId: "o1", points: 100, payout: null } }));
    const onBet = vi.fn<(p: PredictionViewDto) => void>();
    const view = render(
      wrap(
        <ChatPredictionCard
          prediction={predictionView()}
          signedIn
          staff={false}
          points={balance({ points: 300 })}
          client={client}
          onBet={onBet}
          onPointsSpent={() => {}}
          {...over}
        />,
      ),
    );
    return { calls, onBet, view };
  };

  it("outcomes with points and users; the amount bounded by the balance", async () => {
    const { calls, onBet } = card();
    const root = byId("chat-prediction");
    expect([root.getAttribute("data-prediction-id"), root.getAttribute("data-status")]).toEqual([UUID(2), "active"]);
    const rows = screen.getAllByTestId("chat-prediction-outcome").map(testId);
    expect(
      rows.map((r) => [r.getAttribute("data-outcome-id"), r.getAttribute("data-points"), r.getAttribute("data-users")]),
    ).toEqual([
      ["o1", "400", "2"],
      ["o2", "200", "1"],
    ]);
    const amount = byId("chat-prediction-amount") as HTMLInputElement;
    expect(amount.max).toBe("300");
    const bet = screen.getByTestId("chat-prediction-bet-o1") as HTMLButtonElement;
    seen.add("chat-prediction-bet-<outcomeId>");
    expect(bet.disabled).toBe(true);
    fireEvent.change(amount, { target: { value: "301" } });
    expect(bet.disabled).toBe(true);
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(amount, { target: { value: "100" } });
    expect(bet.disabled).toBe(false);
    fireEvent.click(bet);
    await waitFor(() => expect(onBet).toHaveBeenCalled());
    expect(calls.bet).toHaveBeenCalledWith({ id: UUID(2), outcomeId: "o1", points: 100 });
  });

  it("the viewer's bet: chat-prediction-my-bet with an empty payout until resolved", () => {
    card({ prediction: predictionView({ myBet: { outcomeId: "o1", points: 100, payout: null } }) });
    const mine = byId("chat-prediction-my-bet");
    expect([
      mine.getAttribute("data-outcome-id"),
      mine.getAttribute("data-points"),
      mine.getAttribute("data-payout"),
    ]).toEqual(["o1", "100", ""]);
    expect(screen.queryByTestId("chat-prediction-amount")).toBeNull();
    cleanup();
    card({
      prediction: predictionView({
        status: "resolved",
        winningOutcomeId: "o1",
        myBet: { outcomeId: "o1", points: 100, payout: 150 },
      }),
    });
    expect(screen.getByTestId("chat-prediction-my-bet").getAttribute("data-payout")).toBe("150");
    expect(screen.getByText("You bet 100 acorns on Alpha and got 150 acorns.")).toBeTruthy();
  });

  it("locked: no betting", () => {
    card({ prediction: predictionView({ status: "locked", lockedAt: new Date().toISOString() }) });
    expect(screen.getByTestId("chat-prediction").getAttribute("data-status")).toBe("locked");
    expect(screen.queryByTestId("chat-prediction-amount")).toBeNull();
    expect(screen.queryByTestId("chat-prediction-bet-o1")).toBeNull();
  });

  it("staff see no betting controls; a staff FORBIDDEN answer hides them too", async () => {
    card({ staff: true });
    expect(screen.queryByTestId("chat-prediction-amount")).toBeNull();
    cleanup();
    const { client, calls } = fakeClient();
    calls.bet.mockRejectedValue(refusal("FORBIDDEN", undefined, "staff"));
    render(
      wrap(
        <ChatPredictionCard
          prediction={predictionView()}
          signedIn
          staff={false}
          points={balance()}
          client={client}
          onBet={() => {}}
          onPointsSpent={() => {}}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId("chat-prediction-amount"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("chat-prediction-bet-o2"));
    await waitFor(() => expect(screen.queryByTestId("chat-prediction-amount")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("cannot bet");
  });

  it("a banned or timed-out viewer gets a neutral refusal and keeps the controls", async () => {
    const { client, calls } = fakeClient();
    calls.bet.mockRejectedValue(refusal("FORBIDDEN"));
    render(
      wrap(
        <ChatPredictionCard
          prediction={predictionView()}
          signedIn
          staff={false}
          points={balance()}
          client={client}
          onBet={() => {}}
          onPointsSpent={() => {}}
        />,
      ),
    );
    fireEvent.change(screen.getByTestId("chat-prediction-amount"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("chat-prediction-bet-o2"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("You can't bet on this channel's predictions right now."),
    );
    expect(screen.getByTestId("chat-prediction-amount")).toBeTruthy();
  });
});

describe("points chip and raid banner", () => {
  it("chat-points carries the raw points and the channel's name for them", () => {
    render(wrap(<PointsChip balance={balance({ points: 1234 })} />));
    const chip = byId("chat-points");
    expect([chip.getAttribute("data-points"), chip.getAttribute("data-name")]).toEqual(["1234", "acorns"]);
    expect(chip.textContent).toBe("1,234 acorns");
  });

  it("raid-banner: the target, the execute time and a countdown", () => {
    const executeAt = new Date(Date.now() + 30_000).toISOString();
    render(
      wrap(
        <RaidBanner
          raid={{ raidId: UUID(7), to: "mothwing", toDisplayName: "Mothwing", executeAt }}
          isBroadcaster={false}
        />,
      ),
    );
    const banner = byId("raid-banner");
    expect([
      banner.getAttribute("data-raid-id"),
      banner.getAttribute("data-to"),
      banner.getAttribute("data-execute-at"),
    ]).toEqual([UUID(7), "mothwing", executeAt]);
    expect(banner.textContent).toContain("Raiding Mothwing");
    expect(banner.querySelector("time")?.textContent).toMatch(/in (29|30) seconds/);
  });
});

describe("useChatInteract", () => {
  const hook = (opts: {
    signedIn?: boolean;
    self?: string | null;
    client: InteractClient;
    follow?: (to: string) => void;
  }) =>
    renderHook(() =>
      useChatInteract({
        channel: "rivertide",
        signedIn: opts.signedIn ?? true,
        selfUsername: opts.self === undefined ? "fan" : opts.self,
        client: opts.client,
        onFollowRaid: opts.follow ?? (() => {}),
      }),
    );

  it("the chip: signed-in viewers when enabled, refreshed every 60 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { client, calls } = fakeClient();
    const { result } = hook({ client });
    await waitFor(() => expect(result.current.points?.points).toBe(500));
    expect(calls.balance).toHaveBeenCalledWith("rivertide", "fan");
    calls.balance.mockResolvedValue(balance({ points: 400 }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(result.current.points?.points).toBe(400));
  });

  it("no chip when the channel's points are off, nor for signed-out viewers", async () => {
    const off = fakeClient();
    off.calls.balance.mockResolvedValue(balance({ enabled: false }));
    const a = hook({ client: off.client });
    await waitFor(() => expect(off.calls.balance).toHaveBeenCalled());
    expect(a.result.current.points).toBeNull();
    const anon = fakeClient();
    const b = hook({ client: anon.client, signedIn: false, self: null });
    await waitFor(() => expect(anon.calls.pollCurrent).toHaveBeenCalled());
    expect(anon.calls.balance).not.toHaveBeenCalled();
    expect(b.result.current.points).toBeNull();
  });

  it("loads the current poll and prediction on join; card frames are taken, others go to the log", async () => {
    const { client, calls } = fakeClient();
    calls.pollCurrent.mockResolvedValue(pollView({ myVote: "c1", myVotes: 1 }));
    const { result } = hook({ client });
    await waitFor(() => expect(result.current.poll?.myVote).toBe("c1"));
    let handled = false;
    act(() => {
      handled = result.current.onEvent("channel.poll.progress", {
        broadcaster_user_id: UUID(9),
        broadcaster_user_login: "rivertide",
        broadcaster_user_name: "Rivertide",
        id: UUID(1),
        title: "Which way?",
        choices: [
          { id: "c1", title: "Left", votes: 7, channel_points_votes: 0 },
          { id: "c2", title: "Right", votes: 1, channel_points_votes: 0 },
        ],
        channel_points_voting: { is_enabled: false, amount_per_vote: 0 },
        started_at: "2026-10-29T12:00:00.000Z",
        ends_at: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    expect(handled).toBe(true);
    expect(result.current.poll?.choices[0]?.votes).toBe(7);
    expect(result.current.poll?.myVote).toBe("c1");
    let dropped = false;
    act(() => {
      dropped = result.current.onEvent("channel.poll.progress", { id: "broken" });
    });
    expect(dropped).toBe(true);
    expect(result.current.poll?.choices[0]?.votes).toBe(7);
    expect(result.current.onEvent("channel.tip", {})).toBe(false);
  });

  it("raid: pending banner, completed follows; the broadcaster stays", () => {
    const executeAt = new Date(Date.now() + 30_000).toISOString();
    const frame = (status: "pending" | "completed" | "canceled") => ({
      raidId: UUID(7),
      status,
      to: "mothwing",
      toDisplayName: "Mothwing",
      executeAt,
    });
    const follow = vi.fn<(to: string) => void>();
    const viewer = hook({ client: fakeClient().client, follow });
    act(() => viewer.result.current.onRaid(frame("pending")));
    expect(viewer.result.current.raid?.to).toBe("mothwing");
    act(() => viewer.result.current.onRaid(frame("canceled")));
    expect(viewer.result.current.raid).toBeNull();
    act(() => viewer.result.current.onRaid(frame("pending")));
    act(() => viewer.result.current.onRaid(frame("completed")));
    expect(follow).toHaveBeenCalledWith("mothwing");
    expect(viewer.result.current.raid).toBeNull();

    const own = vi.fn<(to: string) => void>();
    const broadcaster = hook({ client: fakeClient().client, follow: own, self: "Rivertide" });
    act(() => broadcaster.result.current.onRaid(frame("pending")));
    act(() => broadcaster.result.current.onRaid(frame("completed")));
    expect(own).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ the real chat panel

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  push(frame: unknown): void {
    for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(frame) });
  }
}

describe("ChatPanel wiring", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  function renderPanel(self: string | null, client: InteractClient) {
    const root = createRootRoute({ component: () => <Outlet /> });
    const channelRoute = createRoute({
      getParentRoute: () => root,
      path: "$channel",
      component: function ChannelPage() {
        const { channel } = useParams({ strict: false }) as { channel: string };
        return <ChatPanel channel={channel} signedIn={self !== null} selfUsername={self} interactClient={client} />;
      },
    });
    const router = createRouter({
      routeTree: root.addChildren([channelRoute]),
      history: createMemoryHistory({ initialEntries: ["/rivertide"] }),
    });
    render(wrap(<RouterProvider router={router} />));
    return router;
  }

  const socket = async () => {
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    return FakeSocket.all.at(-1) as FakeSocket;
  };

  it("routes poll frames to the card, raid rows to the log, and follows a completed raid", async () => {
    const { client } = fakeClient();
    const router = renderPanel("fan", client);
    const ws = await socket();
    const broadcaster = {
      broadcaster_user_id: UUID(9),
      broadcaster_user_login: "rivertide",
      broadcaster_user_name: "Rivertide",
    };
    act(() =>
      ws.push({
        op: "event",
        channel: "rivertide",
        type: "channel.poll.begin",
        data: {
          ...broadcaster,
          id: UUID(1),
          title: "Which way?",
          choices: [
            { id: "c1", title: "Left", votes: 0, channel_points_votes: 0 },
            { id: "c2", title: "Right", votes: 0, channel_points_votes: 0 },
          ],
          channel_points_voting: { is_enabled: true, amount_per_vote: 10 },
          started_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    );
    expect((await screen.findByTestId("chat-poll")).getAttribute("data-poll-id")).toBe(UUID(1));
    // Points on and the poll sells votes: the chip and the extra field.
    await waitFor(() => expect(byId("chat-points").getAttribute("data-points")).toBe("500"));
    byId("chat-poll-extra");
    // A malformed poll frame changes nothing and adds no row.
    act(() => ws.push({ op: "event", channel: "rivertide", type: "channel.poll.progress", data: { id: "x" } }));
    expect(screen.queryAllByTestId("chat-event")).toHaveLength(0);
    act(() =>
      ws.push({
        op: "event",
        channel: "rivertide",
        type: "channel.raid",
        data: {
          from_broadcaster_user_id: UUID(10),
          from_broadcaster_user_login: "mothwing",
          from_broadcaster_user_name: "Mothwing",
          to_broadcaster_user_id: UUID(9),
          to_broadcaster_user_login: "rivertide",
          to_broadcaster_user_name: "Rivertide",
          viewers: 12,
        },
      }),
    );
    const row = testId(await screen.findByTestId("chat-event"));
    expect([row.getAttribute("data-type"), row.getAttribute("data-user"), row.getAttribute("data-viewers")]).toEqual([
      "channel.raid",
      "mothwing",
      "12",
    ]);
    const raid = {
      op: "raid",
      channel: "rivertide",
      raidId: UUID(7),
      to: "mothwing",
      toDisplayName: "Mothwing",
      executeAt: new Date(Date.now() + 30_000).toISOString(),
    };
    act(() => ws.push({ ...raid, status: "pending" }));
    expect((await screen.findByTestId("raid-banner")).getAttribute("data-to")).toBe("mothwing");
    act(() => ws.push({ ...raid, status: "completed" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/mothwing"));
  });

  it("the broadcaster's page shows the countdown but stays", async () => {
    const { client } = fakeClient();
    const router = renderPanel("rivertide", client);
    const ws = await socket();
    const raid = {
      op: "raid",
      channel: "rivertide",
      raidId: UUID(7),
      to: "mothwing",
      toDisplayName: "Mothwing",
      executeAt: new Date(Date.now() + 30_000).toISOString(),
    };
    act(() => ws.push({ ...raid, status: "pending" }));
    await screen.findByTestId("raid-banner");
    act(() => ws.push({ ...raid, status: "completed" }));
    await waitFor(() => expect(screen.queryByTestId("raid-banner")).toBeNull());
    expect(router.state.location.pathname).toBe("/rivertide");
  });
});

// ------------------------------------------------------------------ overlays

type Listener = (event: { data?: unknown }) => void;
class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
}

const goal = (over: Partial<OverlayGoal> = {}): OverlayGoal => ({
  id: UUID(100),
  type: "followers",
  title: "Two follows",
  target: 2,
  current: 0,
  startedAt: "2026-10-29T12:00:00.000Z",
  endedAt: null,
  ...over,
});

function overlayDeps<S extends { eventsUrl: string }>(
  state: () => Promise<S>,
  sources: FakeEventSource[],
): OverlayConnectionDeps<S> {
  return {
    loadState: state,
    openEvents: (url) => {
      const s = new FakeEventSource(url);
      sources.push(s);
      return s;
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    random: () => 0,
  };
}

describe("OverlayGoalsPage", () => {
  it("bars from the state, advanced by goal frames; tips as money; refused on revoked", async () => {
    window.history.replaceState(null, "", "/overlay/goals?token=tok-g");
    const sources: FakeEventSource[] = [];
    const tokens: string[] = [];
    const tips = goal({ id: UUID(101), type: "tips", title: "Mic", current: 1250, target: 5000 });
    render(
      wrap(
        <OverlayGoalsPage
          currency="usd"
          reducedMotion
          deps={(token) => {
            tokens.push(token);
            return overlayDeps(
              async () => ({ eventsUrl: "https://api.example/overlay/events", goals: [goal(), tips] }),
              sources,
            );
          }}
        />,
      ),
    );
    const root = byId("overlay-goals");
    expect(root.getAttribute("data-state")).toBe("loading");
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(tokens).toEqual(["tok-g"]);
    act(() => sources[0]?.emit("open"));
    expect(root.getAttribute("data-state")).toBe("live");
    const bars = screen.getAllByTestId("overlay-goal").map(testId);
    expect(
      bars.map((b) => [
        b.getAttribute("data-goal-id"),
        b.getAttribute("data-type"),
        b.getAttribute("data-current"),
        b.getAttribute("data-target"),
      ]),
    ).toEqual([
      [UUID(100), "followers", "0", "2"],
      [UUID(101), "tips", "1250", "5000"],
    ]);
    expect(bars[1]?.textContent).toContain("$12.50 / $50.00");
    expect(bars[0]?.getAttribute("data-motion")).toBe("reduced");
    act(() => sources[0]?.emit("goal", JSON.stringify(goal({ current: 1 }))));
    expect(screen.getAllByTestId("overlay-goal")[0]?.getAttribute("data-current")).toBe("1");
    act(() => sources[0]?.emit("goal", JSON.stringify(goal({ current: 2, endedAt: new Date().toISOString() }))));
    const achieved = screen.getAllByTestId("overlay-goal")[0];
    expect([achieved?.getAttribute("data-current"), achieved?.getAttribute("data-achieved")]).toEqual(["2", "true"]);
    act(() => sources[0]?.emit("revoked", "{}"));
    expect(root.getAttribute("data-state")).toBe("refused");
    expect(screen.queryAllByTestId("overlay-goal")).toHaveLength(0);
  });

  it("an achieved goal leaves after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, "", "/overlay/goals?token=tok-h");
    const sources: FakeEventSource[] = [];
    render(
      wrap(
        <OverlayGoalsPage
          currency="usd"
          deps={() => overlayDeps(async () => ({ eventsUrl: "https://api.example/e", goals: [goal()] }), sources)}
        />,
      ),
    );
    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => sources[0]?.emit("open"));
    act(() => sources[0]?.emit("goal", JSON.stringify(goal({ current: 2, endedAt: new Date().toISOString() }))));
    expect(screen.getAllByTestId("overlay-goal")).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(7_000);
    });
    expect(screen.queryAllByTestId("overlay-goal")).toHaveLength(0);
  });

  it("no token: refused, no request", async () => {
    window.history.replaceState(null, "", "/overlay/goals");
    const deps = vi.fn<(token: string) => OverlayConnectionDeps<{ eventsUrl: string }>>();
    render(wrap(<OverlayGoalsPage currency="usd" deps={deps} />));
    await waitFor(() => expect(screen.getByTestId("overlay-goals").getAttribute("data-state")).toBe("refused"));
    expect(deps).not.toHaveBeenCalled();
  });
});

describe("OverlayChatPage", () => {
  const message = (n: number, over: Partial<ChatMessageFrame> = {}): ChatMessageFrame => ({
    id: UUID(n),
    channelId: UUID(999),
    user: {
      id: UUID(500 + n),
      username: `user${n}`,
      displayName: `User ${n}`,
      color: null,
      badges: [],
      accountType: "human",
    },
    body: `hello ${n}`,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: "2026-10-29T12:00:00.000Z",
    ...over,
  });

  function overlay(reducedMotion?: boolean) {
    window.history.replaceState(null, "", "/overlay/chat?token=tok-c");
    const sources: FakeEventSource[] = [];
    const sockets: FakeSocket[] = [];
    const tokenCalls: string[] = [];
    const chat: ChatDeps = {
      getToken: async () => {
        tokenCalls.push("t");
        return { token: "anon", url: "ws://chat.test/ws" };
      },
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    };
    const deps = (): OverlayChatDeps => ({
      overlay: overlayDeps(async () => ({ eventsUrl: "https://api.example/e", channelSlug: "rivertide" }), sources),
      chat,
    });
    render(wrap(<OverlayChatPage deps={deps} reducedMotion={reducedMotion} />));
    return { sources, sockets, tokenCalls };
  }

  const ids = () => screen.queryAllByTestId("overlay-chat-message").map((m) => testId(m).getAttribute("data-id"));

  it("joins the token's channel read-only; delete, clear and ban apply; held messages never show", async () => {
    const { sources, sockets } = overlay();
    const root = byId("overlay-chat");
    expect(root.getAttribute("data-state")).toBe("loading");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const ws = sockets[0] as FakeSocket;
    act(() => sources[0]?.emit("open"));
    expect(root.getAttribute("data-state")).toBe("live");
    // The chat socket is reported apart from the token stream.
    expect(root.getAttribute("data-chat")).toBe("connecting");
    act(() => ws.push({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 }));
    expect(root.getAttribute("data-chat")).toBe("connecting");
    act(() =>
      ws.push({
        op: "joined",
        channel: "rivertide",
        channelId: UUID(9),
        settings: {
          slowModeSeconds: 0,
          followersOnlyMinutes: null,
          subscribersOnly: false,
          emoteOnly: false,
          minAccountAgeDays: 0,
          requireVerifiedEmail: true,
          linksAllowed: true,
        },
        me: { badges: [], canModerate: false, canChat: false },
      }),
    );
    expect(root.getAttribute("data-chat")).toBe("open");
    expect(ws.sent.map((s) => JSON.parse(s) as { op: string; channel?: string })).toContainEqual({
      op: "join",
      channel: "rivertide",
    });
    act(() => {
      ws.push({ op: "message", channel: "rivertide", message: message(1) });
      ws.push({ op: "message", channel: "rivertide", message: message(2) });
      ws.push({
        op: "message",
        channel: "rivertide",
        message: message(3, { user: { ...message(3).user, id: UUID(777) } }),
      });
      ws.push({ op: "message", channel: "rivertide", message: message(4), held: true });
    });
    expect(ids()).toEqual([UUID(1), UUID(2), UUID(3)]);
    const first = screen.getAllByTestId("overlay-chat-message")[0];
    expect(first?.getAttribute("data-username")).toBe("user1");
    expect(first?.textContent).toContain("hello 1");
    expect(root.querySelector("input, textarea, img")).toBeNull();
    act(() => ws.push({ op: "delete", channel: "rivertide", messageId: UUID(2), username: "user2" }));
    expect(ids()).toEqual([UUID(1), UUID(3)]);
    act(() =>
      ws.push({ op: "ban", channel: "rivertide", userId: UUID(777), username: "user3", expiresAt: null, reason: "" }),
    );
    expect(ids()).toEqual([UUID(1)]);
    act(() => ws.push({ op: "clear", channel: "rivertide" }));
    expect(ids()).toEqual([]);
  });

  it("keeps the last 30 messages", async () => {
    const { sockets } = overlay();
    await waitFor(() => expect(sockets).toHaveLength(1));
    const ws = sockets[0] as FakeSocket;
    act(() => {
      for (let n = 1; n <= 35; n++) ws.push({ op: "message", channel: "rivertide", message: message(n) });
    });
    expect(ids()).toHaveLength(30);
    expect(ids()[0]).toBe(UUID(6));
  });

  it("messages fade after a minute; with reduced motion they leave without a fade", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { sockets } = overlay();
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]?.push({ op: "message", channel: "rivertide", message: message(1) }));
    expect(screen.getByTestId("overlay-chat-message").getAttribute("data-fading")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_200);
    });
    expect(screen.getByTestId("overlay-chat-message").getAttribute("data-fading")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.queryByTestId("overlay-chat-message")).toBeNull();
    cleanup();

    const reduced = overlay(true);
    await waitFor(() => expect(reduced.sockets).toHaveLength(1));
    act(() => reduced.sockets[0]?.push({ op: "message", channel: "rivertide", message: message(2) }));
    expect(screen.getByTestId("overlay-chat").getAttribute("data-motion")).toBe("reduced");
    await act(async () => {
      vi.advanceTimersByTime(60_600);
    });
    expect(screen.queryByTestId("overlay-chat-message")).toBeNull();
  });

  it("revoked: refused, the chat closed and nothing shown", async () => {
    const { sources, sockets } = overlay();
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]?.push({ op: "message", channel: "rivertide", message: message(1) }));
    act(() => sources[0]?.emit("revoked", "{}"));
    expect(screen.getByTestId("overlay-chat").getAttribute("data-state")).toBe("refused");
    expect(ids()).toEqual([]);
    expect(sockets[0]?.readyState).toBe(3);
  });
});

describe("selector ids", () => {
  it("every Viewer and Overlays id of e8-selectors.md was rendered above", () => {
    expect([...seen].sort()).toEqual(
      expect.arrayContaining([
        "chat-event",
        "chat-points",
        "chat-poll",
        "chat-poll-choice",
        "chat-poll-extra",
        "chat-poll-voted",
        "chat-prediction",
        "chat-prediction-amount",
        "chat-prediction-bet-<outcomeId>",
        "chat-prediction-my-bet",
        "chat-prediction-outcome",
        "overlay-chat",
        "overlay-chat-message",
        "overlay-goal",
        "overlay-goals",
        "raid-banner",
      ]),
    );
  });
});
