// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The stream manager's activity feed, each kind it shows: `activityFromEvent` for subs, gifts,
 * tips and raids (ids from `seq`, the arrival time), the cap and de-duplication edges of
 * `pushActivity`, `ActivityText` for every kind including the anonymous and missing-number
 * fallbacks, and `chatActivitySource` wiring a chat connection's event frames to the feed and
 * stopping it on unsubscribe.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ACTIVITY_MAX, activityFromEvent, pushActivity, type ActivityItem } from "../src/components/studio/activity.ts";
import {
  ActivityFeed,
  ActivityText,
  chatActivitySource,
  type ActivitySource,
} from "../src/components/studio/activity-feed.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const conn = vi.hoisted(() => ({
  instances: [] as {
    channel: string;
    deps: { getToken: () => unknown; createSocket: (url: string) => unknown };
    events: { onEvent: (type: string, data: unknown) => void } & Record<string, (...args: unknown[]) => unknown>;
    started: boolean;
    stopped: boolean;
  }[],
}));

vi.mock("../src/chat/connection.ts", () => ({
  ChatConnection: class {
    channel: string;
    deps: { getToken: () => unknown; createSocket: (url: string) => unknown };
    events: { onEvent: (type: string, data: unknown) => void } & Record<string, (...args: unknown[]) => unknown>;
    started = false;
    stopped = false;
    constructor(channel: string, deps: never, events: never) {
      this.channel = channel;
      this.deps = deps;
      this.events = events;
      conn.instances.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
  },
}));

const api = vi.hoisted(() => ({ tokens: 0 }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    chat: {
      connectToken: async () => {
        api.tokens++;
        return { token: "t" };
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  conn.instances.length = 0;
  api.tokens = 0;
});

const broadcaster = {
  broadcaster_user_id: "01900000-0000-7000-8000-000000000001",
  broadcaster_user_login: "aurora",
  broadcaster_user_name: "Aurora",
};
const AT = "2026-11-06T12:00:00.000Z";

const subscribe = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  user_id: "u1",
  user_login: "mothwing",
  user_name: "Mothwing",
  tier: "2000",
  is_gift: false,
  ...over,
});
const gift = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  user_id: "u2",
  user_login: "kanjikat",
  user_name: "KanjiKat",
  total: 5,
  tier: "3000",
  is_anonymous: false,
  ...over,
});
const tip = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  user_id: "u3",
  user_login: "wren",
  user_name: "Wren",
  is_anonymous: false,
  amount: { value: 500, decimal_places: 2, currency: "usd" },
  message: "Great stream",
  ...over,
});
const raid = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  from_broadcaster_user_id: "01900000-0000-7000-8000-000000000002",
  from_broadcaster_user_login: "lumen",
  from_broadcaster_user_name: "Lumen",
  to_broadcaster_user_id: broadcaster.broadcaster_user_id,
  to_broadcaster_user_login: "aurora",
  to_broadcaster_user_name: "Aurora",
  viewers: 12,
  ...over,
});

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  id: "x",
  kind: "follow",
  name: null,
  tier: null,
  count: null,
  amount: null,
  viewers: null,
  title: null,
  drawn: null,
  at: AT,
  ...over,
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

