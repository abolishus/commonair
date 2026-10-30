// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Calm Chat and blocks in the DOM (W1-calm-chat): the wave row in dark and light at 320 px (render
 * tests standing in for stories), the per-message menu for a viewer and a moderator, the replay
 * disclosure in both modes, blocked users hidden (and a block taking effect at once), the rate
 * governor and digest region on the real panel, `data-media-ts`, a mid-surge join reaching the
 * banner, and the blocked-users section on `/settings/privacy`.
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
import { blockSnapshot, noteBlocked, resetBlocks, type BlocksClient } from "../src/chat/blocks.ts";
import { calmRows } from "../src/chat/calm/reducer.ts";
import { setCalmStorage, writeCalmSettings } from "../src/chat/calm/settings.ts";
import { WaveRow } from "../src/chat/calm/wave-row.tsx";
import { ChatPanel } from "../src/chat/chat-panel.tsx";
import type { ChatMessageFrame, SocketLike } from "../src/chat/connection.ts";
import type { InteractClient } from "../src/chat/interact/client.ts";
import { MessageMenu } from "../src/chat/mod-menu.tsx";
import type { ChatRow } from "../src/chat/state.ts";
import { BlockedUsers, type BlockedUsersClient } from "../src/components/blocks/blocked-users.tsx";
import type { ReportClient } from "../src/components/safety/client.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const banner = vi.hoisted(() => ({ props: [] as unknown[] }));
// A presentation queue that can hold lines (W1-player's real one holds up to 60 s with sync on).
const queue = vi.hoisted(() => ({ hold: false, held: [] as (() => void)[] }));
vi.mock("../src/chat/presentation.ts", () => ({
  presentationQueue: () => ({
    present: <T,>(item: T, show: (item: T) => void) => {
      if (queue.hold) queue.held.push(() => show(item));
      else show(item);
    },
    syncChat: false,
    dispose: () => {},
  }),
}));
vi.mock("../src/chat/surge-banner.tsx", () => ({
  SurgeBanner: (props: unknown) => {
    banner.props.push(props);
    return null;
  },
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    chat: {
      connectToken: async () => ({ token: "t", url: "ws://chat.test/ws" }),
      held: { list: async () => [] },
    },
  };
  return { ...actual, api: () => client };
});

const UUID = (n: number) => `0194f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const CHANNEL = "rivertide";
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

function msg(
  n: number,
  body: string,
  o: {
    user?: number;
    username?: string;
    at?: number;
    mediaTs?: string | null;
    replyTo?: ChatMessageFrame["replyTo"];
  } = {},
): ChatMessageFrame {
  const user = o.user ?? 100 + n;
  const username = o.username ?? `user${user}`;
  return {
    id: UUID(n),
    channelId: UUID(9999),
    user: { id: UUID(user), username, displayName: `Name ${username}`, color: null, badges: [], accountType: "human" },
    body,
    emotes: [],
    isAction: false,
    replyTo: o.replyTo ?? null,
    mediaTs: o.mediaTs,
    createdAt: new Date(T0 + (o.at ?? n)).toISOString(),
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const wrap = (node: React.ReactNode) => (
  <LocaleProvider locale={locale} messages={uiMessages}>
    <TooltipProvider>{node}</TooltipProvider>
  </LocaleProvider>
);
const all = (id: string, root: ParentNode = document) => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const one = (id: string, root: ParentNode = document) => {
  const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing ${id}`);
  return el;
};

beforeEach(() => {
  const storage = memoryStorage();
  setCalmStorage(() => storage);
  resetBlocks();
  banner.props = [];
  queue.hold = false;
  queue.held = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setCalmStorage(null);
  resetBlocks();
});

