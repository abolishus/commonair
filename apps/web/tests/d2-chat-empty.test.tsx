// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-chat's panel states on the real `ChatPanel` (design review F6): offline with nothing said
 * shows why it is quiet instead of "No messages yet", and when someone last spoke (one
 * `chat.history` call with limit 1), the 18+ gate shows no log frame and no
 * composer, a live channel keeps "No messages yet"; and the panel's wiring of the pinned strip
 * (what was there on load is shown but not announced) and of the points chip in the input row.
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
import { ChatPanel, type ChatPanelProps } from "../src/chat/chat-panel.tsx";
import type { ChatMessageFrame, SocketLike } from "../src/chat/connection.ts";
import type { InteractClient } from "../src/chat/interact/client.ts";
import type { LoyaltyBalanceDto, PredictionViewDto } from "../src/chat/interact/state.ts";
import { newestAt } from "../src/chat/offline.tsx";
import type { DismissStore } from "../src/chat/pinned/dismissed.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

/** `chat.history`: what the offline state's "last message" call answers. */
const history = vi.hoisted(() => ({
  calls: [] as { channel: string; limit?: number }[],
  answer: async (): Promise<{ createdAt: string }[]> => [],
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    chat: {
      connectToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
      history: async (input: { channel: string; limit?: number }) => {
        history.calls.push(input);
        return history.answer();
      },
    },
    legal: { current: async () => [] },
  };
  return { ...actual, api: () => client };
});

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const CHANNEL = "indigo";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 1;
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(): void {}
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

beforeEach(() => {
  history.calls = [];
  history.answer = async () => [];
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const prediction: PredictionViewDto = {
  id: UUID(2),
  title: "Who wins?",
  outcomes: [
    { id: "o1", title: "Alpha", points: 400, users: 2 },
    { id: "o2", title: "Beta", points: 200, users: 1 },
  ],
  status: "active",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  locksAt: new Date(Date.now() + 120_000).toISOString(),
  lockedAt: null,
  endedAt: null,
  winningOutcomeId: null,
  myBet: null,
};

const balance: LoyaltyBalanceDto = {
  channelSlug: CHANNEL,
  user: { id: UUID(50), username: "fan" },
  points: 1200,
  pointsName: "points",
  enabled: true,
};

function client(over: Partial<InteractClient> = {}): InteractClient {
  return {
    pollCurrent: async () => null,
    predictionCurrent: async () => null,
    vote: vi.fn<InteractClient["vote"]>(),
    bet: vi.fn<InteractClient["bet"]>(),
    balance: async () => balance,
    giveawayCurrent: async () => null,
    giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
    ...over,
  };
}

const memoryStore = (): DismissStore => {
  let keys: string[] = [];
  return { read: () => keys, write: (k) => (keys = [...k]) };
};

function panel(props: Partial<ChatPanelProps> = {}) {
  mount(() => (
    <ChatPanel channel={CHANNEL} signedIn={false} interactClient={client()} dismissStore={memoryStore()} {...props} />
  ));
}

function mount(Page: () => React.JSX.Element) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: Page,
  });
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

const message = (n: number, body: string): ChatMessageFrame => ({
  id: UUID(n),
  channelId: UUID(9999),
  user: { id: UUID(100), username: "fan", displayName: "Fan", color: null, badges: [], accountType: "human" },
  body,
  emotes: [],
  isAction: false,
  replyTo: null,
  createdAt: new Date().toISOString(),
});

const OFFLINE = { id: UUID(9), live: false, slug: CHANNEL };
const LIVE = { id: UUID(9), live: true, slug: CHANNEL };

describe("offline", () => {
  it("says chat is quiet until the channel goes live, by display name, instead of No messages yet", async () => {
    panel({ stream: OFFLINE, channelName: "Indigo" });
    const empty = await screen.findByTestId("chat-offline");
    expect(empty.textContent).toContain(t("chat.column.offlineTitle", { name: "Indigo" }));
    expect(screen.queryByText(t("chat.empty"))).toBeNull();
    // A heading in the panel's outline (the panel's own title is the h2).
    expect(empty.querySelector("h3")?.textContent).toBe(t("chat.column.offlineTitle", { name: "Indigo" }));
  });

  it("falls back to the slug without a display name", async () => {
    panel({ stream: OFFLINE });
    expect((await screen.findByTestId("chat-offline")).textContent).toContain(
      t("chat.column.offlineTitle", { name: CHANNEL }),
    );
  });

  it("says when someone last spoke, from one chat.history call with limit 1", async () => {
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    history.answer = async () => [{ createdAt: at }];
    panel({ stream: OFFLINE, channelName: "Indigo" });
    const last = await screen.findByTestId("chat-offline-last");
    expect(last.dataset.at).toBe(at);
    expect(last.textContent).toContain(t("chat.offline.lastMessage"));
    expect(last.querySelector("time")?.getAttribute("datetime")).toBe(at);
    expect(history.calls).toEqual([{ channel: CHANNEL, limit: 1 }]);
  });

  it("shows no time when chat.history is empty or refuses", async () => {
    panel({ stream: OFFLINE, channelName: "Indigo" });
    await screen.findByTestId("chat-offline");
    await waitFor(() => expect(history.calls).toHaveLength(1));
    expect(screen.queryByTestId("chat-offline-last")).toBeNull();
    cleanup();
    history.answer = async () => {
      throw Object.assign(new Error("nope"), { code: "FORBIDDEN" });
    };
    panel({ stream: OFFLINE, channelName: "Indigo" });
    await screen.findByTestId("chat-offline");
    await waitFor(() => expect(history.calls).toHaveLength(2));
    expect(screen.queryByTestId("chat-offline-last")).toBeNull();
  });

  it("gives way to the log once someone speaks", async () => {
    panel({ stream: OFFLINE, channelName: "Indigo" });
    const ws = await socket();
    act(() => ws.push({ op: "message", channel: CHANNEL, message: message(1, "hello") }));
    await screen.findByTestId("chat-message");
    expect(screen.queryByTestId("chat-offline")).toBeNull();
  });
});

