// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { eventNeedles, redactPayload, referencesUser, type DeletedIdentity } from "../src/deletion/references.ts";

const U = "0190f0f0-0000-7000-8000-00000000aaaa";
const OTHER = "0190f0f0-0000-7000-8000-00000000cccc";
const CH = "0190f0f0-0000-7000-8000-00000000bbbb";

const who: DeletedIdentity = {
  id: U,
  logins: ["ulla", "Ulla", ""],
  email: "Ulla@Example.test",
  tips: [{ channelId: CH, amountCents: 250, currency: "usd", message: "for the stream!" }],
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
    // Their own channel going off air (the completion transaction itself emits this).
    ["stream.offline", { broadcaster_user_id: U, broadcaster_user_login: "ulla", broadcaster_user_name: "Ulla Q" }],
    // A login-only reference (no sibling id), case-insensitive.
    ["channel.raid", { from_broadcaster_user_login: "ULLA", to_broadcaster_user_id: OTHER }],
    ["anything", { nested: [{ deep: { list: ["x", U.toUpperCase()] } }] }],
    ["anything", { contact: "ulla@example.TEST" }],
  ])("%s referencing them is theirs", (type, payload) => {
    expect(referencesUser(ev(type, payload), who)).toBe(true);
  });

  test("an anonymous tip is matched by channel, amount, currency and message of one of their tips", () => {
    const anon = { ...broadcaster, user_id: null, user_login: null, user_name: null, is_anonymous: true, amount };
    expect(referencesUser(ev("channel.tip", { ...anon, message: "for the stream!" }), who)).toBe(true);
    expect(referencesUser(ev("channel.tip", { ...anon, message: "for the stream!" }, OTHER), who)).toBe(false);
    expect(referencesUser(ev("channel.tip", { ...anon, message: "something else" }), who)).toBe(false);
    expect(referencesUser(ev("channel.tip", { ...anon, message: "" }), who)).toBe(false);
    const other = { ...anon, message: "for the stream!" };
    expect(referencesUser(ev("channel.tip", { ...other, amount: { ...amount, value: 251 } }), who)).toBe(false);
    expect(referencesUser(ev("channel.tip", { ...other, amount: { ...amount, currency: "eur" } }), who)).toBe(false);
    // Someone else's named tip with the same words is theirs, not the deleted user's.
    const carol = { ...other, user_id: OTHER, user_login: "carol", user_name: "Carol", is_anonymous: false };
    expect(referencesUser(ev("channel.tip", carol), who)).toBe(false);
    expect(referencesUser(ev("channel.chat.message", { ...broadcaster, message: "for the stream!" }), who)).toBe(false);
  });

  test("common words as a display name, login or tip message never match other people's events", () => {
    const words: DeletedIdentity = {
      id: U,
      logins: ["usd", "text", "1000"],
      email: "w@example.test",
      tips: [{ channelId: CH, amountCents: 100, currency: "usd", message: "gg" }],
    };
    const chat = {
      ...broadcaster,
      chatter_user_id: OTHER,
      chatter_user_login: "vic",
      chatter_user_name: "text",
      message_id: "m",
      message: { text: "gg", fragments: [{ type: "text", text: "gg", emote: null }] },
      badges: [{ set_id: "subscriber", id: "1000" }],
      color: "",
      reply: null,
      is_bot: false,
    };
    const tipOf = (message: string) => ({
      ...broadcaster,
      user_id: OTHER,
      user_login: "carol",
      user_name: "usd",
      is_anonymous: false,
      amount: { value: 100, decimal_places: 2, currency: "usd" },
      message,
    });
    expect(referencesUser(ev("channel.chat.message", chat), words)).toBe(false);
    expect(referencesUser(ev("channel.tip", tipOf("gg")), words)).toBe(false);
    expect(referencesUser(ev("channel.subscribe", { ...broadcaster, user_id: OTHER, tier: "1000" }), words)).toBe(
      false,
    );
    // A login that changed hands: the id next to it is someone else's.
    expect(referencesUser(ev("channel.follow", { ...broadcaster, user_id: OTHER, user_login: "usd" }), words)).toBe(
      false,
    );
    // And redaction never touches enums, amounts or names outside free text.
    expect(redactPayload(chat, words)).toBeNull();
    expect(redactPayload(tipOf("gg"), words)).toBeNull();
  });

  test.each([
    ["channel.follow", { ...broadcaster, user_id: OTHER, user_login: "vic", user_name: "Vic", followed_at: "x" }],
    // Someone else's line that merely contains their name is that person's text.
    [
      "channel.chat.message",
      { ...broadcaster, chatter_user_id: OTHER, message: { text: "hey ulla, gg", fragments: [] } },
    ],
    // Near misses: another login that contains theirs; their display name is not an identifier.
    ["channel.raid", { from_broadcaster_user_login: "ullaq", to_broadcaster_user_name: "Ulla Q" }],
    // A mention is someone else's text: kept (and redacted, below).
    [
      "channel.chat.message",
      {
        ...broadcaster,
        chatter_user_id: OTHER,
        message: { text: "hi @ulla", fragments: [{ type: "mention", text: "@ulla", emote: null }] },
      },
    ],
    ["coop.proposal.update", { proposal_id: "p", title: "Ulla Q", status: "open", kind: "ordinary" }],
    ["stream.offline", { ...broadcaster }],
    ["anything", null],
    ["anything", { n: 1, b: true, nil: null }],
  ])("%s about someone else is kept", (type, payload) => {
    expect(referencesUser(ev(type, payload), who)).toBe(false);
  });

  test("needles: case-folded id, email and logins, JSON-escaped; short logins only as whole values or mentions", () => {
    expect(eventNeedles(who)).toEqual([U, "ulla@example.test", "ulla"]);
    expect(eventNeedles({ ...who, logins: ['a"b\\c', "al"], email: "" })).toEqual([U, 'a\\"b\\\\c', '"al"', "@al"]);
  });

  test("someone else's text that mentions them is redacted, nothing else", () => {
    const msg = {
      ...broadcaster,
      chatter_user_id: OTHER,
      chatter_user_login: "vic",
      message: {
        text: "thanks Ulla for the raid, @ulla! mail ulla@example.test; ullaq and xulla stay",
        fragments: [
          { type: "text", text: "thanks ", emote: null },
          { type: "mention", text: "@ulla", emote: null },
        ],
      },
    };
    expect(redactPayload(msg, who)).toEqual({
      ...msg,
      message: {
        text: "thanks [deleted] for the raid, [deleted]! mail [deleted]; ullaq and xulla stay",
        fragments: [
          { type: "text", text: "thanks ", emote: null },
          { type: "mention", text: "[deleted]", emote: null },
        ],
      },
    });
    expect(redactPayload({ ...broadcaster, message: { text: "hello there", fragments: [] } }, who)).toBeNull();
    // A short login is redacted only as an @mention.
    const al: DeletedIdentity = { ...who, logins: ["al"], email: "" };
    expect(redactPayload({ message: "al already said hi @al" }, al)).toEqual({
      message: "al already said hi [deleted]",
    });
  });
});
