// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** EventSub subscription rules (E9-subs): the authority table, condition keys, DTOs, the catalog. */
import { describe, expect, test } from "vite-plus/test";
import { EVENTS, PUBLIC_EVENT_TYPES, type PublicEventType } from "@commonair/contracts/events";
import { EventSubscription } from "@commonair/contracts/dto";
import { actorOf } from "../src/developer/subscriptions/index.ts";
import {
  APP_WEBHOOK_LIMIT,
  CATALOG,
  PERSONAL_WEBHOOK_LIMIT,
  checkTypeAndCondition,
  isRefusal,
  planSubscription,
  toSubscriptionDto,
  unauthorizedRefusal,
  type Actor,
  type Plan,
  type Refusal,
  type Transport,
} from "../src/developer/subscriptions/rules.ts";

const ME = "01900000-0000-7000-8000-000000000001";
const STREAMER = "01900000-0000-7000-8000-000000000002";
const APP = "01900000-0000-7000-8000-0000000000aa";

const session: Actor = { kind: "session", userId: ME };
const appToken: Actor = { kind: "app_token", appId: APP };
const userToken: Actor = { kind: "user_token", userId: ME, appId: APP };
const personalToken: Actor = { kind: "user_token", userId: ME, appId: null };

const cond = (type: PublicEventType, who = STREAMER) =>
  Object.fromEntries(EVENTS[type].condition.map((k) => [k, who])) as Record<string, string>;

function plan(actor: Actor, type: PublicEventType, transport: Transport, appId?: string): Plan | Refusal {
  return planSubscription(actor, { type, condition: cond(type), transport, appId });
}
const ok = (p: Plan | Refusal): Plan => {
  if (isRefusal(p)) throw new Error(`refused: ${p.message}`);
  return p;
};
const refusal = (p: Plan | Refusal): Refusal => {
  if (!isRefusal(p)) throw new Error("expected a refusal");
  return p;
};

describe("authority table: scope-less types (channel.follow)", () => {
  test("a session backs a personal subscription itself", () => {
    expect(ok(plan(session, "channel.follow", "webhook"))).toMatchObject({
      appId: null,
      backing: { kind: "user", userId: ME },
      authorize: false,
      asApp: false,
    });
  });
  test("a session for its app is backed by the app's owner", () => {
    expect(ok(plan(session, "channel.follow", "webhook", APP))).toMatchObject({
      appId: APP,
      backing: { kind: "owner" },
      authorize: false,
      asApp: true,
    });
  });
  test("an app token is backed by the app's owner", () => {
    expect(ok(plan(appToken, "channel.follow", "webhook"))).toMatchObject({
      appId: APP,
      backing: { kind: "owner" },
      authorize: false,
    });
  });
  test("a user token backs it itself, for its app; a personal token for no app", () => {
    expect(ok(plan(userToken, "channel.follow", "webhook"))).toMatchObject({
      appId: APP,
      backing: { kind: "user", userId: ME },
    });
    expect(ok(plan(personalToken, "channel.follow", "websocket"))).toMatchObject({
      appId: null,
      backing: { kind: "user", userId: ME },
    });
  });
  test("raids name the receiving broadcaster and need no scope", () => {
    expect(ok(plan(appToken, "channel.raid", "webhook")).binding).toBe("none");
  });
});

describe("authority table: scoped types", () => {
  test("a user token backs it itself and must pass authorization", () => {
    expect(ok(plan(userToken, "channel.subscribe", "webhook"))).toMatchObject({
      appId: APP,
      backing: { kind: "user", userId: ME },
      authorize: true,
      binding: "broadcaster",
    });
  });
  test("an app token is backed by the broadcaster the condition names", () => {
    expect(ok(plan(appToken, "channel.subscribe", "webhook"))).toMatchObject({
      backing: { kind: "user", userId: STREAMER },
      authorize: true,
      asApp: true,
    });
    // Moderator events: the condition has only the broadcaster, so the broadcaster backs it.
    expect(ok(plan(appToken, "channel.ban", "webhook"))).toMatchObject({
      backing: { kind: "user", userId: STREAMER },
      binding: "broadcaster_or_moderator",
    });
  });
  test("a session for its app is backed by the broadcaster", () => {
    expect(ok(plan(session, "channel.tip", "webhook", APP))).toMatchObject({
      appId: APP,
      backing: { kind: "user", userId: STREAMER },
      authorize: true,
    });
  });
  test("a session without an app cannot: token_required", () => {
    expect(refusal(plan(session, "channel.subscribe", "webhook"))).toMatchObject({
      code: "PRECONDITION_FAILED",
      requirement: "token_required",
    });
  });
});

