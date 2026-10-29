// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The EventSub WebSocket transport end to end (E9-ws, ADR 0027 §3): real Bun servers with the
 * eventsub handler, real Postgres and Valkey, subscription rows inserted the way E9-subs does
 * (bind, insert, `subscriptions_changed`). Welcome, keepalive, 4001, 4003, bind outcomes and the
 * per-grant limit, notifications with the deterministic message id, revocation at delivery and by
 * `BUS.userControl` (4008), reconnect across two instances, invalid resume (4007), the sweep.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import {
  BUS,
  WsMessage,
  type BusEvent,
  type PublicEventType,
  type UserControlMessage,
} from "@commonair/contracts/events";
import { KEYS } from "@commonair/contracts/internal";
import { notificationMessageId, schema, uuidv7 } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import type { Deps } from "../src/deps.ts";
import {
  eventSubSessions,
  startEventSub,
  type EventSubGrant,
  type EventSubHub,
  type EventSubSocketData,
} from "../src/eventsub/index.ts";
import { startApi, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
const stops: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  api = await startApi({
    env: {
      EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS: "2",
      EVENTSUB_WS_RECONNECT_GRACE_SECONDS: "3",
      EVENTSUB_WS_MAX_SESSIONS_PER_GRANT: "3",
    },
  });
}, 120_000);
afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
  await api?.stop();
});

const ownerDb = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-12);

interface Served {
  hub: EventSubHub;
  deps: Deps;
  /** `ws://127.0.0.1:<port>/eventsub/ws` */
  wsUrl: string;
}

/** One API "process": its own deps object (so its own hub), a Bun server with the handler. */
async function serve(): Promise<Served> {
  const deps: Deps = { ...api.deps };
  const hub = startEventSub(deps, {
    keepaliveMinSeconds: 1,
    tickMs: 100,
    authCacheMs: 200,
    sweepMs: 3_600_000,
    handleSignals: false,
  });
  const server = Bun.serve<EventSubSocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) =>
      new URL(req.url).pathname === EVENTSUB_WS_PATH ? hub.upgrade(req, srv) : new Response(null, { status: 404 }),
    websocket: hub.websocket,
  });
  stops.push(async () => {
    await hub.close();
    await server.stop(true);
  });
  await waitFor(async () => hub.warm, 10_000);
  return { hub, deps, wsUrl: `ws://127.0.0.1:${server.port}${EVENTSUB_WS_PATH}` };
}

