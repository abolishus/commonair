// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The moderator held-message queue: held frames, merge rules, render, optimistic allow/deny. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatConnection, type ChatDeps, type ChatEvents, type ChatMessageFrame } from "../src/chat/connection.ts";
import { HeldQueue, type HeldClient } from "../src/components/mod/held-queue.tsx";
import { EMPTY_HELD, heldReducer, type HeldState } from "../src/components/mod/held-state.ts";
import { e7ChatMessages } from "../src/i18n/e7-chat.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const CHANNEL = "streamer_one";
const UUID = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

function msg(n: number, over: Partial<ChatMessageFrame> = {}): ChatMessageFrame {
  return {
    id: UUID(n),
    channelId: UUID(999),
    user: {
      id: UUID(500 + n),
      username: `troll${n}`,
      displayName: `Troll ${n}`,
      color: null,
      badges: [],
      accountType: "human",
    },
    body: `held body ${n}`,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: new Date(Date.UTC(2026, 9, 27, 10, 0, n)).toISOString(),
    ...over,
  };
}

describe("held frames on the chat connection", () => {
  function connection() {
    const events = {
      onStatus: vi.fn<ChatEvents["onStatus"]>(),
      onJoined: vi.fn<ChatEvents["onJoined"]>(),
      onMessage: vi.fn<ChatEvents["onMessage"]>(),
      onHeld: vi.fn<NonNullable<ChatEvents["onHeld"]>>(),
      onDelete: vi.fn<ChatEvents["onDelete"]>(),
      onClear: vi.fn<ChatEvents["onClear"]>(),
      onNotice: vi.fn<ChatEvents["onNotice"]>(),
    } satisfies ChatEvents;
    const conn = new ChatConnection(
      CHANNEL,
      {
        getToken: async () => ({ token: "t", url: "ws://x/ws" }),
        createSocket: () => {
          throw new Error("unused");
        },
      },
      events,
    );
    return { conn, events };
  }

  it("hands held messages to onHeld, never to the chat log", () => {
    const { conn, events } = connection();
    conn.handleFrame(JSON.stringify({ op: "message", channel: CHANNEL, message: msg(1), held: true }));
    expect(events.onHeld).toHaveBeenCalledWith(msg(1));
    expect(events.onMessage).not.toHaveBeenCalled();
    conn.handleFrame(JSON.stringify({ op: "message", channel: CHANNEL, message: msg(2) }));
    expect(events.onMessage).toHaveBeenCalledWith(msg(2));
    expect(events.onHeld).toHaveBeenCalledTimes(1);
  });

  it("ignores other channels' frames and drops held frames when nobody listens", () => {
    const { conn, events } = connection();
    conn.handleFrame(JSON.stringify({ op: "message", channel: "other_one", message: msg(1), held: true }));
    expect(events.onHeld).not.toHaveBeenCalled();
    const bare = new ChatConnection(
      CHANNEL,
      { getToken: async () => ({ token: "t", url: "ws://x/ws" }), createSocket: vi.fn<ChatDeps["createSocket"]>() },
      { ...events, onHeld: undefined, onMessage: vi.fn<ChatEvents["onMessage"]>() },
    );
    expect(() =>
      bare.handleFrame(JSON.stringify({ op: "message", channel: CHANNEL, message: msg(1), held: true })),
    ).not.toThrow();
  });
});

describe("heldReducer", () => {
  it("merges the list and live frames by id, oldest first", () => {
    let s = heldReducer(EMPTY_HELD, { type: "held", message: msg(3) });
    s = heldReducer(s, { type: "loaded", messages: [msg(1), msg(3), msg(2)] });
    expect(s.items.map((m) => m.id)).toEqual([UUID(1), UUID(2), UUID(3)]);
    const same = heldReducer(s, { type: "held", message: msg(2) });
    expect(same).toBe(s);
    expect(heldReducer(s, { type: "loaded", messages: [] })).toBe(s);
  });

  it("a removed id stays out until restored; reset starts over", () => {
    let s = heldReducer(EMPTY_HELD, { type: "loaded", messages: [msg(1), msg(2)] });
    s = heldReducer(s, { type: "remove", id: UUID(1) });
    expect(s.items.map((m) => m.id)).toEqual([UUID(2)]);
    // A list fetched before the decision must not bring it back.
    s = heldReducer(s, { type: "loaded", messages: [msg(1), msg(2)] });
    expect(s.items.map((m) => m.id)).toEqual([UUID(2)]);
    expect(heldReducer(s, { type: "remove", id: UUID(1) })).toBe(s);
    s = heldReducer(s, { type: "restore", message: msg(1) });
    expect(s.items.map((m) => m.id)).toEqual([UUID(1), UUID(2)]);
    // Unknown ids (an ordinary message, a delete of a visible one) leave the state untouched.
    expect(heldReducer(s, { type: "remove", id: UUID(77) })).toBe(s);
    expect(heldReducer(s, { type: "reset" })).toBe(EMPTY_HELD);
    expect(heldReducer(EMPTY_HELD, { type: "reset" })).toBe(EMPTY_HELD);
  });

  it("ordinary message ids are not remembered, so gone stays bounded by the queue", () => {
    let s = heldReducer(EMPTY_HELD, { type: "held", message: msg(1) });
    for (let n = 100; n < 600; n++) {
      const next = heldReducer(s, { type: "remove", id: UUID(n) });
      expect(next).toBe(s);
      s = next;
    }
    expect(s.gone.size).toBe(0);
  });

  it("a ban drops the author's queued messages and keeps them out of later lists", () => {
    const other = msg(3, { user: { ...msg(1).user, id: UUID(901) } });
    let s = heldReducer(EMPTY_HELD, { type: "loaded", messages: [msg(1), msg(2), other] });
    s = heldReducer(s, { type: "removeUser", userId: UUID(501) });
    expect(s.items.map((m) => m.id)).toEqual([UUID(2), UUID(3)]);
    s = heldReducer(s, { type: "loaded", messages: [msg(1)] });
    expect(s.items.map((m) => m.id)).toEqual([UUID(2), UUID(3)]);
    expect(heldReducer(s, { type: "removeUser", userId: UUID(4242) })).toBe(s);
  });
});

