// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  ENVELOPE_STATUS,
  WEBSOCKET_ONLY_EVENT_TYPES,
  backingUserOf,
  bindingFor,
  broadcasterOf,
  conditionComplete,
  matchesCondition,
  subscriptionEnvelope,
  transportsFor,
} from "../src/eventsub.ts";
import { EVENTS, EVENT_TYPES, UserControlMessage, userControlTargets } from "../src/events.ts";

const USER = "0193e6a0-0000-7000-8000-000000000001";

describe("matchesCondition", () => {
  const payload = { broadcaster_user_id: "b1", user_id: "u1", viewers: 12, is_gift: false };
  test("every key must equal the payload field", () => {
    expect(matchesCondition({ broadcaster_user_id: "b1" }, payload, USER)).toBe(true);
    expect(matchesCondition({ broadcaster_user_id: "b2" }, payload, USER)).toBe(false);
    expect(matchesCondition({ broadcaster_user_id: "b1", user_id: "u1" }, payload, USER)).toBe(true);
    expect(matchesCondition({ broadcaster_user_id: "b1", user_id: "u2" }, payload, USER)).toBe(false);
  });
  test("empty condition matches everything", () => {
    expect(matchesCondition({}, payload, USER)).toBe(true);
    expect(matchesCondition({}, {}, USER)).toBe(true);
  });
  test("non-string scalars compare by their string form; objects never match", () => {
    expect(matchesCondition({ viewers: "12" }, payload, USER)).toBe(true);
    expect(matchesCondition({ viewers: "12.0" }, payload, USER)).toBe(false);
    expect(matchesCondition({ is_gift: "false" }, payload, USER)).toBe(true);
    expect(matchesCondition({ amount: "[object Object]" }, { amount: {} }, USER)).toBe(false);
  });
  test("a key missing from the payload fails, except user_id which names the subscriber", () => {
    expect(matchesCondition({ to_broadcaster_user_id: "b1" }, payload, USER)).toBe(false);
    const chat = { broadcaster_user_id: "b1", chatter_user_id: "c1" };
    expect(matchesCondition({ broadcaster_user_id: "b1", user_id: USER }, chat, USER)).toBe(true);
    expect(matchesCondition({ broadcaster_user_id: "b1", user_id: "someone-else" }, chat, USER)).toBe(false);
  });
  test("prototype keys are not payload fields", () => {
    expect(matchesCondition({ toString: "x" }, {}, USER)).toBe(false);
  });
});

describe("authorization rules", () => {
  test("binding by scope family", () => {
    expect(bindingFor([])).toBe("none");
    expect(bindingFor(["chat:read"])).toBe("self");
    expect(bindingFor(["moderator:manage:chat"])).toBe("broadcaster_or_moderator");
    expect(bindingFor(["channel:read:subscriptions"])).toBe("broadcaster");
    expect(bindingFor(["channel:read:tips"])).toBe("broadcaster");
    expect(bindingFor(["chat:read", "channel:read:points"])).toBe("broadcaster");
  });
  test("every catalog event with scopes names the field its binding needs", () => {
    const missing = EVENT_TYPES.filter((type) => {
      const b = bindingFor(EVENTS[type].scopes);
      if (b === "none") return false;
      const needed = b === "self" ? "user_id" : "broadcaster_user_id";
      return !EVENTS[type].condition.includes(needed);
    });
    expect(missing).toEqual([]);
  });
  test("conditions must name every catalog field, non-empty", () => {
    expect(conditionComplete("channel.follow", { broadcaster_user_id: "b" })).toBe(true);
    expect(conditionComplete("channel.follow", {})).toBe(false);
    expect(conditionComplete("channel.follow", { broadcaster_user_id: "" })).toBe(false);
    expect(conditionComplete("channel.chat.message", { broadcaster_user_id: "b" })).toBe(false);
    expect(conditionComplete("channel.chat.message", { broadcaster_user_id: "b", user_id: "u" })).toBe(true);
    expect(conditionComplete("coop.proposal.update", {})).toBe(true);
  });
  test("broadcaster field, including raids", () => {
    expect(broadcasterOf({ broadcaster_user_id: "a" })).toBe("a");
    expect(broadcasterOf({ to_broadcaster_user_id: "b" })).toBe("b");
    expect(broadcasterOf({ user_id: "c" })).toBeUndefined();
  });
});

