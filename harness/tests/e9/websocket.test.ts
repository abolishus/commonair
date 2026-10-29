// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of `developer-platform` step 5 (E9-ws). */
import { describe, expect, test } from "vite-plus/test";
import { conditionComplete } from "@commonair/contracts/eventsub";
import type { WsMessage } from "@commonair/contracts/events";
import { count, eventSubUrl, findMessage, step, streamerSubscriptions } from "../../src/e9/websocket.ts";

const STREAMER = "0196a3b2-0000-7000-8000-0000000000aa";

const msg = (
  type: WsMessage["metadata"]["message_type"],
  subscriptionType?: WsMessage["metadata"]["subscription_type"],
  event?: Record<string, unknown>,
): WsMessage => ({
  metadata: {
    message_id: crypto.randomUUID(),
    message_type: type,
    message_timestamp: new Date().toISOString(),
    ...(subscriptionType ? { subscription_type: subscriptionType, subscription_version: "1" } : {}),
  },
  payload: event ? { event } : {},
});

describe("eventSubUrl", () => {
  test("http → ws, https → wss, the EventSub path, query", () => {
    expect(eventSubUrl("http://localhost:3001")).toBe("ws://localhost:3001/eventsub/ws");
    expect(eventSubUrl("https://api.example.test/")).toBe("wss://api.example.test/eventsub/ws");
    expect(eventSubUrl("http://localhost:3001", { keepalive_timeout_seconds: "30" })).toBe(
      "ws://localhost:3001/eventsub/ws?keepalive_timeout_seconds=30",
    );
  });
});

describe("streamerSubscriptions", () => {
  test("chat, follow, poll begin, points change; every condition complete", () => {
    const subs = streamerSubscriptions(STREAMER);
    expect(subs.map((s) => s.type)).toEqual([
      "channel.chat.message",
      "channel.follow",
      "channel.poll.begin",
      "channel.points.change",
    ]);
    for (const s of subs) {
      expect(conditionComplete(s.type, s.condition), s.type).toBe(true);
      expect(s.condition.broadcaster_user_id).toBe(STREAMER);
    }
    expect(subs[0]?.condition.user_id).toBe(STREAMER);
  });
});

describe("findMessage and count", () => {
  test("by type, subscription type, event predicate, skipping seen", () => {
    const a = msg("notification", "channel.follow", { user_id: "v1" });
    const b = msg("notification", "channel.follow", { user_id: "v2" });
    const c = msg("notification", "channel.chat.message", { chatter_user_id: "v1" });
    const all = [msg("session_welcome"), a, b, c, msg("session_keepalive")];
    expect(findMessage(all, "notification")).toBe(a);
    expect(findMessage(all, "notification", { subscriptionType: "channel.chat.message" })).toBe(c);
    expect(findMessage(all, "notification", { pred: (e) => e.user_id === "v2" })).toBe(b);
    expect(findMessage(all, "notification", { subscriptionType: "channel.follow", seen: new Set([a]) })).toBe(b);
    expect(findMessage(all, "revocation")).toBeUndefined();
    expect(count(all, "notification")).toBe(3);
    expect(count(all, "notification", "channel.follow")).toBe(2);
    expect(count(all, "session_keepalive")).toBe(1);
  });
});

describe("step", () => {
  test("ready, owned by E9-ws, needs the grant of step 2", () => {
    expect(step).toMatchObject({ name: "websocket", owner: "E9-ws", ready: true, needs: [2] });
    expect(step.webOnly).toBeUndefined();
  });
});