interface Client {
  messages: WsMessage[];
  next(type: WsMessage["metadata"]["message_type"], timeoutMs?: number): Promise<WsMessage>;
  closed: Promise<{ code: number; reason: string }>;
  isOpen(): boolean;
  send(data: string): void;
  close(): void;
}

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  const messages: WsMessage[] = [];
  let read = 0;
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (ev) => {
    messages.push(WsMessage.parse(JSON.parse(String(ev.data))));
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }), { once: true }),
  );
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
  });
  stops.push(() => ws.close());
  return {
    messages,
    closed,
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: (d) => ws.send(d),
    close: () => ws.close(),
    // Messages in order: skips everything before the next one of `type`.
    async next(type, timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        while (read < messages.length) {
          const m = messages[read++]!;
          if (m.metadata.message_type === type) return m;
        }
        if (Date.now() > until) throw new Error(`no ${type} within ${timeoutMs} ms`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
}

async function welcomed(url: string): Promise<{ client: Client; sessionId: string }> {
  const client = await connect(url);
  const w = await client.next("session_welcome");
  return { client, sessionId: w.payload.session!.id };
}

async function newUser(): Promise<string> {
  const name = `e9ws_${rand()}`;
  const [u] = await ownerDb()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function newApp(ownerId: string): Promise<string> {
  const [a] = await ownerDb()
    .insert(schema.oauthApps)
    .values({
      ownerId,
      name: "ws",
      clientId: `cid_${rand()}`,
      clientSecretHash: "hash",
      redirectUris: ["https://app.example.test/cb"],
    })
    .returning({ id: schema.oauthApps.id });
  return a!.id;
}

async function newToken(appId: string, userId: string, scopes: string[]): Promise<{ id: string; hash: string }> {
  const hash = await sha256Hex(`at_${rand()}`);
  const [row] = await ownerDb()
    .insert(schema.oauthTokens)
    .values({
      appId,
      userId,
      kind: "authorization_code",
      scopes,
      accessTokenHash: hash,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: schema.oauthTokens.id });
  return { id: row!.id, hash };
}

/** What E9-subs does for a WebSocket subscribe: bind, insert `enabled`, publish `subscriptions_changed`. */
async function subscribe(
  s: Served,
  sessionId: string,
  grant: EventSubGrant,
  type: PublicEventType,
  condition: Record<string, string>,
): Promise<string> {
  expect(await eventSubSessions(s.deps).bind(sessionId, grant)).toBe("ok");
  const [row] = await ownerDb()
    .insert(schema.eventSubscriptions)
    .values({
      appId: grant.appId,
      userId: grant.userId,
      type,
      condition,
      transport: "websocket",
      websocketSessionId: sessionId,
      status: "enabled",
    })
    .returning({ id: schema.eventSubscriptions.id });
  await api.deps.valkey.publish(BUS.eventsubControl, JSON.stringify({ op: "subscriptions_changed", sessionId }));
  await waitFor(async () => s.hub.index.has(row!.id));
  return row!.id;
}

async function publishEvent(type: PublicEventType, payload: Record<string, unknown>): Promise<BusEvent> {
  const ev: BusEvent = {
    id: uuidv7(),
    type,
    version: "1",
    channelId: null,
    payload,
    occurredAt: new Date().toISOString(),
  };
  await api.deps.valkey.publish(BUS.events, JSON.stringify(ev));
  return ev;
}

async function control(msg: UserControlMessage): Promise<void> {
  await api.deps.valkey.publish(BUS.userControl, JSON.stringify(msg));
}

const rowsOf = (sessionId: string) =>
  ownerDb()
    .select({ id: schema.eventSubscriptions.id })
    .from(schema.eventSubscriptions)
    .where(eq(schema.eventSubscriptions.websocketSessionId, sessionId));

const followPayload = (broadcaster: string) => ({
  broadcaster_user_id: broadcaster,
  broadcaster_user_login: "b",
  broadcaster_user_name: "b",
  user_id: uuidv7(),
  user_login: "f",
  user_name: "f",
  followed_at: new Date().toISOString(),
});

describe("connect", () => {
  test("welcome: session id, keepalive 10, the session in Valkey", async () => {
    const s = await serve();
    const { client, sessionId } = await welcomed(s.wsUrl);
    const w = client.messages[0]!;
    expect(w.payload.session).toMatchObject({
      status: "connected",
      keepalive_timeout_seconds: 10,
      reconnect_url: null,
    });
    const h = await api.deps.valkey.hgetall(KEYS.eventsubSession(sessionId));
    expect(h.instance).toBe(s.hub.instance);
    expect(h.keepalive).toBe("10");
    expect(await api.deps.valkey.pttl(KEYS.eventsubSession(sessionId))).toBeGreaterThan(20_000);
    client.close();
  });

  test("keepalive after the (lowered) period", async () => {
    const s = await serve();
    const { client } = await welcomed(`${s.wsUrl}?keepalive_timeout_seconds=1`);
    expect(client.messages[0]!.payload.session?.keepalive_timeout_seconds).toBe(1);
    const started = Date.now();
    await client.next("session_keepalive", 1500);
    expect(Date.now() - started).toBeLessThanOrEqual(1100);
    client.close();
  });

  test("not an upgrade → 426; bad keepalive → refused", async () => {
    const s = await serve();
    const res = await fetch(s.wsUrl.replace(/^ws/, "http"));
    expect(res.status).toBe(426);
    await expect(connect(`${s.wsUrl}?keepalive_timeout_seconds=601`)).rejects.toThrow("connect failed");
    await expect(connect(`${s.wsUrl}?keepalive_timeout_seconds=ten`)).rejects.toThrow("connect failed");
  });

  test("an unused session closes 4003 and its state goes", async () => {
    const s = await serve();
    const { client, sessionId } = await welcomed(s.wsUrl);
    const closed = await client.closed;
    expect(closed.code).toBe(4003);
    expect(closed.reason).toBe("connection unused");
    await waitFor(async () => (await api.deps.valkey.exists(KEYS.eventsubSession(sessionId))) === 0);
  });

  test("client traffic closes 4001", async () => {
    const s = await serve();
    const { client } = await welcomed(s.wsUrl);
    client.send("hello");
    expect((await client.closed).code).toBe(4001);
  });

  test("an unknown resume token closes 4007", async () => {
    const s = await serve();
    const client = await connect(`${s.wsUrl}?resume=ces_${"0".repeat(64)}`);
    const closed = await client.closed;
    expect(closed.code).toBe(4007);
    expect(client.messages).toEqual([]);
  });
});

describe("bind", () => {
  test("unknown session, same grant with another token, other grants", async () => {
    const s = await serve();
    const sessions = eventSubSessions(s.deps);
    const [u, v] = [await newUser(), await newUser()];
    const app = await newApp(u);
    expect(await sessions.bind(uuidv7(), { appId: app, userId: u, tokenHash: "h1" })).toBe("unknown_session");

    const { client, sessionId } = await welcomed(s.wsUrl);
    expect(await sessions.bind(sessionId, { appId: app, userId: u, tokenHash: "h1" })).toBe("ok");
    expect(await sessions.bind(sessionId, { appId: app, userId: u, tokenHash: "h2" })).toBe("ok");
    expect(await api.deps.valkey.hget(KEYS.eventsubSession(sessionId), "tokenHash")).toBe("h2");
    expect(await sessions.bind(sessionId, { appId: app, userId: v, tokenHash: "h3" })).toBe("other_grant");
    expect(await sessions.bind(sessionId, { appId: null, userId: u, tokenHash: "h4" })).toBe("other_grant");
    expect(await sessions.bind(sessionId, { appId: await newApp(u), userId: u, tokenHash: "h5" })).toBe("other_grant");
    client.close();
  });

  test("at most 3 sessions per grant; a stale member does not count", async () => {
    const s = await serve();
    const sessions = eventSubSessions(s.deps);
    const u = await newUser();
    const app = await newApp(u);
    const grant = { appId: app, userId: u, tokenHash: "h" };
    const opened = await Promise.all([1, 2, 3, 4].map(() => welcomed(s.wsUrl)));
    for (const o of opened.slice(0, 3)) expect(await sessions.bind(o.sessionId, grant)).toBe("ok");
    expect(await sessions.bind(opened[3]!.sessionId, grant)).toBe("too_many_sessions");
    // A personal grant of the same user is another grant.
    expect(await sessions.bind(opened[3]!.sessionId, { ...grant, appId: null })).toBe("ok");

    // A session that vanished without ending (crashed instance) stays a member until bind sees it.
    const w = await newUser();
    const key = KEYS.eventsubGrantSessions(`personal:${w}`);
    await api.deps.valkey.zadd(key, 1, "dead-1", 2, "dead-2", 3, "dead-3");
    const fresh = await welcomed(s.wsUrl);
    expect(await sessions.bind(fresh.sessionId, { appId: null, userId: w, tokenHash: "x" })).toBe("ok");
    expect(await api.deps.valkey.zrange(key, 0, -1)).toEqual([fresh.sessionId]);

    // A closed session leaves its grant set.
    opened[0]!.client.close();
    const grantKey = KEYS.eventsubGrantSessions(`${app}:${u}`);
    await waitFor(async () => (await api.deps.valkey.zscore(grantKey, opened[0]!.sessionId)) === null);
    expect(await sessions.bind(opened[3]!.sessionId, grant)).toBe("other_grant");
    for (const o of [...opened, fresh]) o.client.close();
  });
});

describe("fan-out", () => {
  test("a matching event arrives as a notification with the deterministic id; others do not", async () => {
    const s = await serve();
    const u = await newUser();
    const app = await newApp(u);
    const { client, sessionId } = await welcomed(s.wsUrl);
    const subId = await subscribe(s, sessionId, { appId: app, userId: u, tokenHash: "h" }, "channel.follow", {
      broadcaster_user_id: u,
    });
    await publishEvent("channel.follow", followPayload(uuidv7()));
    const ev = await publishEvent("channel.follow", followPayload(u));
    const n = await client.next("notification");
    expect(n.metadata.message_id).toBe(notificationMessageId(subId, ev.id));
    expect(n.metadata.subscription_type).toBe("channel.follow");
    expect(n.payload.subscription).toMatchObject({
      id: subId,
      status: "enabled",
      transport: { method: "websocket", session_id: sessionId },
    });
    expect(n.payload.event).toEqual(ev.payload);
    await Bun.sleep(300);
    expect(client.messages.filter((m) => m.metadata.message_type === "notification")).toHaveLength(1);
    // A session with a subscription is used: not closed 4003 after the 2 s.
    await Bun.sleep(2200);
    expect(client.isOpen()).toBe(true);
    client.close();
    await waitFor(async () => (await rowsOf(sessionId)).length === 0);
  });

  test("an authorization that no longer holds → revocation, row deleted", async () => {
    const s = await serve();
    const u = await newUser();
    const app = await newApp(u);
    const token = await newToken(app, u, ["chat:read"]);
    const { client, sessionId } = await welcomed(s.wsUrl);
    const cond = { broadcaster_user_id: uuidv7(), user_id: u };
    const subId = await subscribe(
      s,
      sessionId,
      { appId: app, userId: u, tokenHash: token.hash },
      "channel.chat.message",
      cond,
    );
    const chat = (text: string) =>
      publishEvent("channel.chat.message", {
        broadcaster_user_id: cond.broadcaster_user_id,
        chatter_user_id: uuidv7(),
        message_id: uuidv7(),
        message: { text },
      });
    const first = await chat("hi");
    expect((await client.next("notification")).metadata.message_id).toBe(notificationMessageId(subId, first.id));

    await ownerDb()
      .update(schema.oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.oauthTokens.id, token.id));
    await Bun.sleep(300); // past the (lowered) authorization cache
    await chat("again");
    const r = await client.next("revocation");
    expect(r.payload.subscription).toMatchObject({ id: subId, status: "authorization_revoked" });
    await waitFor(async () => (await rowsOf(sessionId)).length === 0);
    expect(client.messages.filter((m) => m.metadata.message_type === "notification")).toHaveLength(1);
    expect(s.hub.index.has(subId)).toBe(false);
    client.close();
  });
});

describe("revocation by BUS.userControl", () => {
  test("by token hash, by grant, by app; token_rotated closes nothing", async () => {
    const s = await serve();
    const [u1, u2] = [await newUser(), await newUser()];
    const [a, b] = [await newApp(u1), await newApp(u1)];
    const open = async (grant: EventSubGrant) => {
      const { client, sessionId } = await welcomed(s.wsUrl);
      const subId = await subscribe(s, sessionId, grant, "channel.follow", { broadcaster_user_id: grant.userId });
      return { client, sessionId, subId };
    };
    const s1 = await open({ appId: a, userId: u1, tokenHash: "t1" });
    const s2 = await open({ appId: a, userId: u1, tokenHash: "t2" });
    const s3 = await open({ appId: b, userId: u1, tokenHash: "t3" });
    const s4 = await open({ appId: a, userId: u2, tokenHash: "t4" });
    const all = [s1, s2, s3, s4];

    await control({ op: "disconnect", userId: u1, appId: a, tokenHash: "t1", reason: "token_rotated" });
    await control({ op: "invalidate", userId: u1, reason: "role_changed" });
    await Bun.sleep(400);
    expect(all.map((x) => x.client.isOpen())).toEqual([true, true, true, true]);

    await control({ op: "disconnect", userId: u1, appId: a, tokenHash: "t1", reason: "token_revoked" });
    expect((await s1.client.closed).code).toBe(4008);
    const rev = s1.client.messages.find((m) => m.metadata.message_type === "revocation");
    expect(rev?.payload.subscription).toMatchObject({ id: s1.subId, status: "authorization_revoked" });
    await waitFor(async () => (await rowsOf(s1.sessionId)).length === 0);

    await control({ op: "disconnect", userId: u1, appId: a, reason: "grant_revoked" });
    expect((await s2.client.closed).code).toBe(4008);

    await control({ op: "disconnect", appId: b, reason: "app_suspended" });
    expect((await s3.client.closed).code).toBe(4008);

    await Bun.sleep(300);
    expect(s4.client.isOpen()).toBe(true);
    expect((await rowsOf(s4.sessionId)).length).toBe(1);
    for (const x of [s2, s3]) await waitFor(async () => (await rowsOf(x.sessionId)).length === 0);
    s4.client.close();
  });

  test("a session bound with a refreshed token is closed by that token's revocation, not the old one's", async () => {
    const s = await serve();
    const u = await newUser();
    const app = await newApp(u);
    const { client, sessionId } = await welcomed(s.wsUrl);
    await subscribe(s, sessionId, { appId: app, userId: u, tokenHash: "old" }, "channel.follow", {
      broadcaster_user_id: u,
    });
    await subscribe(s, sessionId, { appId: app, userId: u, tokenHash: "new" }, "stream.online", {
      broadcaster_user_id: u,
    });
    await control({ op: "disconnect", userId: u, appId: app, tokenHash: "old", reason: "token_revoked" });
    await Bun.sleep(300);
    expect(client.isOpen()).toBe(true);
    await control({ op: "disconnect", userId: u, appId: app, tokenHash: "new", reason: "token_revoked" });
    expect((await client.closed).code).toBe(4008);
    expect(client.messages.filter((m) => m.metadata.message_type === "revocation")).toHaveLength(2);
  });
});

describe("reconnect", () => {
  test("drain → session_reconnect; resume on another instance keeps the session; events arrive once, on the new socket", async () => {
    const a = await serve();
    const b = await serve();
    const u = await newUser();
    const app = await newApp(u);
    const { client: old, sessionId } = await welcomed(a.wsUrl);
    const subId = await subscribe(a, sessionId, { appId: app, userId: u, tokenHash: "h" }, "channel.follow", {
      broadcaster_user_id: u,
    });

    const drained = a.hub.drain();
    const rc = await old.next("session_reconnect");
    expect(a.hub.warm).toBe(false);
    const url = new URL(rc.payload.session!.reconnect_url!);
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe(new URL(api.deps.site.publicUrl).host);
    expect(url.pathname).toBe(EVENTSUB_WS_PATH);
    const resume = url.searchParams.get("resume")!;
    expect(resume).toMatch(/^ces_[0-9a-f]{64}$/);

    // The draining instance refuses new sessions.
    await expect(connect(a.wsUrl)).rejects.toThrow("connect failed");

    const fresh = await connect(`${b.wsUrl}?resume=${resume}`);
    const w = await fresh.next("session_welcome");
    expect(w.payload.session?.id).toBe(sessionId);
    expect(w.payload.session?.status).toBe("connected");
    expect((await old.closed).code).toBe(1000);
    await drained;

    const ev = await publishEvent("channel.follow", followPayload(u));
    const n = await fresh.next("notification");
    expect(n.metadata.message_id).toBe(notificationMessageId(subId, ev.id));
    await Bun.sleep(300);
    expect(fresh.messages.filter((m) => m.metadata.message_type === "notification")).toHaveLength(1);
    expect(old.messages.filter((m) => m.metadata.message_type === "notification")).toHaveLength(0);
    // The subscription stayed, keyed by the same session, now held by b.
    expect((await rowsOf(sessionId)).map((r) => r.id)).toEqual([subId]);
    expect(await api.deps.valkey.hget(KEYS.eventsubSession(sessionId), "instance")).toBe(b.hub.instance);

    // The token was one-time.
    const again = await connect(`${b.wsUrl}?resume=${resume}`);
    expect((await again.closed).code).toBe(4007);
    fresh.close();
    await waitFor(async () => (await rowsOf(sessionId)).length === 0);
  });

  test("a session that does not move within the grace closes 4004 and ends", async () => {
    const a = await serve();
    const u = await newUser();
    const app = await newApp(u);
    const { client, sessionId } = await welcomed(a.wsUrl);
    await subscribe(a, sessionId, { appId: app, userId: u, tokenHash: "h" }, "channel.follow", {
      broadcaster_user_id: u,
    });
    const started = Date.now();
    await a.hub.drain();
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    expect((await client.closed).code).toBe(4004);
    await waitFor(async () => (await rowsOf(sessionId)).length === 0);
    expect(await api.deps.valkey.exists(KEYS.eventsubSession(sessionId))).toBe(0);
  });
});

describe("sweep", () => {
  test("deletes old rows of vanished sessions only", async () => {
    const s = await serve();
    const u = await newUser();
    const live = await welcomed(s.wsUrl);
    const old = new Date(Date.now() - 3_600_000);
    const insert = async (sessionId: string, createdAt: Date) => {
      const [row] = await ownerDb()
        .insert(schema.eventSubscriptions)
        .values({
          appId: null,
          userId: u,
          type: "channel.follow",
          condition: { broadcaster_user_id: rand() },
          transport: "websocket",
          websocketSessionId: sessionId,
          status: "enabled",
          createdAt,
        })
        .returning({ id: schema.eventSubscriptions.id });
      return row!.id;
    };
    const orphanOld = await insert(`gone-${rand()}`, old);
    const orphanNew = await insert(`gone-${rand()}`, new Date());
    const liveOld = await insert(live.sessionId, old);
    expect(await s.hub.sweep()).toBeGreaterThanOrEqual(1);
    const left = await ownerDb()
      .select({ id: schema.eventSubscriptions.id })
      .from(schema.eventSubscriptions)
      .where(and(eq(schema.eventSubscriptions.userId, u)));
    expect(left.map((r) => r.id).sort()).toEqual([orphanNew, liveOld].sort());
    expect(left.map((r) => r.id)).not.toContain(orphanOld);
    // Only the lock holder sweeps.
    expect(await s.hub.sweep()).toBe(0);
    live.client.close();
  });
});
