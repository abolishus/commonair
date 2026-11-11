// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 3, d4-chat, on the real `ChatPanel` with a fake socket: the moderator's chat-mode
 * menu and toolbar send the server's command frames, viewers see the modes as chips, the message
 * menu's Delete, timeout lengths and Report, the incoming-raid alert for moderators only, the
 * composer gate before typing (J3-d), and the points chip's "How you earn" popover.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setCalmStorage } from "../src/chat/calm/settings.ts";
import { ChatPanel, type ChatPanelProps } from "../src/chat/chat-panel.tsx";
import type { ChatMessageFrame, SocketLike } from "../src/chat/connection.ts";
import type { InteractClient } from "../src/chat/interact/client.ts";
import type { LoyaltyBalanceDto, PredictionViewDto } from "../src/chat/interact/state.ts";
import type { DismissStore } from "../src/chat/pinned/dismissed.ts";
import type { AccountFactsClient } from "../src/components/chat-gate/account-facts.ts";
import type { ReportClient } from "../src/components/safety/client.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const calls = vi.hoisted(() => ({
  bans: [] as { channel: string; username: string; durationSeconds?: number }[],
  metrics: [] as unknown[][],
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    chat: {
      connectToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
      history: async () => [],
      held: { list: async () => [] },
      bans: {
        ban: async (input: { channel: string; username: string; durationSeconds?: number }) => {
          calls.bans.push(input);
          return {};
        },
      },
    },
    legal: { current: async () => [] },
  };
  return { ...actual, api: () => client };
});
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (...args: unknown[]) => calls.metrics.push(args),
}));
// The surge banner reads `instance.info`; it has its own tests.
vi.mock("../src/chat/surge-banner.tsx", () => ({ SurgeBanner: () => null }));

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const CHANNEL = "indigo";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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
  commands(): { command: unknown; args: unknown }[] {
    return this.sent.filter((f) => f.op === "command").map((f) => ({ command: f.command, args: f.args }));
  }
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

beforeEach(() => {
  FakeSocket.all = [];
  calls.bans = [];
  calls.metrics = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const storage = memoryStorage();
  setCalmStorage(() => storage);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCalmStorage(null);
});

const balance = (over: Partial<LoyaltyBalanceDto> = {}): LoyaltyBalanceDto => ({
  channelSlug: CHANNEL,
  user: { id: UUID(50), username: "fan" },
  points: 1240,
  pointsName: "notes",
  enabled: true,
  accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
  ...over,
});

const prediction: PredictionViewDto = {
  id: UUID(2),
  title: "Rainy or upbeat next?",
  outcomes: [
    { id: "o1", title: "Rainy", points: 400, users: 2 },
    { id: "o2", title: "Upbeat", points: 200, users: 1 },
  ],
  status: "active",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  locksAt: new Date(Date.now() + 120_000).toISOString(),
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
};

function interact(over: Partial<InteractClient> = {}): InteractClient {
  return {
    pollCurrent: async () => null,
    predictionCurrent: async () => null,
    vote: vi.fn<InteractClient["vote"]>(),
    bet: vi.fn<InteractClient["bet"]>(),
    balance: async () => balance(),
    giveawayCurrent: async () => null,
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
    ...over,
  };
}

const memoryStore = (): DismissStore => {
  let keys: string[] = [];
  return { read: () => keys, write: (k) => (keys = [...k]) };
};

/** No account facts unless a test passes them, so the email gate stays out of the way. */
const verified: AccountFactsClient = {
  me: async () => ({ email: "fan@example.test", emailVerified: true, createdAt: "2020-01-01T00:00:00.000Z" }),
};

/** Lets a test change `following` after mount, as the Follow button would. */
interface FollowHandle {
  set?: (following: boolean | null) => void;
}

function panel(props: Partial<ChatPanelProps> = {}, follow?: FollowHandle) {
  const Page = () => {
    const [following, setFollowing] = React.useState<boolean | null | undefined>(props.following);
    React.useEffect(() => {
      if (follow) follow.set = setFollowing;
    }, []);
    return (
      <ChatPanel
        channel={CHANNEL}
        channelName="Indigo"
        signedIn
        selfUsername="fan"
        interactClient={interact()}
        dismissStore={memoryStore()}
        accountFactsClient={verified}
        {...props}
        following={following ?? null}
      />
    );
  };
  const root = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: Page });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory() });
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </LocaleProvider>,
  );
}

const socket = async () => {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  return FakeSocket.all.at(-1) as FakeSocket;
};

