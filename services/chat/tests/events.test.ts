// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { EVENTS, type dto } from "@commonair/contracts";
import { chatMessageEvent, fragmentsOf, isInlineEvent } from "../src/events.ts";
import { channel } from "./fixtures.ts";

describe("fragmentsOf", () => {
  test("splits text, emotes and mentions", () => {
    const body = "hi @Bob Kappa ok";
    expect(fragmentsOf(body, [{ emoteId: "e1", code: "Kappa", start: 8, end: 13 }])).toEqual([
      { type: "text", text: "hi ", emote: null },
      { type: "mention", text: "@Bob", emote: null },
      { type: "text", text: " ", emote: null },
      { type: "emote", text: "Kappa", emote: { id: "e1" } },
      { type: "text", text: " ok", emote: null },
    ]);
  });

  test("fragments concatenate back to the body", () => {
    const body = "😀 Kappa @x_y_z!";
    const frags = fragmentsOf(body, [{ emoteId: "e", code: "Kappa", start: 3, end: 8 }]);
    expect(frags.map((x) => x.text).join("")).toBe(body);
  });
});

describe("chatMessageEvent", () => {
  test("matches the channel.chat.message payload schema", () => {
    const message: dto.ChatMessage = {
      id: "0192f5a0-0000-7000-8000-000000000001",
      channelId: "00000000-0000-7000-8000-0000000000c1",
      user: {
        id: "0192f5a0-0000-7000-8000-000000000002",
        username: "alice",
        displayName: "Alice",
        color: "chat-3",
        badges: [{ type: "subscriber", tier: 2 }, { type: "bot" }],
        accountType: "bot",
      },
      body: "hello Kappa",
      emotes: [{ emoteId: "e", code: "Kappa", start: 6, end: 11 }],
      isAction: false,
      replyTo: { id: "0192f5a0-0000-7000-8000-000000000003", username: "bob", body: "hey" },
      createdAt: "2026-10-18T12:00:00.000Z",
    };
    const evt = chatMessageEvent(channel(), message);
    expect(evt.type).toBe("channel.chat.message");
    expect(evt.channelId).toBe(channel().id);
    const payload = EVENTS["channel.chat.message"].payload.parse(evt.payload);
    expect(payload.badges).toEqual([
      { set_id: "subscriber", id: "2" },
      { set_id: "bot", id: "1" },
    ]);
    expect(payload.is_bot).toBe(true);
    expect(payload.reply?.parent_user_login).toBe("bob");
    expect(payload.broadcaster_user_login).toBe("streamer");
  });
});

describe("isInlineEvent", () => {
  test.each([
    ["channel.subscribe", true],
    ["channel.subscription.gift", true],
    ["channel.tip", true],
    ["channel.raid", true],
    ["channel.poll.begin", true],
    ["channel.prediction.lock", true],
    ["channel.chat.message", false],
    ["channel.follow", false],
    ["channel.subscription.end", false],
  ])("%s → %s", (type, expected) => expect(isInlineEvent(type)).toBe(expected));
});
