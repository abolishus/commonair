// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { ChannelChatSettings } from "@commonair/contracts";
import type { ChatMessage } from "@commonair/contracts/dto";
import { parseMessage } from "../src/irc/message.ts";
import {
  badgesTag,
  clearchat,
  clearmsg,
  parseBadgeStrings,
  privmsg,
  render,
  roomstate,
  usernotice,
  type EventContext,
} from "../src/translate.ts";

const room = { slug: "dallas", channelId: "0190f1c2-0000-7000-8000-00000000c0de" };
const settings = ChannelChatSettings.parse({});
const broadcaster = {
  broadcaster_user_id: room.channelId,
  broadcaster_user_login: "dallas",
  broadcaster_user_name: "Dallas",
};

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "0190f1c2-0000-7000-8000-000000000001",
    channelId: room.channelId,
    user: {
      id: "0190f1c2-0000-7000-8000-0000000000aa",
      username: "ronni",
      displayName: "Ronni",
      color: "chat-3",
      badges: [{ type: "subscriber", tier: 2 }, { type: "broadcaster" }],
      accountType: "human",
    },
    body: "Kappa hi",
    emotes: [{ emoteId: "25", code: "Kappa", start: 0, end: 5 }],
    isAction: false,
    replyTo: null,
    createdAt: "2026-10-18T12:00:00.000Z",
    ...over,
  };
}

describe("PRIVMSG", () => {
  test("Twitch tag set, order and prefix", () => {
    const line = render(privmsg(room, message()), true);
    expect(line).toBe(
      "@badge-info=;badges=broadcaster/1,subscriber/2000;color=#008000;display-name=Ronni;emotes=25:0-4;first-msg=0;flags=;" +
        "id=0190f1c2-0000-7000-8000-000000000001;mod=0;returning-chatter=0;room-id=0190f1c2-0000-7000-8000-00000000c0de;" +
        "subscriber=1;tmi-sent-ts=1792324800000;turbo=0;user-id=0190f1c2-0000-7000-8000-0000000000aa;user-type= " +
        ":ronni!ronni@ronni.tmi.twitch.tv PRIVMSG #dallas :Kappa hi",
    );
  });

  test("moderators get mod=1 and user-type=mod; VIPs get vip=1", () => {
    const m = privmsg(room, message({ user: { ...message().user, badges: [{ type: "moderator" }, { type: "vip" }] } }));
    expect(m.tags).toMatchObject({
      mod: "1",
      "user-type": "mod",
      vip: "1",
      subscriber: "0",
      badges: "moderator/1,vip/1",
    });
  });

  test("actions are CTCP ACTION, display names are escaped, replies carry reply-parent tags", () => {
    const m = message({
      isAction: true,
      body: "waves",
      emotes: [],
      user: { ...message().user, displayName: "Ron Ni;" },
      replyTo: { id: "0190f1c2-0000-7000-8000-000000000002", username: "dallas", body: "hello there" },
    });
    const parsed = parseMessage(render(privmsg(room, m), true));
    expect(parsed?.params).toEqual(["#dallas", "\x01ACTION waves\x01"]);
    expect(parsed?.tags).toMatchObject({
      "display-name": "Ron Ni;",
      "reply-parent-msg-id": "0190f1c2-0000-7000-8000-000000000002",
      "reply-parent-user-login": "dallas",
      "reply-parent-display-name": "dallas",
      "reply-parent-msg-body": "hello there",
    });
  });

  test("without twitch.tv/tags no tags are written", () => {
    expect(render(privmsg(room, message()), false)).toBe(":ronni!ronni@ronni.tmi.twitch.tv PRIVMSG #dallas :Kappa hi");
  });
});

describe("badges", () => {
  test("Twitch order and versions", () => {
    expect(
      badgesTag([
        { type: "member" },
        { type: "subscriber", tier: 1 },
        { type: "bot" },
        { type: "staff" },
        { type: "moderator" },
        { type: "unknown" },
      ]),
    ).toBe("staff/1,moderator/1,subscriber/0,bot-badge/1,member/1");
    expect(badgesTag([{ type: "subscriber", tier: 3 }])).toBe("subscriber/3000");
    expect(badgesTag([])).toBe("");
  });

  test("parses joined.me badge strings", () => {
    expect(parseBadgeStrings(["broadcaster", "subscriber/2", "vip:1", "bot"])).toEqual([
      { type: "broadcaster", tier: undefined },
      { type: "subscriber", tier: 2 },
      { type: "vip", tier: 1 },
      { type: "bot", tier: undefined },
    ]);
  });
});

describe("ROOMSTATE", () => {
  test("full state on join with -1 for followers-only off", () => {
    expect(render(roomstate(room, settings)!, true)).toBe(
      `@emote-only=0;followers-only=-1;r9k=0;room-id=${room.channelId};slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #dallas`,
    );
  });

  test("changes carry only the changed keys plus room-id; no change → null", () => {
    const next = { ...settings, slowModeSeconds: 30, followersOnlyMinutes: 0 };
    expect(roomstate(room, next, settings)?.tags).toEqual({
      "followers-only": "0",
      "room-id": room.channelId,
      slow: "30",
    });
    expect(roomstate(room, settings, settings)).toBeNull();
  });
});