async function join(
  o: { canModerate?: boolean; canChat?: boolean; settings?: Record<string, unknown> } = {},
): Promise<FakeSocket> {
  const ws = await socket();
  act(() => {
    ws.push({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 });
    ws.push({
      op: "joined",
      channel: CHANNEL,
      channelId: UUID(9),
      settings: o.settings ?? {},
      me: { badges: [], canModerate: o.canModerate ?? false, canChat: o.canChat ?? true },
      surge: { state: "off", until: null },
    });
  });
  await waitFor(() => expect(screen.getByTestId("chat").dataset.state).toBe("open"));
  return ws;
}

const message = (n: number, body: string, username = "troll"): ChatMessageFrame => ({
  id: UUID(n),
  channelId: UUID(9),
  user: { id: UUID(100 + n), username, displayName: `Name ${username}`, color: null, badges: [], accountType: "human" },
  body,
  emotes: [],
  isAction: false,
  replyTo: null,
  createdAt: new Date().toISOString(),
});

/** Open a menu, pick one item, and wait for the menu to close before the next one. */
async function choose(trigger: string, item: string): Promise<void> {
  fireEvent.click(screen.getByTestId(trigger));
  fireEvent.click(await screen.findByTestId(item));
  await waitFor(() => expect(screen.queryByTestId(item)).toBeNull());
}

const raidEvent = (viewers: number) => ({
  op: "event",
  channel: CHANNEL,
  type: "channel.raid",
  data: {
    from_broadcaster_user_id: UUID(10),
    from_broadcaster_user_login: "brass",
    from_broadcaster_user_name: "Brass Comet",
    to_broadcaster_user_id: UUID(9),
    to_broadcaster_user_login: CHANNEL,
    to_broadcaster_user_name: "Indigo",
    viewers,
  },
});

describe("chat modes for moderators (J5-b)", () => {
  it("the header menu sends slow, followers, subs and emote commands; Clear asks first", async () => {
    panel();
    const ws = await join({ canModerate: true });
    await choose("chat-modes", "chat-mode-slow-30");
    await choose("chat-modes", "chat-mode-followers-10");
    await choose("chat-modes", "chat-mode-subs");
    await choose("chat-modes", "chat-mode-emote");
    expect(ws.commands()).toEqual([
      { command: "slow", args: ["30"] },
      { command: "followers", args: ["10m"] },
      { command: "subscribers", args: [] },
      { command: "emoteonly", args: [] },
    ]);
    fireEvent.click(screen.getByTestId("chat-modes"));
    fireEvent.click(await screen.findByTestId("chat-mode-clear"));
    // Nothing is sent until the moderator confirms.
    expect(ws.commands()).toHaveLength(4);
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(ws.commands().at(-1)).toEqual({ command: "clear", args: [] }));
  });

  it("the menu reflects the settings frame: Off sends slowoff, and a set mode turns off", async () => {
    panel();
    const ws = await join({ canModerate: true });
    act(() =>
      ws.push({
        op: "settings",
        channel: CHANNEL,
        settings: { slowModeSeconds: 60, subscribersOnly: true, followersOnlyMinutes: 0 },
      }),
    );
    fireEvent.click(screen.getByTestId("chat-modes"));
    // 60 s is not one of the menu's lengths; it is listed so the radio shows it.
    const sixty = await screen.findByTestId("chat-mode-slow-60");
    expect(sixty.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("chat-mode-followers-0").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("chat-mode-subs").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("chat-mode-slow-0"));
    await waitFor(() => expect(screen.queryByTestId("chat-mode-slow-0")).toBeNull());
    await choose("chat-modes", "chat-mode-subs");
    await choose("chat-modes", "chat-mode-followers-off");
    expect(ws.commands()).toEqual([
      { command: "slowoff", args: [] },
      { command: "subscribersoff", args: [] },
      { command: "followersoff", args: [] },
    ]);
  });

  it("viewers get no mode controls, but see the modes that are on as chips", async () => {
    panel();
    const ws = await join();
    expect(screen.queryByTestId("chat-modes")).toBeNull();
    expect(screen.queryByTestId("chat-mode-chips")).toBeNull();
    act(() =>
      ws.push({
        op: "settings",
        channel: CHANNEL,
        settings: { slowModeSeconds: 30, emoteOnly: true },
      }),
    );
    const chips = await screen.findAllByTestId("chat-mode-chip");
    expect(chips.map((c) => c.dataset.mode)).toEqual(["slow", "emote"]);
    expect(chips[0]?.textContent).toContain("Slow mode · 30 seconds");
    expect(chips[0]?.textContent).toContain("One message every 30 seconds per person.");
  });

  it("the mod view's toolbar: every mode in one row, and no header menu", async () => {
    panel({ modTools: "toolbar" });
    const ws = await join({ canModerate: true, settings: { emoteOnly: true } });
    const bar = await screen.findByTestId("chat-modes-toolbar");
    // One named group (a fieldset and its legend).
    expect(bar.tagName).toBe("FIELDSET");
    expect(bar.querySelector("legend")?.textContent).toBe(t("d4Chat.modes.label"));
    expect(screen.queryByTestId("chat-modes")).toBeNull();
    // The toolbar shows the state, so the chips stay out of the composer.
    expect(screen.queryByTestId("chat-mode-chips")).toBeNull();
    expect(screen.getByTestId("chat-mode-emote").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("chat-mode-subs"));
    fireEvent.click(screen.getByTestId("chat-mode-emote"));
    fireEvent.click(screen.getByTestId("chat-mode-slow"));
    fireEvent.click(await screen.findByTestId("chat-mode-slow-5"));
    expect(ws.commands()).toEqual([
      { command: "subscribers", args: [] },
      { command: "emoteonlyoff", args: [] },
      { command: "slow", args: ["5"] },
    ]);
    act(() => ws.push({ op: "settings", channel: CHANNEL, settings: { slowModeSeconds: 5 } }));
    await waitFor(() => expect(screen.getByTestId("chat-mode-slow").textContent).toContain("Slow mode · 5 seconds"));
    expect(screen.getByTestId("chat-mode-slow").dataset.on).toBe("true");
  });

  it("a viewer in the mod-view layout still gets no toolbar (the server decides who moderates)", async () => {
    panel({ modTools: "toolbar" });
    await join();
    expect(screen.queryByTestId("chat-modes-toolbar")).toBeNull();
  });
});