describe("newestAt", () => {
  it("picks the newest valid time, null for none", () => {
    expect(newestAt([])).toBeNull();
    expect(newestAt([{ createdAt: "nope" }])).toBeNull();
    expect(
      newestAt([
        { createdAt: "2026-11-06T10:00:00.000Z" },
        { createdAt: "2026-11-06T11:00:00.000Z" },
        { createdAt: "bad" },
      ]),
    ).toBe("2026-11-06T11:00:00.000Z");
  });
});

describe("live", () => {
  it("keeps No messages yet, and so does a panel that does not know the stream", async () => {
    panel({ stream: LIVE, channelName: "Indigo" });
    expect(await screen.findByText(t("chat.empty"))).toBeTruthy();
    expect(screen.queryByTestId("chat-offline")).toBeNull();
    cleanup();
    panel();
    expect(await screen.findByText(t("chat.empty"))).toBeTruthy();
    // Live (or unknown) chat never asks for the last message.
    expect(history.calls).toEqual([]);
  });
});

describe("the 18+ gate", () => {
  it("shows why, with no log frame and no composer", async () => {
    panel({ stream: LIVE, channelName: "Indigo", ageGated: true, signedIn: true, selfUsername: "fan" });
    const chat = await screen.findByTestId("chat");
    expect(chat.dataset.state).toBe("gated");
    expect(screen.getByTestId("chat-gated").textContent).toContain(t("chat.column.gatedTitle"));
    expect(screen.getByTestId("chat-gated").textContent).toContain(t("chat.column.gatedBody"));
    expect(chat.querySelector('[role="log"]')).toBeNull();
    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(screen.queryByTestId("chat-signin-prompt")).toBeNull();
    expect(screen.queryByText(t("chat.empty"))).toBeNull();
    expect(chat.querySelector("h2")?.textContent).toBe(t("chat.title"));
  });

  it("gives j and k to the log once the viewer confirms 18+ (the same panel instance)", async () => {
    let confirm: () => void = () => {};
    const store = memoryStore();
    const interactClient = client();
    mount(function Gate() {
      const [gated, setGated] = React.useState(true);
      confirm = () => setGated(false);
      return (
        <ChatPanel
          channel={CHANNEL}
          stream={LIVE}
          signedIn={false}
          ageGated={gated}
          interactClient={interactClient}
          dismissStore={store}
        />
      );
    });
    expect((await screen.findByTestId("chat")).dataset.state).toBe("gated");
    act(() => confirm());
    const ws = await socket();
    act(() => {
      ws.push({ op: "message", channel: CHANNEL, message: message(1, "one") });
      ws.push({ op: "message", channel: CHANNEL, message: message(2, "two") });
    });
    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(2));
    const rows = screen.getAllByTestId("chat-message");
    rows[1]?.focus();
    fireEvent.keyDown(rows[1] as HTMLElement, { key: "k" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "j" });
    expect(document.activeElement).toBe(rows[1]);
  });

  it("keeps the column class it is given", async () => {
    panel({ ageGated: true, className: "h-112 lg:sticky" });
    expect((await screen.findByTestId("chat")).className).toContain("lg:sticky");
  });
});

describe("the panel's strip and input row", () => {
  it("pins a prediction that was open on load without announcing it", async () => {
    panel({ stream: LIVE, interactClient: client({ predictionCurrent: async () => prediction }) });
    const strip = await screen.findByTestId("chat-pinned-strip");
    expect(strip.dataset.kind).toBe("prediction");
    // The card is mounted (folded), so its own ids still resolve.
    expect(screen.getByTestId("chat-prediction").getAttribute("data-prediction-id")).toBe(UUID(2));
    await act(async () => {});
    const announce = document.querySelector('[data-part="pinned-announce"]');
    expect(announce?.getAttribute("aria-live")).toBe("polite");
    expect(announce?.textContent).toBe("");
  });

  it("keeps keyboard focus in the panel when the last pinned item is dismissed", async () => {
    panel({ stream: LIVE, interactClient: client({ predictionCurrent: async () => prediction }) });
    await screen.findByTestId("chat-pinned-strip");
    const dismiss = document.querySelector<HTMLElement>('[data-testid="chat-pinned-strip"] [data-part="dismiss"]');
    dismiss?.focus();
    expect(document.activeElement).toBe(dismiss);
    act(() => dismiss?.click());
    await waitFor(() => expect(screen.queryByTestId("chat-pinned-strip")).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByTestId("chat").contains(document.activeElement)).toBe(true);
  });

  it("shows the viewer's points in the input row, not the header", async () => {
    panel({ stream: LIVE, signedIn: true, selfUsername: "fan" });
    const chip = await screen.findByTestId("chat-points");
    expect(chip.closest("form")?.getAttribute("data-slot")).toBe("chat-composer");
    expect(chip.closest("header")).toBeNull();
  });
});