describe("CLEARCHAT / CLEARMSG", () => {
  const now = Date.parse("2026-10-18T12:00:00.000Z");
  const userId = "0190f1c2-0000-7000-8000-0000000000bb";

  test("timeout carries ban-duration in whole seconds", () => {
    const line = clearchat(
      room,
      { op: "ban", channel: "dallas", userId, username: "troll", expiresAt: "2026-10-18T12:10:00.000Z", reason: "" },
      now,
    );
    expect(render(line, true)).toBe(
      `@ban-duration=600;room-id=${room.channelId};target-user-id=${userId};tmi-sent-ts=${now} :tmi.twitch.tv CLEARCHAT #dallas :troll`,
    );
  });

  test("permanent ban has no ban-duration; clear has no target", () => {
    const ban = clearchat(
      room,
      { op: "ban", channel: "dallas", userId, username: "troll", expiresAt: null, reason: "x" },
      now,
    );
    expect(ban.tags).not.toHaveProperty("ban-duration");
    expect(ban.trailing).toBe("troll");
    expect(render(clearchat(room, { op: "clear", channel: "dallas" }, now), true)).toBe(
      `@room-id=${room.channelId};tmi-sent-ts=${now} :tmi.twitch.tv CLEARCHAT #dallas`,
    );
  });

  test("CLEARMSG has login and target-msg-id and always a trailing param", () => {
    const id = "0190f1c2-0000-7000-8000-000000000009";
    const line = render(
      clearmsg(room, { op: "delete", channel: "dallas", messageId: id, username: "ronni" }, "", now),
      true,
    );
    expect(line).toBe(
      `@login=ronni;room-id=${room.channelId};target-msg-id=${id};tmi-sent-ts=${now} :tmi.twitch.tv CLEARMSG #dallas :`,
    );
  });
});

describe("USERNOTICE from upstream events", () => {
  const user = { user_id: "0190f1c2-0000-7000-8000-0000000000cc", user_login: "fan", user_name: "Fan" };
  const ev = (type: string, data: Record<string, unknown>) => ({ op: "event" as const, channel: "dallas", type, data });

  test("sub", () => {
    const m = usernotice(room, ev("channel.subscribe", { ...broadcaster, ...user, tier: "1000", is_gift: false }), {
      giftPool: null,
    });
    expect(m?.command).toBe("USERNOTICE");
    expect(m?.tags).toMatchObject({
      "msg-id": "sub",
      login: "fan",
      "display-name": "Fan",
      "user-id": user.user_id,
      "msg-param-sub-plan": "1000",
      "room-id": room.channelId,
      "system-msg": "Fan subscribed at Tier 1.",
    });
  });

  test("submysterygift then subgifts are attributed to the gifter until the pool is used up", () => {
    const ctx: EventContext = { giftPool: null, now: 1000 };
    const gifter = { user_id: "0190f1c2-0000-7000-8000-0000000000dd", user_login: "giver", user_name: "Giver" };
    const mystery = usernotice(
      room,
      ev("channel.subscription.gift", { ...broadcaster, ...gifter, total: 1, tier: "2000", is_anonymous: false }),
      ctx,
    );
    expect(mystery?.tags).toMatchObject({
      "msg-id": "submysterygift",
      login: "giver",
      "msg-param-mass-gift-count": "1",
    });
    const gift = usernotice(
      room,
      ev("channel.subscribe", { ...broadcaster, ...user, tier: "2000", is_gift: true }),
      ctx,
    );
    expect(gift?.tags).toMatchObject({
      "msg-id": "subgift",
      login: "giver",
      "msg-param-recipient-user-name": "fan",
      "msg-param-recipient-id": user.user_id,
      "msg-param-recipient-display-name": "Fan",
    });
    const second = usernotice(
      room,
      ev("channel.subscribe", { ...broadcaster, ...user, tier: "2000", is_gift: true }),
      ctx,
    );
    expect(second?.tags).toMatchObject({ "msg-id": "subgift", login: "ananonymousgifter" });
  });

  test("raid", () => {
    const m = usernotice(
      room,
      ev("channel.raid", {
        from_broadcaster_user_id: "0190f1c2-0000-7000-8000-0000000000ee",
        from_broadcaster_user_login: "raider",
        from_broadcaster_user_name: "Raider",
        to_broadcaster_user_id: room.channelId,
        to_broadcaster_user_login: "dallas",
        to_broadcaster_user_name: "Dallas",
        viewers: 42,
      }),
      { giftPool: null },
    );
    expect(m?.tags).toMatchObject({
      "msg-id": "raid",
      "msg-param-login": "raider",
      "msg-param-displayName": "Raider",
      "msg-param-viewerCount": "42",
    });
  });

  test("tip extension carries amount and message", () => {
    const m = usernotice(
      room,
      ev("channel.tip", {
        ...broadcaster,
        ...user,
        is_anonymous: false,
        amount: { value: 500, decimal_places: 2, currency: "usd" },
        message: "great stream",
      }),
      { giftPool: null },
    );
    expect(m?.tags).toMatchObject({ "msg-id": "tip", "msg-param-amount": "500", "msg-param-currency": "USD" });
    expect(m?.trailing).toBe("great stream");
  });

  test("malformed payloads and events without an IRC form are dropped", () => {
    expect(usernotice(room, ev("channel.subscribe", { tier: "1000" }), { giftPool: null })).toBeNull();
    expect(usernotice(room, ev("channel.poll.begin", {}), { giftPool: null })).toBeNull();
  });
});