describe("the message menu (J5-d)", () => {
  it("a moderator deletes one message with the server's delete command", async () => {
    panel();
    const ws = await join({ canModerate: true });
    act(() => ws.push({ op: "message", channel: CHANNEL, message: message(1, "spam spam") }));
    fireEvent.click(await screen.findByTestId("chat-message-actions"));
    fireEvent.click(await screen.findByTestId("chat-mod-delete"));
    expect(ws.commands()).toEqual([{ command: "delete", args: [UUID(1)] }]);
  });

  it("timeouts of 1 minute, 10 minutes, 1 hour and 24 hours", async () => {
    panel();
    const ws = await join({ canModerate: true });
    act(() => ws.push({ op: "message", channel: CHANNEL, message: message(1, "hey") }));
    fireEvent.click(await screen.findByTestId("chat-message-actions"));
    const items = await screen.findAllByTestId(/^chat-mod-timeout/);
    expect(items.map((i) => i.dataset.seconds)).toEqual(["60", "600", "3600", "86400"]);
    expect(items.map((i) => i.textContent)).toEqual(["1 minute", "10 minutes", "1 hour", "24 hours"]);
    fireEvent.click(screen.getByTestId("chat-mod-timeout-3600"));
    await waitFor(() => expect(calls.bans).toEqual([{ channel: CHANNEL, username: "troll", durationSeconds: 3600 }]));
  });

  it("Report sends one chat message as the subject", async () => {
    const report = vi.fn<ReportClient["report"]>(async () => ({ id: UUID(77) }));
    panel({ reportClient: { report } });
    const ws = await join();
    act(() => ws.push({ op: "message", channel: CHANNEL, message: message(3, "rude") }));
    fireEvent.click(await screen.findByTestId("chat-message-actions"));
    // A viewer gets Report and Block, not the moderator's actions.
    expect(screen.queryByTestId("chat-mod-delete")).toBeNull();
    fireEvent.click(await screen.findByTestId("chat-message-report"));
    await waitFor(() => expect(screen.queryByTestId("chat-user-block")).toBeNull());
    const dialog = await screen.findByTestId("report-dialog");
    expect(dialog.dataset.subjectType).toBe("chat_message");
    expect(dialog.dataset.subjectId).toBe(UUID(3));
    fireEvent.click(screen.getByTestId("report-reason"));
    fireEvent.click(await screen.findByTestId("report-reason-spam"));
    fireEvent.click(screen.getByTestId("report-submit"));
    await waitFor(() => expect(report).toHaveBeenCalled());
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      subjectType: "chat_message",
      subjectId: UUID(3),
      reason: "spam",
    });
    await waitFor(() => expect(screen.queryByTestId("report-dialog")).toBeNull());
  });
});