describe("activityFromEvent: subs, gifts, tips, raids", () => {
  it("a sub carries the name and tier, an id from its type and seq, and the arrival time", () => {
    expect(activityFromEvent("channel.subscribe", subscribe(), AT, 7)).toEqual(
      item({ id: "channel.subscribe:7", kind: "subscribe", name: "Mothwing", tier: 2 }),
    );
  });

  it("a gifted sub is summarised by the gift row, so it is not an item of its own", () => {
    expect(activityFromEvent("channel.subscribe", subscribe({ is_gift: true }), AT, 0)).toBeNull();
  });

  it("a gift carries the gifter, the tier and how many", () => {
    expect(activityFromEvent("channel.subscription.gift", gift(), AT, 1)).toMatchObject({
      id: "channel.subscription.gift:1",
      kind: "gift",
      name: "KanjiKat",
      tier: 3,
      count: 5,
    });
  });

  it("a tip carries the amount in cents with its currency", () => {
    const got = activityFromEvent("channel.tip", tip(), AT, 2);
    expect(got).toMatchObject({ kind: "tip", name: "Wren", amount: { cents: 500 } });
    expect(got?.amount?.currency.toLowerCase()).toBe("usd");
  });

  it("a raid carries the raider and the verified viewers", () => {
    expect(activityFromEvent("channel.raid", raid(), AT, 3)).toMatchObject({
      id: "channel.raid:3",
      kind: "raid",
      name: "Lumen",
      viewers: 12,
    });
  });

  it("the same frame twice gets two ids when seq differs (events with no id of their own)", () => {
    const a = activityFromEvent("channel.raid", raid(), AT, 0);
    const b = activityFromEvent("channel.raid", raid(), AT, 1);
    expect(a?.id).not.toBe(b?.id);
  });

  it("a follow is keyed by follower and time (two connections deliver it once), the login without a name", () => {
    const follow = {
      ...broadcaster,
      user_id: "01900000-0000-7000-8000-000000000003",
      user_login: "pip",
      user_name: "",
      followed_at: "2026-11-06T11:00:00.000Z",
    };
    expect(activityFromEvent("channel.follow", follow, AT, 0)).toEqual(
      item({
        id: "follow:01900000-0000-7000-8000-000000000003:2026-11-06T11:00:00.000Z",
        kind: "follow",
        name: "pip",
        at: "2026-11-06T11:00:00.000Z",
      }),
    );
    expect(activityFromEvent("channel.follow", { ...follow, user_name: "Pip" }, AT, 9)?.name).toBe("Pip");
  });

  it("a cancelled giveaway is not drawn and takes its own end time", () => {
    const got = activityFromEvent(
      "channel.giveaway.end",
      {
        ...broadcaster,
        id: "01900000-0000-7000-8000-0000000000a2",
        title: "Prints",
        status: "cancelled",
        entries: 4,
        winners: 0,
        seed: null,
        started_at: "2026-11-06T09:00:00.000Z",
        ended_at: "2026-11-06T09:30:00.000Z",
      },
      AT,
      0,
    );
    expect(got).toMatchObject({ kind: "giveaway", drawn: false, count: 0, at: "2026-11-06T09:30:00.000Z" });
  });

  it("drops payloads that do not validate and types the feed does not show", () => {
    expect(activityFromEvent("channel.subscribe", { nope: true }, AT, 0)).toBeNull();
    expect(activityFromEvent("channel.follow", { user_login: "pip" }, AT, 0)).toBeNull();
    expect(activityFromEvent("channel.giveaway.end", { id: "x" }, AT, 0)).toBeNull();
    expect(activityFromEvent("channel.chat.message", {}, AT, 0)).toBeNull();
    expect(activityFromEvent("", null, AT, 0)).toBeNull();
  });
});

describe("pushActivity edges", () => {
  it("puts the new item on top and keeps ACTIVITY_MAX by default", () => {
    let list: ActivityItem[] = [];
    for (let i = 0; i < ACTIVITY_MAX + 5; i++) list = pushActivity(list, item({ id: `i${i}` }));
    expect(list).toHaveLength(ACTIVITY_MAX);
    expect(list[0]?.id).toBe(`i${ACTIVITY_MAX + 4}`);
    expect(list.at(-1)?.id).toBe("i5");
  });

  it("a repeated id returns a copy, never the same array", () => {
    const list = [item({ id: "a" })];
    const next = pushActivity(list, item({ id: "a", name: "changed" }));
    expect(next).toEqual(list);
    expect(next).not.toBe(list);
  });

  it("a cap of 0 or below keeps nothing", () => {
    expect(pushActivity([], item({ id: "a" }), 0)).toEqual([]);
    expect(pushActivity([], item({ id: "a" }), -3)).toEqual([]);
  });
});

