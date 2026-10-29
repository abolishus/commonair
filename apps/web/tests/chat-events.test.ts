// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vite-plus/test";
import { ChatConnection, MAX_MESSAGES, type ChatEvents, type ChatMessageFrame } from "../src/chat/connection.ts";
import { chatEventText, chatEventView } from "../src/chat/events.ts";
import { chatReducer, type ChatRow } from "../src/chat/state.ts";
import { badgeAttr, visibleBadges } from "../src/chat/view.ts";

const broadcaster = {
  broadcaster_user_id: "b1",
  broadcaster_user_login: "rivertide",
  broadcaster_user_name: "Rivertide",
};

const subscribe = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  user_id: "u1",
  user_login: "mothwing",
  user_name: "Mothwing",
  tier: "2000",
  is_gift: false,
  ...over,
});
const giftPayload = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  user_id: "u2",
  user_login: "kanjikat",
  user_name: "KanjiKat",
  total: 2,
  tier: "1000",
  is_anonymous: false,
  ...over,
});
const tipPayload = (over: Record<string, unknown> = {}) => ({
  ...broadcaster,
  user_id: "u3",
  user_login: "wren",
  user_name: "Wren",
  is_anonymous: false,
  amount: { value: 500, decimal_places: 2, currency: "usd" },
  message: "Great stream",
  ...over,
});

describe("chatEventView", () => {
  it("channel.subscribe → user and tier 1–3; gifted ones are summarised by the gift row", () => {
    const v = chatEventView("channel.subscribe", subscribe());
    expect(v).toMatchObject({ type: "channel.subscribe", user: "mothwing", name: "Mothwing", tier: 2, isGift: false });
    expect(v?.amount).toBeNull();
    expect(chatEventText(v!)).toBe("Mothwing subscribed at Tier 2");
    expect(chatEventView("channel.subscribe", subscribe({ tier: "3000" }))?.tier).toBe(3);
    expect(chatEventView("channel.subscribe", subscribe({ is_gift: true, tier: "3000" }))).toBeNull();
  });

  it("channel.subscription.gift → gifter and total; anonymous gifts have an empty user", () => {
    const v = chatEventView("channel.subscription.gift", giftPayload());
    expect(v).toMatchObject({ user: "kanjikat", tier: 1, total: 2 });
    expect(chatEventText(v!)).toBe("KanjiKat gifted 2 Tier 1 subs");
    expect(chatEventText(chatEventView("channel.subscription.gift", giftPayload({ total: 1 }))!)).toBe(
      "KanjiKat gifted a Tier 1 sub",
    );
    const anon = chatEventView(
      "channel.subscription.gift",
      giftPayload({ is_anonymous: true, user_id: null, user_login: null, user_name: null }),
    );
    expect(anon).toMatchObject({ user: "", name: null, total: 2 });
    expect(chatEventText(anon!)).toBe("An anonymous viewer gifted 2 Tier 1 subs");
  });

  it("channel.subscription.gift with no total → the plural's other branch, the total left empty", () => {
    const v = chatEventView("channel.subscription.gift", giftPayload())!;
    expect(chatEventText({ ...v, total: null })).toBe("KanjiKat gifted  Tier 1 subs");
    expect(chatEventText({ ...v, name: null, total: null })).toBe("An anonymous viewer gifted  Tier 1 subs");
  });

  it("channel.subscription.gift of 1,000 or more → the total is grouped (ICU `#`)", () => {
    const v = chatEventView("channel.subscription.gift", giftPayload({ total: 1000 }))!;
    expect(chatEventText(v)).toBe("KanjiKat gifted 1,000 Tier 1 subs");
    expect(chatEventText({ ...v, name: null, total: 25_000 })).toBe("An anonymous viewer gifted 25,000 Tier 1 subs");
  });

  it("channel.tip → cents, currency and message; an anonymous tip has an empty data-user", () => {
    const v = chatEventView("channel.tip", tipPayload());
    expect(v).toMatchObject({ user: "wren", amount: { cents: 500, currency: "usd" }, message: "Great stream" });
    expect(chatEventText(v!)).toBe("Wren tipped");
    // The flag wins even if a login were present.
    const anon = chatEventView("channel.tip", tipPayload({ is_anonymous: true, message: "  " }));
    expect(anon).toMatchObject({ user: "", name: null, message: null, amount: { cents: 500 } });
    expect(chatEventText(anon!)).toBe("Someone tipped");
  });

  it("drops unknown types and malformed payloads", () => {
    expect(chatEventView("channel.raid", {})).toBeNull();
    expect(chatEventView("channel.subscription.end", subscribe())).toBeNull();
    expect(chatEventView("channel.subscribe", subscribe({ tier: "4000" }))).toBeNull();
    expect(
      chatEventView("channel.tip", tipPayload({ amount: { value: 1.5, decimal_places: 2, currency: "usd" } })),
    ).toBeNull();
    expect(chatEventView("channel.subscription.gift", null)).toBeNull();
  });
});

