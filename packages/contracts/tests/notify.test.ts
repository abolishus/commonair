// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** N1 contract step: push keys, the Discord URL rule, payloads, settings and the router namespace. */
import { describe, expect, test } from "vite-plus/test";
import { contract } from "../src/api/router.ts";
import { NOTIFICATION_TYPES, PREFERENCE_TYPES, UNSUBSCRIBE_LISTS } from "../src/enums.ts";
import { DiscordJob, GoLiveJob } from "../src/internal.ts";
import {
  DISCORD_WEBHOOK_URL,
  GoLiveNotificationPayload,
  NOTIFY_DEFAULTS,
  NOTIFY_RULES,
  PushPayload,
  PushSubscriptionKeys,
} from "../src/notify.ts";
import { GoLiveSetting } from "../src/shapes.ts";

const id = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function b64url(bytes: Uint8Array, pad: boolean): string {
  const s = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return pad ? s : s.replace(/=+$/, "");
}

async function browserKeys(pad: boolean) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { p256dh: b64url(raw, pad), auth: b64url(crypto.getRandomValues(new Uint8Array(16)), pad) };
}

describe("PushSubscriptionKeys", () => {
  test("accepts a browser-shaped pair, unpadded and padded", async () => {
    for (const pad of [false, true]) {
      const keys = await browserKeys(pad);
      expect(PushSubscriptionKeys.safeParse(keys).success).toBe(true);
    }
  });

  test("refuses wrong lengths and alphabets", async () => {
    const keys = await browserKeys(false);
    expect(PushSubscriptionKeys.safeParse({ ...keys, p256dh: keys.p256dh.slice(1) }).success).toBe(false);
    expect(PushSubscriptionKeys.safeParse({ ...keys, auth: `${keys.auth}A` }).success).toBe(false);
    expect(PushSubscriptionKeys.safeParse({ ...keys, auth: `${keys.auth.slice(1)}+` }).success).toBe(false);
    expect(PushSubscriptionKeys.safeParse({ ...keys, auth: `${keys.auth}=` }).success).toBe(false);
  });
});

describe("DISCORD_WEBHOOK_URL", () => {
  test("accepts both Discord hosts", () => {
    expect(DISCORD_WEBHOOK_URL.test("https://discord.com/api/webhooks/123456789012345678/abc_DEF-123")).toBe(true);
    expect(DISCORD_WEBHOOK_URL.test("https://discordapp.com/api/webhooks/1/x")).toBe(true);
  });

  test.each([
    "http://discord.com/api/webhooks/1/x",
    "https://example.com/api/webhooks/1/x",
    "https://discord.com.evil.example/api/webhooks/1/x",
    "https://evil.example/https://discord.com/api/webhooks/1/x",
    "https://discord.com/api/webhooks/1/x/extra",
    "https://discord.com/api/webhooks/1/x?wait=true",
    "https://discord.com/api/webhooks/abc/x",
    "https://discord.com/api/webhooks/1/",
  ])("refuses %s", (url) => {
    expect(DISCORD_WEBHOOK_URL.test(url)).toBe(false);
  });
});

describe("payloads", () => {
  test("PushPayload: zod strips unknown keys (the worker builds it, so strict() is not needed)", () => {
    const parsed = PushPayload.parse({ v: 1, type: "go_live", slug: "a", title: "t", extra: "x" });
    expect(parsed).toEqual({ v: 1, type: "go_live", slug: "a", title: "t" });
    expect(PushPayload.safeParse({ v: 2, type: "go_live", slug: "a", title: "t" }).success).toBe(false);
    expect(PushPayload.safeParse({ v: 1, type: "go_live", slug: "a", title: "x".repeat(141) }).success).toBe(false);
  });

  test("GoLiveNotificationPayload allows the empty mature title", () => {
    const p = { channelId: id(1), slug: "s", broadcastId: id(2), title: "" };
    expect(GoLiveNotificationPayload.parse(p)).toEqual(p);
  });

  test("defaults and rules", () => {
    expect(NOTIFY_DEFAULTS.go_live).toEqual({ in_app: true, email: false, push: false });
    expect(NOTIFY_RULES.readGoLiveRetentionDays).toBeLessThan(NOTIFY_RULES.retentionDays);
    for (const t of PREFERENCE_TYPES) expect(NOTIFICATION_TYPES).toContain(t);
    expect(UNSUBSCRIBE_LISTS).toContain("go_live");
  });

  test("jobs default their optional fields", () => {
    expect(GoLiveJob.parse({ eventId: id(1) })).toEqual({ eventId: id(1), after: null });
    expect(DiscordJob.parse({ channelId: id(1), eventId: null, broadcastId: null }).test).toBe(false);
  });
});

describe("GoLiveSetting", () => {
  test("bounds match migration 0040", () => {
    expect(GoLiveSetting.safeParse({ cooldownHours: 4, emailDigestMinutes: 5 }).success).toBe(true);
    expect(GoLiveSetting.safeParse({ cooldownHours: 1, emailDigestMinutes: 0 }).success).toBe(true);
    for (const v of [
      { cooldownHours: 0, emailDigestMinutes: 5 },
      { cooldownHours: 49, emailDigestMinutes: 5 },
      { cooldownHours: 4, emailDigestMinutes: 61 },
      { cooldownHours: 4, emailDigestMinutes: 1.5 },
      { cooldownHours: 4 },
    ]) {
      expect(GoLiveSetting.safeParse(v).success).toBe(false);
    }
  });
});

describe("router: notifications namespace", () => {
  test("has every procedure and adds nothing to me", () => {
    expect(Object.keys(contract.notifications).sort()).toEqual(
      ["discord", "preferences", "push", "unreadCount", "unsubscribe"].sort(),
    );
    expect(Object.keys(contract.notifications.discord).sort()).toEqual(["get", "remove", "set", "test"]);
    expect(Object.keys(contract.notifications.push).sort()).toEqual(["status", "subscribe", "unsubscribe"]);
    expect(Object.keys(contract.me)).not.toContain("preferences");
  });

  test("the Discord set input refuses a non-Discord URL", () => {
    const input = contract.notifications.discord.set["~orpc"].inputSchema;
    expect(input?.["~standard"].validate({ channel: "abc", url: "https://example.com/x" })).toMatchObject({
      issues: expect.any(Array),
    });
  });
});