describe("WaveRow (stories: dark and light at 320 px)", () => {
  const waveOf = (n: number, senders: number) => {
    const rows: ChatRow[] = Array.from({ length: n }, (_, i) => ({
      kind: "message",
      id: UUID(i + 1),
      message: msg(i + 1, "PogChamp", { user: (i % senders) + 1 }),
      deleted: false,
    }));
    const v = calmRows(rows, { self: null })[0];
    if (v?.kind !== "wave") throw new Error("no wave");
    return v.wave;
  };

  for (const theme of ["dark", "light"] as const)
    it(`renders the count, senders and controls (${theme})`, () => {
      function Story() {
        const [open, setOpen] = React.useState(false);
        return (
          <div className={theme === "dark" ? "dark w-80" : "w-80"} data-theme={theme}>
            <WaveRow
              wave={waveOf(312, 12)}
              expanded={open}
              onToggle={() => setOpen((o) => !o)}
              canReport
              renderMessage={(m) => <p data-testid="wave-member">{m.body}</p>}
            />
          </div>
        );
      }
      const { container } = render(wrap(<Story />));
      const row = one("chat-wave", container);
      expect(row.dataset.count).toBe("312");
      expect(row.dataset.senders).toBe("12");
      expect(row.textContent).toContain("PogChamp");
      expect(row.textContent).toContain("×312");
      expect(row.textContent).toContain("from 12 people");
      expect(row.getAttribute("aria-label")).toBe("PogChamp: repeated 312 times by 12 people");
      expect(one("chat-report-wave", container).getAttribute("aria-label")).toBe(t("calmChat.wave.report"));
      const expand = one("chat-wave-expand", container);
      expect(expand.getAttribute("aria-expanded")).toBe("false");
      expect(all("wave-member", container)).toHaveLength(0);
      fireEvent.click(expand);
      expect(all("wave-member", container)).toHaveLength(312);
      expect(one("chat-wave-expand", container).getAttribute("aria-expanded")).toBe("true");
    });

  it("one sender: no 'from N people'; signed out: no report", () => {
    const { container } = render(
      wrap(
        <WaveRow
          wave={waveOf(3, 1)}
          expanded={false}
          onToggle={() => {}}
          canReport={false}
          renderMessage={() => null}
        />,
      ),
    );
    expect(one("chat-wave", container).textContent).not.toContain("from");
    expect(container.querySelector('[data-testid="chat-report-wave"]')).toBeNull();
  });

  it("Report wave files one message_set report with the wave's messages, newest first", async () => {
    const report = vi.fn<ReportClient["report"]>(async () => ({ id: UUID(7777) }));
    const wave = waveOf(3, 3);
    render(
      wrap(
        <WaveRow
          wave={wave}
          expanded={false}
          onToggle={() => {}}
          canReport
          reportClient={{ report }}
          renderMessage={() => null}
        />,
      ),
    );
    fireEvent.click(one("chat-report-wave"));
    const dialog = await waitFor(() => one("report-dialog"));
    expect(dialog.dataset.subjectType).toBe("message_set");
    expect(dialog.dataset.subjectId).toBe(UUID(1));
    // Choosing a reason goes through the select; drive the form's submit with a reason chosen.
    fireEvent.click(one("report-reason"));
    const option = await waitFor(() => one("report-reason-spam"));
    fireEvent.click(option);
    fireEvent.click(one("report-submit"));
    await waitFor(() => expect(report).toHaveBeenCalled());
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      subjectType: "message_set",
      subjectId: UUID(1),
      messageIds: [UUID(3), UUID(2), UUID(1)],
      reason: "spam",
    });
  });
});

