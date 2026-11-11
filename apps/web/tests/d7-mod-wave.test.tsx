// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 4, d7-mod (J5-d): a moderator's wave row. Moderators see raw chat, so a wave of
 * three or more copies gets a row under its latest copy with "Time out all {n} senders" (1 m,
 * 10 m, 1 h, 24 h) and "Delete all", each behind a ConfirmDialog, then a toast with the counts.
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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MOD_WAVE_MIN, modWaves, waveMessageIds } from "../src/chat/calm/wave-mod-model.ts";
import { ModWaveRow, type WaveModClient } from "../src/chat/calm/wave-mod.tsx";
import type { Wave } from "../src/chat/calm/reducer.ts";
import { setCalmStorage } from "../src/chat/calm/settings.ts";
import { ChatPanel } from "../src/chat/chat-panel.tsx";
import type { ChatMessageFrame, SocketLike } from "../src/chat/connection.ts";
import type { InteractClient } from "../src/chat/interact/client.ts";
import type { DismissStore } from "../src/chat/pinned/dismissed.ts";
import type { AccountFactsClient } from "../src/components/chat-gate/account-facts.ts";
import type { ChatRow } from "../src/chat/state.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (m: string) => toasts.success.push(m),
    error: (m: string) => toasts.error.push(m),
  },
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    chat: {
      connectToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
      history: async () => [],
      held: { list: async () => [] },
    },
    legal: { current: async () => [] },
  };
  return { ...actual, api: () => client };
});
vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: () => undefined }));
vi.mock("../src/chat/surge-banner.tsx", () => ({ SurgeBanner: () => null }));

const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const CHANNEL = "indigo";
const T0 = Date.parse("2026-11-11T12:00:00Z");

const frame = (n: number, body: string, sender: number, badges: { type: string }[] = []): ChatMessageFrame => ({
  id: UUID(n),
  channelId: UUID(9),
  user: {
    id: UUID(100 + sender),
    username: `user${sender}`,
    displayName: `User ${sender}`,
    color: null,
    badges: badges as ChatMessageFrame["user"]["badges"],
    accountType: "human",
  },
  body,
  emotes: [],
  isAction: false,
  replyTo: null,
  createdAt: new Date(T0 + n * 100).toISOString(),
});
const row = (m: ChatMessageFrame): ChatRow => ({ kind: "message", id: m.id, message: m, deleted: false });

function waveOf(messages: ChatMessageFrame[]): Wave {
  const first = messages[0];
  const latest = messages.at(-1);
  if (!first || !latest) throw new Error("empty wave");
  return {
    id: first.id,
    key: first.body,
    messages,
    count: messages.length,
    senders: new Set(messages.map((m) => m.user.id)).size,
    first,
    latest,
  };
}

function fakeClient(over: Partial<WaveModClient> = {}) {
  const calls = { bulk: [] as Parameters<WaveModClient["bulkTimeout"]>[0][], deletes: [] as string[] };
  const client: WaveModClient = {
    bulkTimeout: async (input) => {
      calls.bulk.push(input);
      return { timedOut: [{}, {}], skipped: [{}], deletedMessages: input.deleteMessages ? 3 : 0 };
    },
    deleteMessage: async ({ id }) => {
      calls.deletes.push(id);
      return { ok: true };
    },
    ...over,
  };
  return { client, calls };
}

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );

