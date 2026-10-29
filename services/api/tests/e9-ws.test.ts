// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EventSub WebSocket pure parts (E9-ws, ADR 0027 §3): keepalive parsing and bounds, close codes,
 * the messages validate as `WsMessage`, the in-memory subscription index, the backpressure policy,
 * how control messages apply to a session, and the reconnect URL.
 */
import { describe, expect, test } from "vite-plus/test";
import { EVENTSUB_WS_CLOSE, EVENTSUB_WS_KEEPALIVE, subscriptionEnvelope } from "@commonair/contracts/eventsub";
import { UserControlMessage, WsMessage } from "@commonair/contracts/events";
import {
  afterSend,
  beforeSend,
  CLOSE_REASONS,
  closeReason,
  controlAction,
  keepaliveMessage,
  notificationMessage,
  parseKeepalive,
  reconnectMessage,
  reconnectUrl,
  REVOKED_STATUS,
  revocationMessage,
  welcomeMessage,
  type SessionBinding,
} from "../src/eventsub/protocol.ts";
import { grantMember, parseSessionHash } from "../src/eventsub/sessions.ts";
import { SubscriptionIndex, type WsSubscription } from "../src/eventsub/subscriptions.ts";
import { WS_IDLE_TIMEOUT_SECONDS } from "../src/eventsub/hub.ts";

const SESSION = "0196a3b2-0000-7000-8000-000000000001";
const USER = "0196a3b2-0000-7000-8000-0000000000aa";
const APP = "0196a3b2-0000-7000-8000-0000000000bb";