describe("MessageMenu", () => {
  const open = async () => {
    fireEvent.click(one("chat-message-actions"));
    return waitFor(() => one("chat-user-block"));
  };

  it("a viewer gets Block only", async () => {
    const onBlock = vi.fn<() => void>();
    render(wrap(<MessageMenu displayName="Troll" onBlock={onBlock} />));
    expect(one("chat-message-actions").getAttribute("aria-label")).toBe("Actions for Troll");
    const item = await open();
    expect(item.textContent).toContain("Block Troll");
    expect(document.querySelector('[data-testid="chat-mod-timeout"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-mod-ban"]')).toBeNull();
    fireEvent.click(item);
    expect(onBlock).toHaveBeenCalledTimes(1);
  });

  it("a moderator gets timeout and ban as before, and Block", async () => {
    const onTimeout = vi.fn<() => void>();
    const onBan = vi.fn<() => void>();
    render(wrap(<MessageMenu displayName="Troll" onBlock={() => {}} moderation={{ onTimeout, onBan }} />));
    expect(one("chat-message-actions").getAttribute("aria-label")).toBe(t("chat.mod.actionsFor", { name: "Troll" }));
    await open();
    one("chat-mod-ban");
    fireEvent.click(one("chat-mod-timeout"));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ the real panel

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

const SETTINGS = {
  slowModeSeconds: 0,
  followersOnlyMinutes: null,
  subscribersOnly: false,
  emoteOnly: false,
  minAccountAgeDays: 0,
  requireVerifiedEmail: true,
  linksAllowed: true,
  minVerifiedWatchSeconds: 0,
  verifiedWatchExemptSubscribers: true,
  surgeGuard: { enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 },
};

const interact: InteractClient = {
  pollCurrent: async () => null,
  predictionCurrent: async () => null,
  vote: vi.fn<InteractClient["vote"]>(),
  bet: vi.fn<InteractClient["bet"]>(),
  balance: async () => ({ enabled: false, balance: 0, name: "points" }) as never,
};

const blockAdds = vi.fn<BlocksClient["add"]>(async (username) => ({
  user: { id: UUID(Number(username.replace(/\D/g, ""))), username, displayName: `Name ${username}` },
}));

function blocks(ids: string[] = []): BlocksClient {
  return {
    ids: vi.fn<BlocksClient["ids"]>(async () => ({ userIds: ids })),
    add: blockAdds,
    remove: vi.fn<BlocksClient["remove"]>(async () => ({ ok: true })),
  };
}

async function panel(opts: {
  self: string | null;
  canModerate?: boolean;
  blocksClient?: BlocksClient;
  surge?: unknown;
}) {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const root = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <ChatPanel
        channel={CHANNEL}
        signedIn={opts.self !== null}
        selfUsername={opts.self}
        interactClient={interact}
        blocksClient={opts.blocksClient ?? blocks()}
      />
    ),
  });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory() });
  render(wrap(<RouterProvider router={router} />));
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  const ws = FakeSocket.all.at(-1) as FakeSocket;
  act(() => {
    ws.push({ op: "welcome", heartbeatMs: 30_000 });
    ws.push({
      op: "joined",
      channel: CHANNEL,
      channelId: UUID(9999),
      settings: SETTINGS,
      me: { badges: [], canModerate: opts.canModerate ?? false, canChat: true },
      surge: opts.surge ?? { state: "off", until: null },
    });
  });
  await waitFor(() => expect(one("chat").dataset.state).toBe("open"));
  const send = (m: ChatMessageFrame) => act(() => ws.push({ op: "message", channel: CHANNEL, message: m }));
  return { ws, send };
}

const messageIds = () => all("chat-message").map((m) => m.dataset.id);