describe("the incoming-raid alert (J5-c)", () => {
  it("moderators see who is raiding with how many verified viewers, and two quick defences", async () => {
    panel();
    const ws = await join({ canModerate: true });
    act(() => ws.push(raidEvent(40)));
    const alert = await screen.findByTestId("chat-raid-alert");
    expect(alert.getAttribute("role")).toBe("alert");
    expect([alert.dataset.from, alert.dataset.viewers]).toEqual(["brass", "40"]);
    expect(alert.textContent).toContain("Brass Comet is raiding");
    expect(alert.textContent).toContain("40 verified viewers");
    // The log line too, without the old exclamation mark.
    expect((await screen.findByTestId("chat-event")).textContent).toContain("Brass Comet is raiding with 40 viewers");
    fireEvent.click(screen.getByTestId("chat-raid-followers"));
    fireEvent.click(screen.getByTestId("chat-raid-slow"));
    expect(ws.commands()).toEqual([
      { command: "followers", args: ["10m"] },
      { command: "slow", args: ["30"] },
    ]);
    act(() =>
      ws.push({ op: "settings", channel: CHANNEL, settings: { followersOnlyMinutes: 10, slowModeSeconds: 30 } }),
    );
    await waitFor(() => expect(screen.getByTestId("chat-raid-followers").getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByTestId("chat-raid-dismiss"));
    expect(screen.queryByTestId("chat-raid-alert")).toBeNull();
  });

  it("the broadcaster sees it on their own channel; viewers never do", async () => {
    panel({ selfUsername: CHANNEL });
    const ws = await join();
    act(() => ws.push(raidEvent(1)));
    expect((await screen.findByTestId("chat-raid-alert")).textContent).toContain("1 verified viewer");
    cleanup();
    FakeSocket.all = [];
    panel();
    const viewer = await join();
    act(() => viewer.push(raidEvent(12)));
    await screen.findByTestId("chat-event");
    expect(screen.queryByTestId("chat-raid-alert")).toBeNull();
  });
});

describe("the composer gate (J3-d)", () => {
  it("followers-only says so before typing when the page knows they do not follow", async () => {
    panel({ following: false });
    await join({ settings: { followersOnlyMinutes: 0 } });
    const gate = await screen.findByTestId("chat-composer-gate");
    expect(gate.dataset.reason).toBe("followers");
    expect(gate.textContent).toContain("Only people who follow Indigo can chat.");
    expect(gate.textContent).toContain(t("d4Chat.gate.followersNext", { channel: "Indigo" }));
    expect((screen.getByTestId("chat-input") as HTMLInputElement).disabled).toBe(true);
  });

  it("an unverified email, from the viewer's own account, with a way to resend the link", async () => {
    const me = vi.fn<AccountFactsClient["me"]>(async () => ({
      email: "fan@example.test",
      emailVerified: false,
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    panel({ accountFactsClient: { me } });
    await join({ settings: { requireVerifiedEmail: true } });
    const gate = await screen.findByTestId("chat-composer-gate");
    expect(gate.dataset.reason).toBe("verifiedEmail");
    expect(gate.querySelector('[data-testid="resend-verification"]')).not.toBeNull();
    expect(me).toHaveBeenCalledTimes(1);
  });

  it("an account too new for the channel says when it opens", async () => {
    // Opens in 5 days and an hour: the formatter truncates, so this reads "in 5 days".
    const createdAt = new Date(Date.now() - 2 * 86_400_000 + 3_600_000).toISOString();
    panel({ accountFactsClient: { me: async () => ({ email: "a@example.test", emailVerified: true, createdAt }) } });
    await join({ settings: { minAccountAgeDays: 7 } });
    const gate = await screen.findByTestId("chat-composer-gate");
    expect(gate.dataset.reason).toBe("accountAge");
    expect(gate.textContent).toContain("Indigo's chat needs accounts at least 7 days old.");
    expect(gate.textContent).toContain("You can chat here in 5 days.");
  });

  it("a subscribers-only refusal keeps the reason in the composer until the next join", async () => {
    panel();
    const ws = await join({ settings: { subscribersOnly: true } });
    expect(screen.queryByTestId("chat-composer-gate")).toBeNull();
    act(() => ws.push({ op: "notice", channel: CHANNEL, code: "msg_subsonly", text: "subs only" }));
    expect((await screen.findByTestId("chat-composer-gate")).dataset.reason).toBe("subs");
    act(() =>
      ws.push({
        op: "joined",
        channel: CHANNEL,
        channelId: UUID(9),
        settings: { subscribersOnly: true },
        me: { badges: [], canModerate: false, canChat: true },
        surge: { state: "off", until: null },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("chat-composer-gate")).toBeNull());
  });

  it("a refusal-only gate keeps the input open, and the next send asks the server again", async () => {
    // A viewer refused as a non-follower then follows: nothing on the page knows, so only a new
    // send can find out. The input stays usable and the old reason clears on that send.
    panel();
    const ws = await join({ settings: { followersOnlyMinutes: 10 } });
    act(() => ws.push({ op: "notice", channel: CHANNEL, code: "msg_followersonly", text: "followers only" }));
    expect((await screen.findByTestId("chat-composer-gate")).dataset.reason).toBe("followers");
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.queryByTestId("chat-composer-gate")).toBeNull());
    expect(ws.sent.some((f) => f.op === "send")).toBe(true);
  });

  it("an email refusal clears on the next send even when the account facts say verified", async () => {
    panel();
    const ws = await join({ settings: { requireVerifiedEmail: true } });
    act(() => ws.push({ op: "notice", channel: CHANNEL, code: "msg_verified_email", text: "verify" }));
    expect((await screen.findByTestId("chat-composer-gate")).dataset.reason).toBe("verifiedEmail");
    const input = screen.getByTestId("chat-input") as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "verified now" } });
    fireEvent.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.queryByTestId("chat-composer-gate")).toBeNull());
  });

  it("a follow clears a followers-only refusal", async () => {
    const follow: FollowHandle = {};
    panel({}, follow);
    const ws = await join({ settings: { followersOnlyMinutes: 0 } });
    act(() => ws.push({ op: "notice", channel: CHANNEL, code: "msg_followersonly", text: "followers only" }));
    expect((await screen.findByTestId("chat-composer-gate")).dataset.reason).toBe("followers");
    act(() => follow.set?.(true));
    await waitFor(() => expect(screen.queryByTestId("chat-composer-gate")).toBeNull());
  });

  it("moderators are never gated and never ask for their account facts", async () => {
    const me = vi.fn<AccountFactsClient["me"]>(async () => ({
      email: "m@example.test",
      emailVerified: false,
      createdAt: new Date().toISOString(),
    }));
    panel({ accountFactsClient: { me }, following: false });
    await join({ canModerate: true, settings: { followersOnlyMinutes: 0, minAccountAgeDays: 30 } });
    expect(screen.queryByTestId("chat-composer-gate")).toBeNull();
    expect(me).not.toHaveBeenCalled();
  });
});