describe("authority table: transports and appId", () => {
  test("webhook is refused for WebSocket-only types, whoever asks", () => {
    for (const actor of [session, appToken, userToken, personalToken])
      expect(refusal(plan(actor, "channel.chat.message", "webhook"))).toMatchObject({
        code: "PRECONDITION_FAILED",
        requirement: "websocket_only",
      });
  });
  test("WebSocket needs a user token", () => {
    expect(refusal(plan(session, "channel.follow", "websocket")).code).toBe("FORBIDDEN");
    expect(refusal(plan(session, "channel.follow", "websocket", APP)).code).toBe("FORBIDDEN");
    expect(refusal(plan(appToken, "channel.follow", "websocket")).code).toBe("FORBIDDEN");
    expect(ok(plan(userToken, "channel.chat.message", "websocket")).authorize).toBe(true);
  });
  test("appId from a token caller is FORBIDDEN", () => {
    expect(refusal(plan(appToken, "channel.follow", "webhook", APP)).code).toBe("FORBIDDEN");
    expect(refusal(plan(userToken, "channel.follow", "webhook", APP)).code).toBe("FORBIDDEN");
    expect(refusal(plan(personalToken, "channel.follow", "webhook", APP)).code).toBe("FORBIDDEN");
  });
  test("every public type × actor × transport yields a plan or a typed refusal", () => {
    const odd: string[] = [];
    for (const type of PUBLIC_EVENT_TYPES)
      for (const actor of [session, appToken, userToken, personalToken])
        for (const transport of ["webhook", "websocket"] as const) {
          const p = plan(actor, type, transport);
          const fine = isRefusal(p)
            ? p.code === "FORBIDDEN" || p.code === "PRECONDITION_FAILED"
            : p.authorize === EVENTS[type].scopes.length > 0;
          if (!fine) odd.push(`${type} ${actor.kind} ${transport}`);
        }
    expect(odd).toEqual([]);
  });
});

describe("refusal messages", () => {
  test("an app refusal names the broadcaster and the scopes", () => {
    expect(unauthorizedRefusal("channel.subscribe", true).message).toBe(
      "The broadcaster has not authorized this app for channel:read:subscriptions",
    );
    expect(unauthorizedRefusal("channel.ban", false).message).toContain("or moderator");
    expect(unauthorizedRefusal("channel.subscribe", false).message).not.toContain("or moderator");
  });
});

describe("condition keys", () => {
  test("exactly the catalog's keys pass", () => {
    expect(checkTypeAndCondition("channel.follow", "1", { broadcaster_user_id: STREAMER })).toBeNull();
  });
  test("unknown, missing and empty keys are condition_keys", () => {
    expect(
      checkTypeAndCondition("channel.follow", "1", { broadcaster_user_id: STREAMER, moderator_user_id: ME }),
    ).toMatchObject({ requirement: "condition_keys", message: expect.stringContaining("moderator_user_id") });
    expect(checkTypeAndCondition("channel.chat.message", "1", { broadcaster_user_id: STREAMER })).toMatchObject({
      requirement: "condition_keys",
      message: expect.stringContaining("user_id"),
    });
    expect(checkTypeAndCondition("channel.follow", "1", { broadcaster_user_id: "" })).toMatchObject({
      requirement: "condition_keys",
    });
    expect(checkTypeAndCondition("channel.follow", "1", {})).toMatchObject({ requirement: "condition_keys" });
  });
  test("only version 1 exists", () => {
    expect(checkTypeAndCondition("channel.follow", "2", { broadcaster_user_id: STREAMER })).toMatchObject({
      requirement: "version",
    });
  });
});

describe("DTO", () => {
  const base = {
    id: "01900000-0000-7000-8000-0000000000f1",
    appId: APP,
    userId: ME,
    type: "channel.follow",
    version: "1",
    condition: { broadcaster_user_id: STREAMER },
    status: "enabled" as const,
    failureCount: 2,
    createdAt: new Date("2026-10-29T12:00:00.000Z"),
  };
  test("webhook rows carry the callback and never the secret", () => {
    const dto = toSubscriptionDto({
      ...base,
      transport: "webhook",
      callbackUrl: "https://hooks.example.test/cb",
      websocketSessionId: null,
      secretCiphertext: "v1:secret",
    } as Parameters<typeof toSubscriptionDto>[0]);
    expect(dto.transport).toEqual({ method: "webhook", callback: "https://hooks.example.test/cb" });
    expect(JSON.stringify(dto)).not.toContain("secret");
    expect(EventSubscription.parse(dto)).toEqual({ ...dto, createdAt: "2026-10-29T12:00:00.000Z" });
  });
  test("WebSocket rows carry the session id", () => {
    const dto = toSubscriptionDto({
      ...base,
      appId: null,
      transport: "websocket",
      callbackUrl: null,
      websocketSessionId: "s-1",
    });
    expect(dto).toMatchObject({ appId: null, transport: { method: "websocket", sessionId: "s-1" }, failureCount: 2 });
    expect(EventSubscription.safeParse(dto).success).toBe(true);
  });
});

describe("catalog and limits", () => {
  test("every public type with its transports; chat is WebSocket only", () => {
    expect(CATALOG.map((c) => c.type)).toEqual([...PUBLIC_EVENT_TYPES]);
    expect(CATALOG.find((c) => c.type === "channel.chat.message")?.transports).toEqual(["websocket"]);
    expect(CATALOG.find((c) => c.type === "channel.follow")?.transports).toEqual(["webhook", "websocket"]);
    expect(CATALOG.some((c) => (c.type as string).startsWith("moderation."))).toBe(false);
  });
  test("limits", () => {
    expect(PERSONAL_WEBHOOK_LIMIT).toBe(1000);
    expect(APP_WEBHOOK_LIMIT).toBe(10_000);
  });
});

describe("actorOf", () => {
  const user = { id: ME, username: "me", role: "user" as const, accountType: "human" as const, suspended: false };
  test("maps the middleware's resolution", () => {
    expect(actorOf({ kind: "user", caller: { kind: "session", user, sessionId: "s" } })).toEqual(session);
    expect(
      actorOf({
        kind: "user",
        caller: { kind: "token", user, tokenId: "t", appId: null, scopes: [], expiresAt: new Date() },
      }),
    ).toEqual(personalToken);
    expect(actorOf({ kind: "app", app: { appId: APP, tokenId: "t", expiresAt: new Date() } })).toEqual(appToken);
  });
});