describe("ChatPanel with blocks", () => {
  it("does not render blocked users' messages; replies quoting them say 'a blocked user'", async () => {
    const client = blocks([UUID(7)]);
    const { send } = await panel({ self: "fan", blocksClient: client });
    await waitFor(() => expect(blockSnapshot().ids.has(UUID(7))).toBe(true));
    send(msg(1, "hello", { user: 7, username: "troll7" }));
    send(msg(2, "hi there", { user: 8 }));
    send(msg(3, "lol", { user: 9, replyTo: { id: UUID(1), username: "troll7", body: "hello" } }));
    expect(messageIds()).toEqual([UUID(2), UUID(3)]);
    const reply = all("chat-message").find((m) => m.dataset.id === UUID(3));
    expect(reply?.textContent).toContain(t("blocks.replyToBlocked"));
    expect(reply?.textContent).not.toContain("troll7");
  });

  it("blocking from the menu hides the user at once, after a confirmation", async () => {
    const client = blocks();
    const { send } = await panel({ self: "fan", blocksClient: client });
    send(msg(1, "first", { user: 7, username: "troll7" }));
    send(msg(2, "other", { user: 8 }));
    const row = all("chat-message").find((m) => m.dataset.id === UUID(1));
    if (!row) throw new Error("no row");
    fireEvent.click(one("chat-message-actions", row));
    fireEvent.click(await waitFor(() => one("chat-user-block")));
    fireEvent.click(await waitFor(() => one("confirm-dialog-confirm")));
    await waitFor(() => expect(messageIds()).toEqual([UUID(2)]));
    expect(blockAdds).toHaveBeenCalledWith("troll7");
    send(msg(3, "again", { user: 7, username: "troll7" }));
    expect(messageIds()).toEqual([UUID(2)]);
  });

  it("moderators still see blocked users' lines in channels they moderate", async () => {
    const client = blocks([UUID(7)]);
    const { send } = await panel({ self: "mod", canModerate: true, blocksClient: client });
    await waitFor(() => expect(blockSnapshot().ids.has(UUID(7))).toBe(true));
    send(msg(1, "rule-breaking line", { user: 7, username: "troll7" }));
    send(msg(2, "re", { user: 8, replyTo: { id: UUID(1), username: "troll7", body: "x" } }));
    expect(messageIds()).toEqual([UUID(1), UUID(2)]);
    expect(all("chat-message")[1]?.textContent).not.toContain(t("blocks.replyToBlocked"));
  });

  it("no menu on your own messages; signed out no menu at all", async () => {
    const { send } = await panel({ self: "fan" });
    send(msg(1, "mine", { user: 5, username: "fan" }));
    send(msg(2, "theirs", { user: 6 }));
    const [mine, theirs] = all("chat-message");
    expect(mine?.querySelector('[data-testid="chat-message-actions"]')).toBeNull();
    expect(theirs?.querySelector('[data-testid="chat-message-actions"]')).not.toBeNull();
    cleanup();
    const anon = await panel({ self: null });
    anon.send(msg(3, "theirs", { user: 6 }));
    expect(document.querySelector('[data-testid="chat-message-actions"]')).toBeNull();
  });
});

describe("ChatPanel with a presentation queue holding lines", () => {
  const release = () =>
    act(() => {
      for (const show of queue.held.splice(0)) show();
    });

  it("a line deleted, or whose author is banned, while held never shows; a clear drops what was held", async () => {
    const { ws, send } = await panel({ self: "fan" });
    queue.hold = true;
    send(msg(1, "deleted while held"));
    send(msg(2, "from the banned user", { user: 7, username: "troll7" }));
    send(msg(3, "kept"));
    act(() => {
      ws.push({ op: "delete", channel: CHANNEL, messageId: UUID(1), username: "user101" });
      ws.push({ op: "ban", channel: CHANNEL, userId: UUID(7), username: "troll7", expiresAt: null, reason: "" });
    });
    release();
    expect(messageIds()).toEqual([UUID(3)]);
    send(msg(4, "held before the clear"));
    act(() => ws.push({ op: "clear", channel: CHANNEL }));
    send(msg(5, "after the clear"));
    release();
    expect(messageIds()).toEqual([UUID(3), UUID(5)]);
    expect(all("chat-message").find((m) => m.dataset.id === UUID(3))?.dataset.deleted).toBe("true");
  });
});

describe("ChatPanel rows", () => {
  it("every chat-message carries data-media-ts (empty when unknown)", async () => {
    const { send } = await panel({ self: "fan" });
    send(msg(1, "a", { mediaTs: "2026-10-30T11:59:55.000Z" }));
    send(msg(2, "b", { mediaTs: null }));
    send(msg(3, "c"));
    expect(all("chat-message").map((m) => m.dataset.mediaTs)).toEqual(["2026-10-30T11:59:55.000Z", "", ""]);
  });

  it("the replay disclosure stays in the input area in raw and Calm modes", async () => {
    await panel({ self: "fan" });
    expect(one("chat-replay-disclosure").textContent).toContain(t("chat.replayDisclosure"));
    act(() => void writeCalmSettings({ enabled: true }));
    await waitFor(() => one("calm-digest"));
    expect(one("chat-replay-disclosure").textContent).toContain(t("chat.replayDisclosure"));
  });

  it("a mid-surge joiner's banner gets the surge from the joined frame", async () => {
    const until = "2026-10-30T12:10:00.000Z";
    await panel({ self: "fan", surge: { state: "on", until } });
    await waitFor(() =>
      expect(banner.props.at(-1)).toMatchObject({ channel: CHANNEL, surge: { state: "on", until }, gateDenied: false }),
    );
  });
});