describe("the points popover (D4.5)", () => {
  it("How you earn: only watch time, the instance's rate, the balance and the open prediction", async () => {
    panel({ interactClient: interact({ predictionCurrent: async () => prediction }) });
    await join();
    const chip = await screen.findByTestId("chat-points");
    expect(chip.textContent).toBe("1,240 notes");
    expect(chip.getAttribute("aria-label")).toBe("1,240 notes. How you earn them");
    fireEvent.click(chip);
    const pop = await screen.findByTestId("chat-points-popover");
    expect(pop.textContent).toContain("How you earn notes");
    expect(screen.getByTestId("chat-points-rate").textContent).toBe(
      "10 notes every 5 minutes you watch, up to 1,000 a day.",
    );
    expect(pop.textContent).toContain("Only verified live watch time counts. notes have no cash value.");
    expect(screen.getByTestId("chat-points-balance").textContent).toBe("You have 1,240 notes");
    expect(screen.getByTestId("chat-points-prediction").textContent).toBe("Open prediction: Rainy or upbeat next?");
    // Follows and chat do not earn points; the popover never says they do.
    expect(pop.textContent?.toLowerCase()).not.toMatch(/follow|chatting/);
    expect(calls.metrics).toEqual([["watch.points", "view"]]);
  });

  it("hidden when the daily cap is 0, and on your own channel", async () => {
    panel({
      interactClient: interact({
        balance: async () => balance({ accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 0 } }),
      }),
    });
    await join();
    await screen.findByTestId("chat-input");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId("chat-points")).toBeNull();
    cleanup();
    FakeSocket.all = [];
    panel({ selfUsername: CHANNEL });
    await join();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId("chat-points")).toBeNull();
  });
});