describe("backingUserOf", () => {
  test("scope-less events need no backing user", () => {
    expect(backingUserOf("channel.follow", { broadcaster_user_id: "b" })).toBeUndefined();
    expect(backingUserOf("channel.raid", { to_broadcaster_user_id: "b" })).toBeUndefined();
  });
  test("chat:read is backed by the reading user", () => {
    expect(backingUserOf("channel.chat.message", { broadcaster_user_id: "b", user_id: "u" })).toBe("u");
  });
  test("moderator events: the moderator when named, else the broadcaster", () => {
    expect(backingUserOf("channel.ban", { broadcaster_user_id: "b" })).toBe("b");
    expect(backingUserOf("channel.ban", { broadcaster_user_id: "b", moderator_user_id: "m" })).toBe("m");
  });
  test("broadcaster events: the broadcaster", () => {
    expect(backingUserOf("channel.subscribe", { broadcaster_user_id: "b" })).toBe("b");
    expect(backingUserOf("channel.points.change", {})).toBeUndefined();
  });
});

describe("transports", () => {
  test("chat messages are WebSocket only", () => {
    expect(WEBSOCKET_ONLY_EVENT_TYPES).toContain("channel.chat.message");
    expect(transportsFor("channel.chat.message")).toEqual(["websocket"]);
    expect(transportsFor("channel.follow")).toEqual(["webhook", "websocket"]);
  });
});

describe("subscriptionEnvelope", () => {
  const base = {
    id: "0193e6a0-0000-7000-8000-0000000000aa",
    type: "channel.follow",
    version: "1",
    status: "enabled" as const,
    condition: { broadcaster_user_id: "b1" },
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
  };
  test("webhook", () => {
    expect(
      subscriptionEnvelope({
        ...base,
        transport: "webhook",
        callbackUrl: "https://hooks.example.com/cb",
        websocketSessionId: null,
      }),
    ).toEqual({
      id: base.id,
      type: "channel.follow",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "b1" },
      transport: { method: "webhook", callback: "https://hooks.example.com/cb" },
      created_at: "2026-01-02T03:04:05.000Z",
    });
  });
  test("websocket", () => {
    const e = subscriptionEnvelope(
      { ...base, status: "revoked", transport: "websocket", callbackUrl: null, websocketSessionId: "sess-1" },
      undefined,
    );
    expect(e.transport).toEqual({ method: "websocket", session_id: "sess-1" });
    expect(e.status).toBe(ENVELOPE_STATUS.revoked);
  });
  test("an explicit status wins", () => {
    const e = subscriptionEnvelope(
      { ...base, transport: "webhook", callbackUrl: "https://h.example/cb", websocketSessionId: null },
      "custom",
    );
    expect(e.status).toBe("custom");
  });
});

describe("user control", () => {
  const A = "0193e6a0-0000-7000-8000-0000000000a1";
  const U = "0193e6a0-0000-7000-8000-0000000000b1";
  test("userId or appId is required", () => {
    expect(UserControlMessage.safeParse({ op: "disconnect", reason: "app_removed" }).success).toBe(false);
    expect(UserControlMessage.safeParse({ op: "disconnect", appId: A, reason: "app_removed" }).success).toBe(true);
    expect(UserControlMessage.safeParse({ op: "disconnect", userId: U, reason: "token_rotated" }).success).toBe(true);
  });
  test("targets narrow by every field present", () => {
    const conn = { userId: U, appId: A, tokenHash: "h1" };
    expect(userControlTargets(conn, { appId: A })).toBe(true);
    expect(userControlTargets(conn, { userId: U })).toBe(true);
    expect(userControlTargets(conn, { userId: U, appId: A, tokenHash: "h1" })).toBe(true);
    expect(userControlTargets(conn, { userId: U, tokenHash: "h2" })).toBe(false);
    expect(userControlTargets({ ...conn, appId: null }, { appId: A })).toBe(false);
    expect(userControlTargets({ userId: null, appId: A, tokenHash: null }, { userId: U })).toBe(false);
  });
});