describe("ActivityText", () => {
  const text = (i: ActivityItem) => {
    const { container } = wrap(<ActivityText item={i} />);
    const out = container.textContent ?? "";
    cleanup();
    return out;
  };
  const anon = t("studio.activity.anonymous");

  it("an anonymous follow names no one", () => {
    expect(text(item({ kind: "follow" }))).toBe(t("studio.activity.follow", { name: anon }));
  });

  it("a sub without a tier reads as tier 1", () => {
    expect(text(item({ kind: "subscribe", name: "M" }))).toBe(t("studio.activity.subscribe", { name: "M", tier: 1 }));
    expect(text(item({ kind: "subscribe", name: "M", tier: 3 }))).toBe(
      t("studio.activity.subscribe", { name: "M", tier: 3 }),
    );
  });

  it("a gift without a count or tier reads as one tier-1 sub", () => {
    expect(text(item({ kind: "gift", name: null }))).toBe(t("studio.activity.gift", { name: anon, count: 1, tier: 1 }));
    expect(text(item({ kind: "gift", name: "K", count: 5, tier: 2 }))).toBe(
      t("studio.activity.gift", { name: "K", count: 5, tier: 2 }),
    );
  });

  it("a tip shows the amount, and only the line when there is none", () => {
    const withAmount = text(item({ kind: "tip", name: "W", amount: { cents: 500, currency: "USD" } }));
    expect(withAmount.startsWith(t("studio.activity.tip", { name: "W" }))).toBe(true);
    expect(withAmount).toContain("5");
    expect(text(item({ kind: "tip", name: "W" })).trim()).toBe(t("studio.activity.tip", { name: "W" }));
  });

  it("a raid without a count reads 0 viewers", () => {
    expect(text(item({ kind: "raid", name: "L" }))).toBe(t("studio.activity.raid", { name: "L", count: 0 }));
    expect(text(item({ kind: "raid", name: "L", viewers: 9 }))).toBe(
      t("studio.activity.raid", { name: "L", count: 9 }),
    );
  });

  it("a giveaway: drawn with its winners, cancelled otherwise, an empty title when missing", () => {
    expect(text(item({ kind: "giveaway", drawn: true, title: "Prints", count: 2 }))).toBe(
      t("studio.activity.giveawayDrawn", { title: "Prints", count: 2 }),
    );
    expect(text(item({ kind: "giveaway", drawn: true }))).toBe(
      t("studio.activity.giveawayDrawn", { title: "", count: 0 }),
    );
    expect(text(item({ kind: "giveaway", drawn: false, title: "Prints" }))).toBe(
      t("studio.activity.giveawayCancelled", { title: "Prints" }),
    );
    expect(text(item({ kind: "giveaway", drawn: null }))).toBe(t("studio.activity.giveawayCancelled", { title: "" }));
  });
});

describe("ActivityFeed with a source", () => {
  it("subscribes for its channel, lists items newest first, and unsubscribes on unmount", () => {
    let emit: (type: string, data: unknown) => void = () => undefined;
    const unsubscribe = vi.fn<() => void>();
    const source = vi.fn<ActivitySource>((_channel, onEvent) => {
      emit = onEvent;
      return unsubscribe;
    });
    const { unmount } = wrap(<ActivityFeed channel="aurora" source={source} />);
    expect(source).toHaveBeenCalledWith("aurora", expect.any(Function));
    expect(screen.getByTestId("stream-activity-empty")).toBeTruthy();
    act(() => emit("channel.subscribe", subscribe()));
    act(() => emit("channel.tip", tip()));
    act(() => emit("channel.subscribe", { broken: true }));
    const items = screen.getAllByTestId("stream-activity-item");
    expect(items.map((i) => i.dataset.kind)).toEqual(["tip", "subscribe"]);
    expect(screen.getByTestId("stream-activity").dataset.count).toBe("2");
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("chatActivitySource", () => {
  it("starts a chat connection for the channel, forwards only its event frames, and stops it", async () => {
    const seen: [string, unknown][] = [];
    const stop = chatActivitySource("aurora", (type, data) => seen.push([type, data]));
    const c = conn.instances[0];
    if (!c) throw new Error("no connection");
    expect(c.channel).toBe("aurora");
    expect(c.started).toBe(true);
    // The socket it opens is a real WebSocket on the URL it is given; the token comes from the API.
    await c.deps.getToken();
    expect(api.tokens).toBe(1);
    const created: string[] = [];
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor(url: string) {
        created.push(url);
      }
    } as unknown as typeof WebSocket;
    try {
      c.deps.createSocket("wss://chat.example.test/ws");
    } finally {
      globalThis.WebSocket = Original;
    }
    expect(created).toEqual(["wss://chat.example.test/ws"]);
    // Everything but events is ignored.
    for (const k of ["onStatus", "onJoined", "onMessage", "onDelete", "onClear", "onNotice"])
      expect(c.events[k]?.()).toBeUndefined();
    c.events.onEvent("channel.follow", { a: 1 });
    expect(seen).toEqual([["channel.follow", { a: 1 }]]);
    expect(c.stopped).toBe(false);
    stop();
    expect(c.stopped).toBe(true);
  });

  it("is the feed's default source", () => {
    const { unmount } = wrap(<ActivityFeed channel="lumen" />);
    expect(conn.instances.map((c) => c.channel)).toEqual(["lumen"]);
    unmount();
    expect(conn.instances[0]?.stopped).toBe(true);
  });
});