describe("chat reducer with events", () => {
  const event = chatEventView("channel.subscribe", subscribe())!;

  it("appends event rows with their own ids", () => {
    const rows = chatReducer([], { type: "event", id: "event-1", event });
    expect(rows).toEqual([{ kind: "event", id: "event-1", event }]);
  });

  it("moderation never touches events, and a message with the same id is still added", () => {
    let rows: ChatRow[] = chatReducer([], { type: "event", id: "x", event });
    rows = chatReducer(rows, { type: "clear" });
    rows = chatReducer(rows, { type: "ban", userId: "u1", username: "mothwing" });
    rows = chatReducer(rows, { type: "delete", messageId: "x" });
    expect(rows).toEqual([{ kind: "event", id: "x", event }]);
    const message = {
      id: "x",
      user: { id: "u9", username: "fan", displayName: "Fan" },
      body: "hi",
      isAction: false,
    } as unknown as ChatMessageFrame;
    rows = chatReducer(rows, { type: "message", message });
    expect(rows.map((r) => r.kind)).toEqual(["event", "message"]);
  });

  it("events share the log cap", () => {
    let rows: ChatRow[] = [];
    for (let i = 0; i < MAX_MESSAGES + 5; i++) rows = chatReducer(rows, { type: "event", id: `e${i}`, event });
    expect(rows).toHaveLength(MAX_MESSAGES);
    expect(rows[0]?.id).toBe("e5");
  });
});

describe("chat-message badges", () => {
  it("data-badges lists every badge type once, space-separated; empty when none", () => {
    expect(badgeAttr([])).toBe("");
    expect(badgeAttr([{ type: "subscriber" }])).toBe("subscriber");
    expect(badgeAttr([{ type: "broadcaster" }, { type: "subscriber" }, { type: "subscriber" }, { type: "bot" }])).toBe(
      "broadcaster subscriber bot",
    );
  });

  it("draws the kinds the composition knows, in a fixed order, with catalog labels", () => {
    expect(visibleBadges([{ type: "subscriber" }, { type: "bot" }, { type: "moderator" }])).toEqual([
      { kind: "moderator", label: "Moderator" },
      { kind: "subscriber", label: "Subscriber" },
    ]);
    expect(visibleBadges([{ type: "staff" }])).toEqual([]);
  });
});

describe("ChatConnection event frames", () => {
  const make = () => {
    const onEvent = vi.fn<NonNullable<ChatEvents["onEvent"]>>();
    const events: ChatEvents = {
      onStatus: () => {},
      onJoined: () => {},
      onMessage: () => {},
      onDelete: () => {},
      onClear: () => {},
      onNotice: () => {},
      onEvent,
    };
    const conn = new ChatConnection(
      "rivertide",
      {
        getToken: async () => ({ token: "t", url: "ws://x" }),
        createSocket: () => {
          throw new Error("unused");
        },
      },
      events,
    );
    return { conn, onEvent };
  };

  it("dispatches this channel's events with type and data", () => {
    const { conn, onEvent } = make();
    const data = tipPayload();
    conn.handleFrame(JSON.stringify({ op: "event", channel: "rivertide", type: "channel.tip", data }));
    expect(onEvent).toHaveBeenCalledWith("channel.tip", data);
  });

  it("ignores other channels' events and invalid frames", () => {
    const { conn, onEvent } = make();
    conn.handleFrame(JSON.stringify({ op: "event", channel: "mothwing", type: "channel.tip", data: tipPayload() }));
    conn.handleFrame(JSON.stringify({ op: "event", channel: "rivertide", type: "channel.tip" }));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