describe("ChatPanel in Calm Chat", () => {
  it("the toggle is off by default and switches modes; moderators never see it", async () => {
    await panel({ self: "fan" });
    const toggle = one("calm-toggle");
    expect(toggle.dataset.state).toBe("off");
    expect(document.querySelector('[data-testid="calm-digest"]')).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(one("calm-toggle").dataset.state).toBe("on"));
    const digest = one("calm-digest");
    expect(digest.getAttribute("aria-live")).toBe("polite");
    cleanup();
    await panel({ self: "mod", canModerate: true });
    expect(document.querySelector('[data-testid="calm-toggle"]')).toBeNull();
    expect(document.querySelector('[data-testid="calm-digest"]')).toBeNull();
  });

  it("collapses a flood into a wave, lets at most 3 new rows a second through, and always shows mentions", async () => {
    writeCalmSettings({ enabled: true });
    const { send } = await panel({ self: "fan" });
    // Twenty copies (they take one row between them), then twenty distinct lines, then a mention.
    for (let i = 1; i <= 20; i++) send(msg(i, "PogChamp"));
    for (let i = 21; i <= 40; i++) send(msg(i, `distinct line ${i}`));
    send(msg(41, "hey @fan look"));
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...all("chat-message"), ...all("chat-wave")];
    // The mention uses up one of the three slots too.
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(all("chat-wave").map((w) => w.dataset.count)).toEqual(["20"]);
    expect(all("chat-message").map((m) => m.dataset.id)).toEqual([UUID(21), UUID(41)]);
    expect(all("chat-message").some((m) => m.dataset.id === UUID(41))).toBe(true);
    expect(all("chat-message").find((m) => m.dataset.id === UUID(41))?.dataset.mention).toBe("true");
    // Wait out the digest interval's first tick: the region says what came in.
    await waitFor(() => expect(one("calm-digest").textContent).toContain("41 new messages"), { timeout: 2_000 });
    expect(one("calm-digest").textContent).toContain("mention of you");
  });

  it("a reply to the viewer over the limit is shown (the digest counts it as a mention of you)", async () => {
    writeCalmSettings({ enabled: true });
    const { send } = await panel({ self: "fan" });
    for (let i = 1; i <= 10; i++) send(msg(i, `distinct line ${i}`));
    send(msg(11, "agreed", { replyTo: { id: UUID(99), username: "fan", body: "x" } }));
    await waitFor(() => expect(all("chat-message").some((m) => m.dataset.id === UUID(11))).toBe(true));
    expect(all("chat-message").find((m) => m.dataset.id === UUID(11))?.dataset.mention).toBe("true");
  });

  it("a shown wave keeps its row and id when the log's cap drops its first copies", async () => {
    writeCalmSettings({ enabled: true });
    const { send } = await panel({ self: "fan" });
    send(msg(1, "PogChamp"));
    await waitFor(() => expect(messageIds()).toEqual([UUID(1)]));
    send(msg(2, "PogChamp"));
    send(msg(3, "PogChamp"));
    expect(all("chat-wave").map((w) => [w.dataset.id, w.dataset.count])).toEqual([[UUID(1), "3"]]);
    // The next tick admits the copies that joined (the log takes seconds to turn over in a real flood).
    await act(() => new Promise((r) => setTimeout(r, 300)));
    // 198 other lines: the log (200 rows) drops the wave's first copy, its id's own message.
    for (let i = 4; i <= 201; i++) send(msg(i, `distinct line ${i}`));
    expect(all("chat-wave").map((w) => [w.dataset.id, w.dataset.count])).toEqual([[UUID(1), "2"]]);
    // One more copy pushes out the second: the wave (copies 3 and 202) is still the same row.
    send(msg(202, "PogChamp", { at: 202 }));
    expect(all("chat-wave").map((w) => [w.dataset.id, w.dataset.count])).toEqual([[UUID(1), "2"]]);
  });

  it("turning Calm Chat off shows every line again (the log was never changed)", async () => {
    writeCalmSettings({ enabled: true });
    const { send } = await panel({ self: "fan" });
    for (let i = 1; i <= 6; i++) send(msg(i, "spam"));
    act(() => void writeCalmSettings({ enabled: false }));
    await waitFor(() => expect(all("chat-message")).toHaveLength(6));
    expect(all("chat-wave")).toHaveLength(0);
  });

  it("j and k move focus between rows; m jumps to a mention", async () => {
    const { send } = await panel({ self: "fan" });
    send(msg(1, "one"));
    send(msg(2, "two @fan"));
    send(msg(3, "three"));
    const rows = all("chat-message");
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    rows[2]?.focus();
    fireEvent.keyDown(rows[2] as HTMLElement, { key: "k" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: "k" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "j" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: "m" });
    expect(document.activeElement).toBe(rows[1]);
    rows[0]?.focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "m" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1] as HTMLElement, { key: "j", ctrlKey: true });
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe("BlockedUsers (/settings/privacy)", () => {
  const entry = (n: number) => ({
    user: { id: UUID(n), username: `troll${n}`, displayName: `Troll ${n}` },
    createdAt: new Date(T0 - n * 60_000).toISOString(),
  });

  it("shows the empty state", async () => {
    const client: BlockedUsersClient = {
      list: async () => ({ items: [], nextCursor: null }),
      remove: vi.fn<BlockedUsersClient["remove"]>(),
    };
    render(wrap(<BlockedUsers client={client} />));
    await waitFor(() => expect(screen.getByText(t("blocks.empty"))).toBeTruthy());
    one("blocked-users");
  });

  it("lists, pages and unblocks (and the chat set follows at once)", async () => {
    noteBlocked({ id: UUID(1), username: "troll1" });
    const list = vi.fn<BlockedUsersClient["list"]>(async (cursor) =>
      cursor ? { items: [entry(3)], nextCursor: null } : { items: [entry(1), entry(2)], nextCursor: "c1" },
    );
    const remove = vi.fn<BlockedUsersClient["remove"]>(async () => ({ ok: true }));
    render(wrap(<BlockedUsers client={{ list, remove }} />));
    await waitFor(() => expect(all("blocked-user")).toHaveLength(2));
    expect(all("blocked-user").map((r) => r.dataset.username)).toEqual(["troll1", "troll2"]);
    fireEvent.click(screen.getByText(t("blocks.more")));
    await waitFor(() => expect(all("blocked-user")).toHaveLength(3));
    expect(list).toHaveBeenLastCalledWith("c1");
    const first = all("blocked-user")[0];
    if (!first) throw new Error("no row");
    const button = one("blocked-user-remove", first);
    expect(button.getAttribute("aria-label")).toBe("Unblock Troll 1");
    fireEvent.click(button);
    await waitFor(() => expect(all("blocked-user").map((r) => r.dataset.username)).toEqual(["troll2", "troll3"]));
    expect(remove).toHaveBeenCalledWith("troll1");
    expect(blockSnapshot().ids.has(UUID(1))).toBe(false);
  });

  it("a failed load offers a retry", async () => {
    const list = vi.fn<BlockedUsersClient["list"]>(async () => {
      throw new Error("down");
    });
    render(wrap(<BlockedUsers client={{ list, remove: vi.fn<BlockedUsersClient["remove"]>() }} />));
    await waitFor(() => expect(screen.getByText(t("blocks.loadFailed"))).toBeTruthy());
    list.mockResolvedValueOnce({ items: [entry(4)], nextCursor: null });
    fireEvent.click(screen.getByText(t("common.retry")));
    await waitFor(() => expect(all("blocked-user")).toHaveLength(1));
  });
});