describe("parseKeepalive", () => {
  test("absent → the default 10", () => {
    expect(parseKeepalive(null)).toBe(10);
  });
  test("integers within 10-600 pass", () => {
    expect(parseKeepalive("10")).toBe(10);
    expect(parseKeepalive("30")).toBe(30);
    expect(parseKeepalive("600")).toBe(600);
  });
  test("outside the bounds or not an integer → null", () => {
    for (const v of ["9", "0", "601", "1000", "", "abc", "10.5", "-10", " 10", "1e2", "00010000"])
      expect(parseKeepalive(v), v).toBeNull();
  });
  test("tests may lower the floor", () => {
    expect(parseKeepalive("1", { ...EVENTSUB_WS_KEEPALIVE, minSeconds: 1 })).toBe(1);
    expect(parseKeepalive("0", { ...EVENTSUB_WS_KEEPALIVE, minSeconds: 1 })).toBeNull();
  });
  test("Bun's idle timeout stays above the keepalive maximum", () => {
    expect(WS_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(EVENTSUB_WS_KEEPALIVE.maxSeconds);
  });
});

describe("close codes", () => {
  test("every EventSub code has a reason", () => {
    for (const code of Object.values(EVENTSUB_WS_CLOSE)) expect(closeReason(code)).toBeTruthy();
    const byNumber = (x: number, y: number) => x - y;
    expect(Object.keys(CLOSE_REASONS).map(Number).sort(byNumber)).toEqual(
      Object.values(EVENTSUB_WS_CLOSE).sort(byNumber),
    );
  });
  test("Twitch's reasons and ours", () => {
    expect(closeReason(4001)).toBe("client sent inbound traffic");
    expect(closeReason(4003)).toBe("connection unused");
    expect(closeReason(4004)).toBe("reconnect grace time expired");
    expect(closeReason(4007)).toBe("invalid reconnect");
    expect(closeReason(4008)).toBe("authorization revoked");
  });
  test("reasons fit a close frame (123 bytes)", () => {
    for (const r of Object.values(CLOSE_REASONS)) expect(new TextEncoder().encode(r).length).toBeLessThanOrEqual(123);
  });
});

const sub = (over: Partial<WsSubscription> = {}): WsSubscription => ({
  id: crypto.randomUUID(),
  sessionId: SESSION,
  type: "channel.follow",
  version: "1",
  condition: { broadcaster_user_id: USER },
  userId: USER,
  appId: APP,
  createdAt: new Date("2026-10-29T12:00:00Z"),
  ...over,
});

const env = (s: WsSubscription, status?: string) =>
  subscriptionEnvelope(
    {
      ...s,
      status: "enabled",
      transport: "websocket",
      callbackUrl: null,
      websocketSessionId: s.sessionId,
    },
    status,
  );

describe("messages", () => {
  const now = new Date("2026-10-29T12:00:01Z");
  test("welcome", () => {
    const m = welcomeMessage({
      messageId: crypto.randomUUID(),
      now,
      sessionId: SESSION,
      keepaliveSeconds: 10,
      connectedAt: now,
    });
    const parsed = WsMessage.parse(m);
    expect(parsed.metadata.message_type).toBe("session_welcome");
    expect(parsed.payload.session).toEqual({
      id: SESSION,
      status: "connected",
      keepalive_timeout_seconds: 10,
      reconnect_url: null,
      connected_at: now.toISOString(),
    });
  });
  test("keepalive has an empty payload", () => {
    const parsed = WsMessage.parse(keepaliveMessage(crypto.randomUUID(), now));
    expect(parsed.metadata.message_type).toBe("session_keepalive");
    expect(parsed.payload).toEqual({});
  });
  test("reconnect carries the URL and no keepalive", () => {
    const parsed = WsMessage.parse(
      reconnectMessage({
        messageId: crypto.randomUUID(),
        now,
        sessionId: SESSION,
        connectedAt: now,
        reconnectUrl: "wss://x.test/eventsub/ws?resume=ces_ab",
      }),
    );
    expect(parsed.payload.session?.status).toBe("reconnecting");
    expect(parsed.payload.session?.keepalive_timeout_seconds).toBeNull();
    expect(parsed.payload.session?.reconnect_url).toBe("wss://x.test/eventsub/ws?resume=ces_ab");
  });
  test("notification: subscription type/version in the metadata, the envelope and the event", () => {
    const s = sub({ type: "channel.chat.message", condition: { broadcaster_user_id: USER, user_id: USER } });
    const parsed = WsMessage.parse(
      notificationMessage({ messageId: crypto.randomUUID(), now, subscription: env(s), event: { a: 1 } }),
    );
    expect(parsed.metadata.subscription_type).toBe("channel.chat.message");
    expect(parsed.metadata.subscription_version).toBe("1");
    expect(parsed.payload.subscription?.transport).toEqual({ method: "websocket", session_id: SESSION });
    expect(parsed.payload.subscription?.status).toBe("enabled");
    expect(parsed.payload.event).toEqual({ a: 1 });
  });
  test("revocation: status authorization_revoked, no event", () => {
    const parsed = WsMessage.parse(
      revocationMessage({ messageId: crypto.randomUUID(), now, subscription: env(sub(), REVOKED_STATUS) }),
    );
    expect(parsed.metadata.message_type).toBe("revocation");
    expect(parsed.payload.subscription?.status).toBe("authorization_revoked");
    expect(parsed.payload.event).toBeUndefined();
  });
});

describe("SubscriptionIndex", () => {
  test("add, candidates by type and version, remove", () => {
    const idx = new SubscriptionIndex();
    const a = sub();
    const b = sub({ type: "channel.chat.message" });
    const c = sub({ sessionId: "other", version: "2" });
    idx.set(SESSION, [a, b]);
    idx.set("other", [c]);
    expect(idx.size).toBe(3);
    expect(idx.candidates("channel.follow", "1").map((s) => s.id)).toEqual([a.id]);
    expect(idx.candidates("channel.follow", "2").map((s) => s.id)).toEqual([c.id]);
    expect(idx.candidates("stream.online", "1")).toEqual([]);
    expect(idx.has(b.id)).toBe(true);
    expect(
      idx
        .remove(SESSION)
        .map((s) => s.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(idx.candidates("channel.follow", "1")).toEqual([]);
    expect(idx.has(b.id)).toBe(false);
    expect(idx.size).toBe(1);
  });
  test("set replaces a session's subscriptions and ignores rows of other sessions", () => {
    const idx = new SubscriptionIndex();
    const a = sub();
    idx.set(SESSION, [a]);
    const a2 = sub();
    idx.set(SESSION, [a2, sub({ sessionId: "stray" })]);
    expect(idx.of(SESSION).map((s) => s.id)).toEqual([a2.id]);
    expect(idx.of("stray")).toEqual([]);
    expect(idx.candidates("channel.follow", "1")).toHaveLength(1);
  });
  test("removeSubscription drops one row, and an emptied session", () => {
    const idx = new SubscriptionIndex();
    const a = sub();
    idx.set(SESSION, [a]);
    idx.removeSubscription(a.id);
    expect(idx.of(SESSION)).toEqual([]);
    expect(idx.size).toBe(0);
    idx.removeSubscription("unknown");
  });
  test("reload keeps only the given sessions", () => {
    const idx = new SubscriptionIndex();
    idx.set("gone", [sub({ sessionId: "gone" })]);
    const a = sub();
    idx.reload([SESSION], [a, sub({ sessionId: "gone" }), sub({ sessionId: "unheld" })]);
    expect(idx.of("gone")).toEqual([]);
    expect(idx.of("unheld")).toEqual([]);
    expect(idx.of(SESSION).map((s) => s.id)).toEqual([a.id]);
    idx.reload([], []);
    expect(idx.size).toBe(0);
  });
});

describe("backpressure", () => {
  test("a socket over the cap is closed before the next send", () => {
    expect(beforeSend(0, 1024)).toBe("send");
    expect(beforeSend(1024, 1024)).toBe("send");
    expect(beforeSend(1025, 1024)).toBe("close");
  });
  test("Bun's send status", () => {
    expect(afterSend(120)).toBe("sent");
    expect(afterSend(-1)).toBe("queued");
    expect(afterSend(0)).toBe("dropped");
  });
});

describe("controlAction", () => {
  const binding: SessionBinding = { appId: APP, userId: USER, tokenHash: "h1" };
  const msg = (m: Partial<UserControlMessage>) =>
    UserControlMessage.parse({ op: "disconnect", reason: "token_revoked", userId: USER, ...m });
  test("unbound sessions are never targeted", () => {
    expect(controlAction(null, msg({}))).toBe("none");
  });
  test("by token hash", () => {
    expect(controlAction(binding, msg({ appId: APP, tokenHash: "h1" }))).toBe("close");
    expect(controlAction(binding, msg({ appId: APP, tokenHash: "h2" }))).toBe("none");
  });
  test("by grant, by app, by user", () => {
    expect(controlAction(binding, msg({ appId: APP, reason: "grant_revoked" }))).toBe("close");
    expect(controlAction(binding, msg({ userId: undefined, appId: APP, reason: "app_suspended" }))).toBe("close");
    expect(controlAction(binding, msg({ userId: undefined, appId: USER, reason: "app_suspended" }))).toBe("none");
    expect(controlAction(binding, msg({ reason: "suspended" }))).toBe("close");
    expect(controlAction(binding, msg({ userId: APP, reason: "suspended" }))).toBe("none");
  });
  test("personal sessions match user-wide messages, not app ones", () => {
    const personal: SessionBinding = { appId: null, userId: USER, tokenHash: "h1" };
    expect(controlAction(personal, msg({ reason: "deleted" }))).toBe("close");
    expect(controlAction(personal, msg({ appId: APP }))).toBe("none");
  });
  test("token_rotated and invalidate only drop caches", () => {
    expect(controlAction(binding, msg({ appId: APP, tokenHash: "h1", reason: "token_rotated" }))).toBe("invalidate");
    expect(controlAction(binding, msg({ op: "invalidate", reason: "role_changed" }))).toBe("invalidate");
  });
});

describe("reconnectUrl", () => {
  test("https → wss, http → ws, path and token", () => {
    expect(reconnectUrl("https://commonair.test", "ces_abc")).toBe("wss://commonair.test/eventsub/ws?resume=ces_abc");
    expect(reconnectUrl("https://commonair.test/some/path/", "ces_abc")).toBe(
      "wss://commonair.test/eventsub/ws?resume=ces_abc",
    );
    expect(reconnectUrl("http://127.0.0.1:3001", "ces_abc")).toBe("ws://127.0.0.1:3001/eventsub/ws?resume=ces_abc");
  });
});

describe("session hash", () => {
  test("unbound and bound sessions", () => {
    expect(parseSessionHash({})).toBeNull();
    expect(
      parseSessionHash({ instance: "i", keepalive: "10", connectedAt: "2026-10-29T12:00:00.000Z" })?.binding,
    ).toBeNull();
    expect(
      parseSessionHash({
        instance: "i",
        keepalive: "10",
        connectedAt: "2026-10-29T12:00:00.000Z",
        appId: "",
        userId: USER,
        tokenHash: "h",
      })?.binding,
    ).toEqual({ appId: null, userId: USER, tokenHash: "h" });
  });
  test("grant member: app or personal, then the user", () => {
    expect(grantMember(APP, USER)).toBe(`${APP}:${USER}`);
    expect(grantMember(null, USER)).toBe(`personal:${USER}`);
  });
});