beforeEach(() => {
  toasts.success = [];
  toasts.error = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("modWaves", () => {
  it(`keys each wave of at least ${MOD_WAVE_MIN} copies by its latest message`, () => {
    const rows = [frame(1, "raid", 1), frame(2, "hi", 2), frame(3, "raid", 2), frame(4, "raid", 3), frame(5, "hi", 3)];
    const waves = modWaves(rows.map(row), "mod");
    expect([...waves.keys()]).toEqual([UUID(4)]);
    expect(waves.get(UUID(4))).toMatchObject({ count: 3, senders: 3 });
  });

  it("never groups staff or the moderator's own lines, and a pair is not a wave row", () => {
    const rows = [
      frame(1, "x", 1, [{ type: "moderator" }]),
      frame(2, "x", 2, [{ type: "broadcaster" }]),
      frame(3, "x", 3),
      frame(4, "x", 4),
    ];
    expect(modWaves(rows.map(row), null).size).toBe(0);
    const own = [
      frame(5, "y", 5),
      frame(6, "y", 6),
      { ...frame(7, "y", 7), user: { ...frame(7, "y", 7).user, username: "Mod" } },
    ];
    expect(modWaves(own.map(row), "mod").size).toBe(0);
  });

  it("an empty log has no waves; ids are newest first and capped at the contract's 50", () => {
    expect(modWaves([], null).size).toBe(0);
    const big = Array.from({ length: 60 }, (_, i) => frame(i + 1, "flood", i));
    const wave = waveOf(big);
    const ids = waveMessageIds(wave);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(UUID(60));
    expect(ids).toContain(UUID(1));
  });
});

describe("ModWaveRow", () => {
  const wave = waveOf([frame(1, "spam", 1), frame(2, "spam", 2), frame(3, "spam", 1)]);

  it("is a labelled article with both actions reachable by keyboard", () => {
    wrap(<ModWaveRow channel={CHANNEL} wave={wave} client={fakeClient().client} />);
    const group = screen.getByRole("article", { name: t("d7Mod.wave.label", { body: "spam" }) });
    expect(group.dataset.senders).toBe("2");
    const timeout = within(group).getByTestId("chat-mod-wave-timeout");
    expect(timeout.textContent).toContain(t("d7Mod.wave.timeoutAll", { senders: 2 }));
    expect(timeout.tagName).toBe("BUTTON");
    expect(within(group).getByTestId("chat-mod-wave-delete").tagName).toBe("BUTTON");
  });

  it("Time out all: pick a length, confirm, one bulk call, then a toast with the counts", async () => {
    const { client, calls } = fakeClient();
    wrap(<ModWaveRow channel={CHANNEL} wave={wave} client={client} />);
    fireEvent.click(screen.getByTestId("chat-mod-wave-timeout"));
    const options = await screen.findAllByTestId("chat-mod-wave-timeout-option");
    expect(options.map((o) => o.dataset.seconds)).toEqual(["60", "600", "3600", "86400"]);
    const hour = options.find((o) => o.dataset.seconds === "3600");
    if (!hour) throw new Error("no 1 h option");
    fireEvent.click(hour);
    const dialog = await screen.findByTestId("chat-mod-wave-timeout-dialog");
    // Nothing is sent before the moderator confirms.
    expect(calls.bulk).toEqual([]);
    expect(within(dialog).getByTestId("chat-mod-wave-also-delete").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(calls.bulk).toHaveLength(1));
    expect(calls.bulk[0]).toEqual({
      channel: CHANNEL,
      messageIds: [UUID(3), UUID(2), UUID(1)],
      durationSeconds: 3600,
      deleteMessages: true,
    });
    await waitFor(() =>
      expect(toasts.success).toEqual([t("d7Mod.timeout.done", { timedOut: 2, deleted: 3, skipped: 1 })]),
    );
  });

  it("unticking 'Also delete' times out without deleting; Cancel sends nothing", async () => {
    const { client, calls } = fakeClient();
    wrap(<ModWaveRow channel={CHANNEL} wave={wave} client={client} />);
    fireEvent.click(screen.getByTestId("chat-mod-wave-timeout"));
    fireEvent.click((await screen.findAllByTestId("chat-mod-wave-timeout-option"))[0] as HTMLElement);
    let dialog = await screen.findByTestId("chat-mod-wave-timeout-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("chat-mod-wave-timeout-dialog")).toBeNull());
    expect(calls.bulk).toEqual([]);

    fireEvent.click(screen.getByTestId("chat-mod-wave-timeout"));
    fireEvent.click((await screen.findAllByTestId("chat-mod-wave-timeout-option"))[0] as HTMLElement);
    dialog = await screen.findByTestId("chat-mod-wave-timeout-dialog");
    fireEvent.click(within(dialog).getByTestId("chat-mod-wave-also-delete"));
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(calls.bulk).toHaveLength(1));
    expect(calls.bulk[0]).toMatchObject({ durationSeconds: 60, deleteMessages: false });
  });

  it("a refused bulk call keeps the dialog open and shows an error toast", async () => {
    const { client } = fakeClient({
      bulkTimeout: async () => {
        throw new Error("nope");
      },
    });
    wrap(<ModWaveRow channel={CHANNEL} wave={wave} client={client} />);
    fireEvent.click(screen.getByTestId("chat-mod-wave-timeout"));
    fireEvent.click((await screen.findAllByTestId("chat-mod-wave-timeout-option"))[1] as HTMLElement);
    const dialog = await screen.findByTestId("chat-mod-wave-timeout-dialog");
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(toasts.error).toEqual([t("d7Mod.failed")]));
    expect(screen.getByTestId("chat-mod-wave-timeout-dialog")).toBeTruthy();
    expect(toasts.success).toEqual([]);
  });

  it("Delete all: confirm, one delete per message, then a toast", async () => {
    const { client, calls } = fakeClient();
    wrap(<ModWaveRow channel={CHANNEL} wave={wave} client={client} />);
    fireEvent.click(screen.getByTestId("chat-mod-wave-delete"));
    const dialog = await screen.findByTestId("chat-mod-wave-delete-dialog");
    expect(dialog.textContent).toContain(t("d7Mod.delete.title", { count: 3 }));
    expect(calls.deletes).toEqual([]);
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(toasts.success).toEqual([t("d7Mod.delete.done", { deleted: 3 })]));
    expect(calls.deletes.toSorted()).toEqual([UUID(1), UUID(2), UUID(3)]);
  });

  it("Delete all with some refused says how many went through", async () => {
    const { client } = fakeClient({
      deleteMessage: async ({ id }) => {
        if (id === UUID(2)) throw new Error("gone");
        return { ok: true };
      },
    });
    wrap(<ModWaveRow channel={CHANNEL} wave={wave} client={client} />);
    fireEvent.click(screen.getByTestId("chat-mod-wave-delete"));
    fireEvent.click(
      within(await screen.findByTestId("chat-mod-wave-delete-dialog")).getByTestId("confirm-dialog-confirm"),
    );
    await waitFor(() => expect(toasts.error).toEqual([t("d7Mod.delete.partial", { deleted: 2, failed: 1 })]));
  });
});

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
  push(f: unknown): void {
    for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(f) });
  }
}

