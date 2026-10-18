// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EVENT_TYPES, EVENTS, verifyWebhook, WEBHOOK_HEADERS } from "@commonair/contracts/events";
import { describe, expect, test } from "vite-plus/test";
import { bindingFor, broadcasterOf, conditionComplete } from "../src/webhooks/authorization.ts";
import { DEFAULT_BACKOFF_MS, JITTER, nextRetryDelay } from "../src/webhooks/backoff.ts";
import { matchesCondition } from "../src/webhooks/conditions.ts";
import {
  envelope,
  notificationMessageId,
  signedHeaders,
  truncateUtf8,
  type SubscriptionRow,
} from "../src/webhooks/messages.ts";
import { samplePayload } from "../src/webhooks/sample.ts";

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

describe("nextRetryDelay", () => {
  const noJitter = () => 0.5;
  test("follows the schedule and stops after max attempts", () => {
    expect([1, 2, 3, 4].map((a) => nextRetryDelay(a, 5, DEFAULT_BACKOFF_MS, noJitter))).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000,
    ]);
    expect(nextRetryDelay(5, 5, DEFAULT_BACKOFF_MS, noJitter)).toBeNull();
    expect(nextRetryDelay(9, 5, DEFAULT_BACKOFF_MS, noJitter)).toBeNull();
  });
  test("jitter stays within ±10%", () => {
    expect(nextRetryDelay(1, 5, DEFAULT_BACKOFF_MS, () => 0)).toBe(60_000 * (1 - JITTER));
    expect(nextRetryDelay(1, 5, DEFAULT_BACKOFF_MS, () => 0.999999)).toBeCloseTo(60_000 * (1 + JITTER), -1);
    for (let i = 0; i < 200; i++) {
      const d = nextRetryDelay(2, 5) ?? 0;
      expect(d).toBeGreaterThanOrEqual(270_000);
      expect(d).toBeLessThanOrEqual(330_000);
    }
  });
  test("repeats the last delay past the end of the schedule", () => {
    expect(nextRetryDelay(7, 10, [10, 20], noJitter)).toBe(20);
  });
  test("degenerate inputs give no retry", () => {
    expect(nextRetryDelay(0, 5)).toBeNull();
    expect(nextRetryDelay(1.5, 5)).toBeNull();
    expect(nextRetryDelay(1, 1)).toBeNull();
    expect(nextRetryDelay(1, 5, [])).toBeNull();
  });
});

const sub: SubscriptionRow = {
  id: "0193e6a0-0000-7000-8000-0000000000aa",
  appId: null,
  userId: USER,
  type: "channel.follow",
  version: "1",
  condition: { broadcaster_user_id: "b1" },
  transport: "webhook",
  callbackUrl: "https://hooks.example.com/cb",
  secretCiphertext: "v1.x",
  websocketSessionId: null,
  status: "enabled",
  failureCount: 0,
  createdAt: new Date("2026-01-02T03:04:05Z"),
};

describe("messages", () => {
  test("signature headers verify with verifyWebhook and carry the Twitch header set", async () => {
    const body = JSON.stringify({ subscription: envelope(sub), event: { a: 1 } });
    const timestamp = new Date().toISOString();
    const h = await signedHeaders({
      secret: "s3cret-s3cret",
      messageId: "m-1",
      messageType: "notification",
      timestamp,
      body,
      subscription: sub,
      retry: 2,
    });
    expect(h[WEBHOOK_HEADERS.messageId]).toBe("m-1");
    expect(h[WEBHOOK_HEADERS.messageRetry]).toBe("2");
    expect(h[WEBHOOK_HEADERS.messageType]).toBe("notification");
    expect(h[WEBHOOK_HEADERS.subscriptionType]).toBe("channel.follow");
    expect(h[WEBHOOK_HEADERS.subscriptionVersion]).toBe("1");
    const sig = h[WEBHOOK_HEADERS.messageSignature] ?? "";
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyWebhook("s3cret-s3cret", "m-1", timestamp, body, sig)).toBe(true);
    expect(await verifyWebhook("wrong-secret", "m-1", timestamp, body, sig)).toBe(false);
    expect(await verifyWebhook("s3cret-s3cret", "m-1", timestamp, `${body} `, sig)).toBe(false);
  });

  test("envelope is Twitch-shaped", () => {
    expect(envelope(sub)).toEqual({
      id: sub.id,
      type: "channel.follow",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "b1" },
      transport: { method: "webhook", callback: "https://hooks.example.com/cb" },
      created_at: "2026-01-02T03:04:05.000Z",
    });
    expect(envelope({ ...sub, status: "revoked" }).status).toBe("authorization_revoked");
    expect(envelope(sub, "custom").status).toBe("custom");
  });

  test("message ids are stable per subscription+event and distinct otherwise", () => {
    const a = notificationMessageId("s1", "e1");
    expect(a).toBe(notificationMessageId("s1", "e1"));
    expect(a).not.toBe(notificationMessageId("s2", "e1"));
    expect(a).not.toBe(notificationMessageId("s1", "e2"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("truncateUtf8 caps bytes without splitting characters", () => {
    expect(truncateUtf8("hello", 10)).toBe("hello");
    expect(truncateUtf8("hello", 3)).toBe("hel");
    expect(truncateUtf8("ééé", 3)).toBe("é");
    expect(truncateUtf8("a😀b", 4)).toBe("a");
    expect(Buffer.byteLength(truncateUtf8("x".repeat(5000), 2048))).toBe(2048);
  });
});

describe("samplePayload", () => {
  test.each(EVENT_TYPES)("%s sample validates against the catalog", (type) => {
    const condition = Object.fromEntries(EVENTS[type].condition.map((k) => [k, `cond-${k}`]));
    const p = samplePayload(type, condition);
    expect(EVENTS[type].payload.safeParse(p).success).toBe(true);
    const copied = Object.entries(condition).filter(([k]) => k in p);
    expect(copied.every(([k, v]) => p[k] === v)).toBe(true);
  });
  test("a sample matches the subscription's own condition", () => {
    const p = samplePayload("channel.chat.message", { broadcaster_user_id: "b9", user_id: USER });
    expect(matchesCondition({ broadcaster_user_id: "b9", user_id: USER }, p, USER)).toBe(true);
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
