// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { eventNeedles, referencesUser, type DeletedIdentity } from "../src/deletion/references.ts";

const U = "0190f0f0-0000-7000-8000-00000000aaaa";
const OTHER = "0190f0f0-0000-7000-8000-00000000cccc";
const CH = "0190f0f0-0000-7000-8000-00000000bbbb";

const who: DeletedIdentity = {
  id: U,
  names: ["ulla", "Ulla Q", ""],
  email: "Ulla@Example.test",
  tipMessages: new Map([[CH, new Set(["for the stream!"])]]),
};

const broadcaster = { broadcaster_user_id: OTHER, broadcaster_user_login: "sam", broadcaster_user_name: "Sam" };
const them = { user_id: U, user_login: "ulla", user_name: "Ulla Q" };
const ev = (type: string, payload: unknown, channelId: string | null = CH) => ({ type, channelId, payload });

describe("events that reference a deleted user", () => {
  const amount = { value: 250, decimal_places: 2, currency: "usd" };
  test.each([
    ["channel.follow", { ...broadcaster, ...them, followed_at: "2026-10-22T00:00:00Z" }],
    ["channel.subscribe", { ...broadcaster, ...them, tier: "1000", is_gift: false }],
    ["channel.subscription.end", { ...broadcaster, ...them, tier: "1000", is_gift: true }],
    ["channel.subscription.gift", { ...broadcaster, ...them, total: 3, tier: "1000", is_anonymous: false }],
    ["channel.tip", { ...broadcaster, ...them, is_anonymous: false, amount, message: "gg" }],
    // Their own channel's events name them as the broadcaster.
    ["stream.online", { broadcaster_user_id: U, broadcaster_user_login: "ulla", broadcaster_user_name: "Ulla Q" }],
    [
      "channel.chat.message",
      {
        ...broadcaster,
        chatter_user_id: U,
        chatter_user_login: "ulla",
        chatter_user_name: "Ulla Q",
        message_id: "m1",
        message: { text: "hello", fragments: [{ type: "text", text: "hello", emote: null }] },
        badges: [],
        color: "",
        reply: null,
        is_bot: false,
      },
    ],
    [
      // Someone else replies to them: the reply quotes their login, not their id.
      "channel.chat.message",
      {
        ...broadcaster,
        chatter_user_id: OTHER,
        chatter_user_login: "vic",
        chatter_user_name: "Vic",
        message_id: "m2",
        message: { text: "hi", fragments: [] },
        badges: [],
        color: "",
        reply: { parent_message_id: "m1", parent_user_login: "ulla", parent_message_body: "hello" },
        is_bot: false,
      },
    ],
    [
      "channel.chat.message_delete",
      { ...broadcaster, target_user_id: U, target_user_login: "ulla", target_user_name: "Ulla Q", message_id: "m1" },
    ],
    [
      "channel.ban",
      {
        ...broadcaster,
        ...them,
        moderator_user_id: OTHER,
        moderator_user_login: "mod",
        moderator_user_name: "Mod",
        reason: "",
        banned_at: "2026-10-22T00:00:00Z",
        ends_at: null,
        is_permanent: true,
      },
    ],
    [
      // As the moderator.
      "channel.ban",
      {
        ...broadcaster,
        user_id: OTHER,
        user_login: "vic",
        user_name: "Vic",
        moderator_user_id: U,
        moderator_user_login: "ulla",
        moderator_user_name: "Ulla Q",
        reason: "",
        banned_at: "2026-10-22T00:00:00Z",
        ends_at: null,
        is_permanent: false,
      },
    ],
    ["channel.moderator.add", { ...broadcaster, ...them }],
    ["channel.points.change", { ...broadcaster, ...them, delta: 5, balance: 10, reason: "watch" }],
    ["coop.membership.update", { membership_id: "x", user_id: U, class: "viewer", status: "active", basis: "share" }],
    ["coop.share.update", { share_id: "x", user_id: U, status: "held", amount_cents: 1000 }],
    ["legal.hold.placed", { hold_id: "h", user_id: U, reason_code: "law_enforcement", case_id: null }],
    [
      // A mention of them in someone else's message.
      "channel.chat.message",
      {
        ...broadcaster,
        chatter_user_id: OTHER,
        message: { text: "hi @ulla", fragments: [{ type: "mention", text: "@ulla", emote: null }] },
      },
    ],
    // Their display name as a whole value, whatever the field.
    ["coop.proposal.update", { proposal_id: "p", title: "Ulla Q", status: "open", kind: "ordinary" }],
    ["anything", { nested: [{ deep: { list: ["x", U.toUpperCase()] } }] }],
    ["anything", { contact: "ulla@example.TEST" }],
  ])("%s referencing them is theirs", (type, payload) => {
    expect(referencesUser(ev(type, payload), who)).toBe(true);
  });

  test("an anonymous tip is matched by its message on a channel they tipped", () => {
    const anon = { ...broadcaster, user_id: null, user_login: null, user_name: null, is_anonymous: true, amount };
    expect(referencesUser(ev("channel.tip", { ...anon, message: "for the stream!" }), who)).toBe(true);
    expect(referencesUser(ev("channel.tip", { ...anon, message: "for the stream!" }, OTHER), who)).toBe(false);
    expect(referencesUser(ev("channel.tip", { ...anon, message: "something else" }), who)).toBe(false);
    expect(referencesUser(ev("channel.tip", { ...anon, message: "" }), who)).toBe(false);
    expect(referencesUser(ev("channel.chat.message", { ...broadcaster, message: "for the stream!" }), who)).toBe(false);
  });

  test.each([
    ["channel.follow", { ...broadcaster, user_id: OTHER, user_login: "vic", user_name: "Vic", followed_at: "x" }],
    // Someone else's line that merely contains their name is that person's text.
    [
      "channel.chat.message",
      { ...broadcaster, chatter_user_id: OTHER, message: { text: "hey ulla, gg", fragments: [] } },
    ],
    // Near misses: case differs for names, or another name that contains theirs.
    ["channel.raid", { from_broadcaster_user_login: "ullaq", to_broadcaster_user_name: "Ulla" }],
    ["stream.offline", { ...broadcaster }],
    ["anything", null],
    ["anything", { n: 1, b: true, nil: null }],
  ])("%s about someone else is kept", (type, payload) => {
    expect(referencesUser(ev(type, payload), who)).toBe(false);
  });

  test("needles: exact names and tip messages, case-folded id and email, JSON-escaped", () => {
    expect(eventNeedles(who)).toEqual({
      exact: ["ulla", "Ulla Q", "for the stream!"],
      folded: [U, "ulla@example.test"],
    });
    const quoted = eventNeedles({ ...who, names: ['a"b\\c'], tipMessages: new Map([[CH, new Set(["x\ny"])]]) });
    expect(quoted.exact).toEqual(['a\\"b\\\\c', "x\\ny"]);
  });
});