const interact: InteractClient = {
  pollCurrent: async () => null,
  predictionCurrent: async () => null,
  vote: vi.fn<InteractClient["vote"]>(),
  bet: vi.fn<InteractClient["bet"]>(),
  balance: async () => ({
    channelSlug: CHANNEL,
    user: { id: UUID(50), username: "mod" },
    points: 0,
    pointsName: "notes",
    enabled: false,
    accrual: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 },
  }),
  giveawayCurrent: async () => null,
  giveawayEnter: vi.fn<InteractClient["giveawayEnter"]>(),
};
const verified: AccountFactsClient = {
  me: async () => ({ email: "mod@example.test", emailVerified: true, createdAt: "2020-01-01T00:00:00.000Z" }),
};
const store = (): DismissStore => {
  let keys: string[] = [];
  return { read: () => keys, write: (k) => (keys = [...k]) };
};

describe("the wave row in the chat panel", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    const data = new Map<string, string>();
    setCalmStorage(() => ({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }));
  });
  afterEach(() => setCalmStorage(null));

  async function mount(canModerate: boolean) {
    const { client, calls } = fakeClient();
    const Page = () => (
      <ChatPanel
        channel={CHANNEL}
        channelName="Indigo"
        signedIn
        selfUsername="mod"
        interactClient={interact}
        dismissStore={store()}
        accountFactsClient={verified}
        waveModClient={client}
      />
    );
    const root = createRootRoute({ component: () => <Outlet /> });
    const route = createRoute({ getParentRoute: () => root, path: "/", component: Page });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory() });
    wrap(<RouterProvider router={router} />);
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    const ws = FakeSocket.all.at(-1) as FakeSocket;
    act(() => {
      ws.push({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 });
      ws.push({
        op: "joined",
        channel: CHANNEL,
        channelId: UUID(9),
        settings: {},
        me: { badges: [], canModerate, canChat: true },
        surge: { state: "off", until: null },
      });
    });
    await waitFor(() => expect(screen.getByTestId("chat").dataset.state).toBe("open"));
    act(() => {
      for (const [n, s] of [
        [1, 1],
        [2, 2],
        [3, 3],
      ] as const)
        ws.push({
          op: "message",
          channel: CHANNEL,
          message: { ...frame(n, "raid", s), createdAt: new Date().toISOString() },
        });
    });
    return { calls };
  }

  it("a moderator sees every copy and one wave row under the latest", async () => {
    const { calls } = await mount(true);
    await waitFor(() => expect(screen.getAllByTestId("chat-message")).toHaveLength(3));
    const rows = screen.getAllByTestId("chat-mod-wave");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset.count).toBe("3");
    fireEvent.click(within(rows[0] as HTMLElement).getByTestId("chat-mod-wave-delete"));
    fireEvent.click(
      within(await screen.findByTestId("chat-mod-wave-delete-dialog")).getByTestId("confirm-dialog-confirm"),
    );
    await waitFor(() => expect(calls.deletes).toHaveLength(3));
  });

  it("a viewer never gets the moderator row", async () => {
    await mount(false);
    await waitFor(() => expect(screen.getAllByTestId("chat-message").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("chat-mod-wave")).toBeNull();
  });
});