function Harness({ client, initial = EMPTY_HELD }: { client: HeldClient; initial?: HeldState }) {
  const [state, dispatch] = React.useReducer(heldReducer, initial);
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <HeldQueue channel={CHANNEL} state={state} dispatch={dispatch} client={client} defaultOpen />
      </TooltipProvider>
    </LocaleProvider>
  );
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="held-message"]')];

describe("HeldQueue", () => {
  it("shows a skeleton while loading, then the empty state", async () => {
    let release: (v: ChatMessageFrame[]) => void = () => {};
    const list = vi.fn<HeldClient["list"]>(() => new Promise<ChatMessageFrame[]>((r) => (release = r)));
    const client: HeldClient = { list, resolve: vi.fn<HeldClient["resolve"]>() };
    render(<Harness client={client} />);
    await waitFor(() => expect(byId("held-queue")).not.toBeNull());
    expect(byId("held-queue")?.querySelector('[data-slot="skeleton-group"]')).not.toBeNull();
    expect(byId("held-queue-open")?.dataset.count).toBe("0");
    await act(async () => release([]));
    await waitFor(() => expect(byId("held-queue-empty")).not.toBeNull());
    expect(screen.getByText(e7ChatMessages["held.empty"])).toBeTruthy();
    expect(list).toHaveBeenCalledWith(CHANNEL);
  });

  it("lists held messages with their selectors and a count on the button", async () => {
    const client: HeldClient = {
      list: vi.fn<HeldClient["list"]>(async () => [msg(2), msg(1)]),
      resolve: vi.fn<HeldClient["resolve"]>(),
    };
    render(<Harness client={client} />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((r) => r.dataset.id)).toEqual([UUID(1), UUID(2)]);
    expect(rows()[0]?.dataset.username).toBe("troll1");
    expect(rows()[0]?.querySelector('[data-testid="held-allow"]')?.getAttribute("aria-label")).toBe(
      "Allow Troll 1's message",
    );
    expect(rows()[0]?.querySelector('[data-testid="held-deny"]')).not.toBeNull();
    expect(byId("held-queue-open")?.dataset.count).toBe("2");
    expect(byId("held-queue-open")?.getAttribute("aria-label")).toBe("Held messages (2)");
    expect(screen.getByText("held body 1")).toBeTruthy();
  });

  it("allow removes the row at once and calls resolve", async () => {
    const resolve = vi.fn<HeldClient["resolve"]>(async () => {});
    render(<Harness client={{ list: async () => [msg(1), msg(2)], resolve }} />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const allow = rows()[0]?.querySelector<HTMLElement>('[data-testid="held-allow"]');
    if (!allow) throw new Error("no allow button");
    fireEvent.click(allow);
    expect(rows().map((r) => r.dataset.id)).toEqual([UUID(2)]);
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(CHANNEL, UUID(1), true));
    expect(byId("held-queue-open")?.dataset.count).toBe("1");
  });

  it("deny that fails puts the row back", async () => {
    let fail: (e: unknown) => void = () => {};
    const resolve = vi.fn<HeldClient["resolve"]>(() => new Promise<void>((_, reject) => (fail = reject)));
    render(<Harness client={{ list: async () => [msg(1)], resolve }} />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const deny = rows()[0]?.querySelector<HTMLElement>('[data-testid="held-deny"]');
    if (!deny) throw new Error("no deny button");
    fireEvent.click(deny);
    expect(rows()).toHaveLength(0);
    expect(resolve).toHaveBeenCalledWith(CHANNEL, UUID(1), false);
    await act(async () => fail(Object.assign(new Error("nope"), { code: "INTERNAL_SERVER_ERROR" })));
    await waitFor(() => expect(rows().map((r) => r.dataset.id)).toEqual([UUID(1)]));
  });

  it("a conflict (another moderator decided) does not put the row back", async () => {
    const resolve = vi.fn<HeldClient["resolve"]>(async () => {
      throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
    });
    render(<Harness client={{ list: async () => [msg(1)], resolve }} />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const allow = rows()[0]?.querySelector<HTMLElement>('[data-testid="held-allow"]');
    if (!allow) throw new Error("no allow button");
    fireEvent.click(allow);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    await act(async () => {});
    expect(rows()).toHaveLength(0);
  });

  it("keeps live held frames when the list fails", async () => {
    const client: HeldClient = {
      list: async () => {
        throw new Error("down");
      },
      resolve: vi.fn<HeldClient["resolve"]>(),
    };
    render(<Harness client={client} initial={heldReducer(EMPTY_HELD, { type: "held", message: msg(4) })} />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]?.dataset.id).toBe(UUID(4));
  });

  it("says so when the list fails and nothing is queued", async () => {
    render(
      <Harness
        client={{
          list: async () => {
            throw new Error("down");
          },
          resolve: vi.fn<HeldClient["resolve"]>(),
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(e7ChatMessages["held.loadFailed"]));
  });
});

describe("held catalog", () => {
  it("keeps every key under held.*", () => {
    expect(Object.keys(e7ChatMessages).every((k) => k.startsWith("held."))).toBe(true);
  });
});
