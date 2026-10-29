// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer.events.*` over HTTP (E9-subs): the authority rules with their error codes, both
 * transports (a fake `EventSubSessions` and a fake webhook queue), visibility, test events,
 * redelivery and the delivery log. Real Postgres and Valkey.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS, EventSubControlMessage } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { decryptSecret, randomSecret, sha256Hex } from "@commonair/tokens";
import { setWebhookQueue, type WebhookJobName } from "../src/developer/webhook-queue.ts";
import { setEventSubSessions, type BindResult, type EventSubGrant } from "../src/eventsub/index.ts";
import { client, signUpAndSignIn, startApi, subscriber, waitFor, type Client, type TestApi } from "./harness.ts";

const WS_MAX = 2;
let api: TestApi;
const jobs: { name: WebhookJobName; data: Record<string, unknown>; jobId: string }[] = [];
const binds: { sessionId: string; grant: EventSubGrant }[] = [];
/** sessionId → the grant it is bound to (fake E9-ws registry). */
const sessions = new Map<string, EventSubGrant | null>();
const control: EventSubControlMessage[] = [];
const sub = subscriber();

let dev: { client: Client; userId: string };
let appA: string;
let appB: string;
let streamer: string;
let tokA: string; // app token of A
let tokB: string; // app token of B

beforeAll(async () => {
  api = await startApi({ env: { EVENTSUB_WS_MAX_SUBSCRIPTIONS: String(WS_MAX) } });
  setWebhookQueue(api.deps, {
    async enqueue(name, data, jobId) {
      jobs.push({ name, data, jobId });
    },
    async close() {},
  });
  setEventSubSessions(api.deps, {
    async bind(sessionId, grant): Promise<BindResult> {
      binds.push({ sessionId, grant });
      if (sessionId.startsWith("full-")) return "too_many_sessions";
      if (!sessions.has(sessionId)) return "unknown_session";
      const held = sessions.get(sessionId);
      if (held && (held.appId !== grant.appId || held.userId !== grant.userId)) return "other_grant";
      sessions.set(sessionId, grant);
      return "ok";
    },
  });
  await sub.subscribe(BUS.eventsubControl);
  sub.on("message", (_ch, raw) => control.push(EventSubControlMessage.parse(JSON.parse(raw))));
  dev = await signUpAndSignIn(api);
  appA = await newApp(dev.userId);
  appB = await newApp(dev.userId);
  streamer = await newUser();
  tokA = (await token(appA, null)).raw;
  tokB = (await token(appB, null)).raw;
}, 120_000);
afterAll(async () => {
  await sub.quit();
  await api?.stop();
});

const db = () => api.db.db;
const rand = () => uuidv7().replace(/-/g, "").slice(-12);

async function newUser(): Promise<string> {
  const name = `e9s_${rand()}`;
  const [u] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name, emailVerified: true })
    .returning({ id: schema.users.id });
  await db().insert(schema.channels).values({ ownerId: u!.id, slug: name, displayName: name });
  return u!.id;
}

async function newApp(ownerId: string): Promise<string> {
  const [a] = await db()
    .insert(schema.oauthApps)
    .values({
      ownerId,
      name: "subs",
      clientId: `cid_${rand()}`,
      clientSecretHash: "hash",
      redirectUris: ["https://app.example.test/cb"],
    })
    .returning({ id: schema.oauthApps.id });
  return a!.id;
}

async function token(appId: string | null, userId: string | null, scopes: string[] = []) {
  const raw = randomSecret("ca_", 24);
  const [row] = await db()
    .insert(schema.oauthTokens)
    .values({
      appId,
      userId,
      kind: appId === null ? "personal" : userId === null ? "client_credentials" : "authorization_code",
      scopes: userId === null ? [] : scopes,
      accessTokenHash: await sha256Hex(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: schema.oauthTokens.id });
  return { raw, id: row!.id, hash: await sha256Hex(raw) };
}

interface Err {
  code?: string;
  message?: string;
  data?: { requirement?: string };
}
interface Sub {
  id: string;
  appId: string | null;
  userId: string;
  type: string;
  status: string;
  transport: { method: string; callback?: string; sessionId?: string };
}

const as = (bearer: string) => client(api, { bearer });
const hook = (path = rand()) => `https://hooks.example.com/${path}`;
const follow = (cb = hook(), broadcaster = streamer) => ({
  type: "channel.follow",
  condition: { broadcaster_user_id: broadcaster },
  transport: { method: "webhook", callback: cb, secret: "s3cret-0123456789" },
});
const post = <T = Sub & Err>(c: Client, body: unknown) => c.call<T>("POST", "/api/eventsub/subscriptions", body);

// Hosts under example.com resolve to a public address; private.example.com to a private one.
beforeAll(() => {
  api.deps.resolveHost = async (host) => (host.startsWith("private.") ? ["10.0.0.7"] : ["93.184.216.34"]);
});

describe("catalog", () => {
  test("public, every type with transports", async () => {
    const r = await client(api).call<{ type: string; transports: string[] }[]>("GET", "/api/eventsub/types");
    expect(r.status).toBe(200);
    expect(r.body.find((c) => c.type === "channel.chat.message")?.transports).toEqual(["websocket"]);
    expect(r.body.find((c) => c.type === "channel.follow")?.transports).toEqual(["webhook", "websocket"]);
  });
});

describe("webhook subscriptions", () => {
  test("app token, scope-less: backed by the app's owner, pending, verify enqueued, secret encrypted", async () => {
    const r = await post(as(tokA), follow());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ appId: appA, userId: dev.userId, status: "verification_pending" });
    expect(jobs).toContainEqual({
      name: "verify-callback",
      data: { subscriptionId: r.body.id },
      jobId: `verify-${r.body.id}`,
    });
    const [row] = await db()
      .select()
      .from(schema.eventSubscriptions)
      .where(eq(schema.eventSubscriptions.id, r.body.id));
    expect(row?.secretCiphertext).not.toContain("s3cret");
    expect(await decryptSecret(api.deps.env.AUTH_SECRET, "webhook", row!.secretCiphertext!)).toBe("s3cret-0123456789");
  });

  test("an identical subscription is CONFLICT", async () => {
    const body = follow();
    expect((await post(as(tokA), body)).status).toBe(200);
    const again = await post(as(tokA), body);
    expect(again.status).toBe(409);
  });

  test("app token, scoped: refused without the broadcaster's grant, accepted with it", async () => {
    const body = {
      type: "channel.subscribe",
      condition: { broadcaster_user_id: streamer },
      transport: { method: "webhook", callback: hook(), secret: "s3cret-0123456789" },
    };
    const refused = await post(as(tokA), body);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe("The broadcaster has not authorized this app for channel:read:subscriptions");
    await token(appA, streamer, ["channel:read:subscriptions"]);
    const ok = await post(as(tokA), body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ appId: appA, userId: streamer });
    // App B was never authorized.
    expect((await post(as(tokB), body)).status).toBe(403);
  });

  test("webhook is refused for channel.chat.message", async () => {
    const r = await post(as(tokA), {
      type: "channel.chat.message",
      condition: { broadcaster_user_id: streamer, user_id: streamer },
      transport: { method: "webhook", callback: hook(), secret: "s3cret-0123456789" },
    });
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "websocket_only" });
  });

  test("condition keys must be exactly the catalog's", async () => {
    const extra = await post(as(tokA), {
      ...follow(),
      condition: { broadcaster_user_id: streamer, user_id: streamer },
    });
    expect(extra.status).toBe(412);
    expect(extra.body.data).toEqual({ requirement: "condition_keys" });
    const missing = await post(as(tokA), { ...follow(), condition: {} });
    expect(missing.body.data).toEqual({ requirement: "condition_keys" });
  });

  test("a non-UUID user id in the condition is condition_keys, not a 500", async () => {
    const r = await post(as(tokA), {
      type: "channel.subscribe",
      condition: { broadcaster_user_id: "abc" },
      transport: { method: "webhook", callback: hook(), secret: "s3cret-0123456789" },
    });
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "condition_keys" });
  });

  test("appId from a token caller is FORBIDDEN", async () => {
    expect((await post(as(tokA), { ...follow(), appId: appA })).status).toBe(403);
  });

  test("a session: personal scope-less is self-backed; scoped needs a token", async () => {
    const personal = await post(dev.client, follow());
    expect(personal.status).toBe(200);
    expect(personal.body).toMatchObject({ appId: null, userId: dev.userId });
    const scoped = await post(dev.client, {
      type: "channel.subscribe",
      condition: { broadcaster_user_id: dev.userId },
      transport: { method: "webhook", callback: hook(), secret: "s3cret-0123456789" },
    });
    expect(scoped.status).toBe(412);
    expect(scoped.body.data).toEqual({ requirement: "token_required" });
  });

  test("a session for an app: owned and not suspended, else NOT_FOUND", async () => {
    const mine = await post(dev.client, { ...follow(), appId: appB });
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ appId: appB, userId: dev.userId });
    const someoneElses = await newApp(streamer);
    expect((await post(dev.client, { ...follow(), appId: someoneElses })).status).toBe(404);
    const suspended = await newApp(dev.userId);
    await db()
      .update(schema.oauthApps)
      .set({ suspendedAt: new Date(), suspendedReason: "abuse", suspendedById: dev.userId })
      .where(eq(schema.oauthApps.id, suspended));
    expect((await post(dev.client, { ...follow(), appId: suspended })).status).toBe(404);
  });

  test("a user token: scoped subscriptions only for a condition naming the user", async () => {
    const user = await newUser();
    const t = await token(appA, user, ["channel:read:subscriptions"]);
    const body = (b: string) => ({
      type: "channel.subscribe",
      condition: { broadcaster_user_id: b },
      transport: { method: "webhook", callback: hook(), secret: "s3cret-0123456789" },
    });
    const other = await post(as(t.raw), body(streamer));
    expect(other.status).toBe(403);
    const own = await post(as(t.raw), body(user));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ appId: appA, userId: user });
  });

  test("callbacks: https on public hosts only, unless insecure callbacks are allowed", async () => {
    for (const cb of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://private.example.com/x"]) {
      const r = await post(as(tokA), follow(cb));
      expect(r.status, cb).toBe(412);
      expect(r.body.data).toEqual({ requirement: "callback_url" });
    }
    const env = api.deps.env as { EVENTSUB_ALLOW_INSECURE_CALLBACKS: boolean };
    env.EVENTSUB_ALLOW_INSECURE_CALLBACKS = true;
    try {
      expect((await post(as(tokA), follow("http://127.0.0.1:9/hook"))).status).toBe(200);
    } finally {
      env.EVENTSUB_ALLOW_INSECURE_CALLBACKS = false;
    }
  });

  test("personal limit: 1000 webhook subscriptions per user", async () => {
    const user = await newUser();
    const personal = await token(null, user);
    await db().execute(
      sql`insert into event_subscriptions (id, user_id, type, condition, transport, callback_url, secret_ciphertext)
       select gen_random_uuid(), ${user}::uuid, 'channel.follow', '{"broadcaster_user_id":"x"}'::jsonb, 'webhook',
              'https://hooks.example.com/' || i, 'ct' from generate_series(1, 1000) i`,
    );
    const r = await post(as(personal.raw), follow());
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "subscription_limit" });
  });

  test("revoked and failed rows do not count toward the limit", async () => {
    const user = await newUser();
    const personal = await token(null, user);
    await db().execute(
      sql`insert into event_subscriptions (id, user_id, type, condition, transport, callback_url, secret_ciphertext, status)
       select gen_random_uuid(), ${user}::uuid, 'channel.follow', '{"broadcaster_user_id":"x"}'::jsonb, 'webhook',
              'https://hooks.example.com/' || i, 'ct', case when i % 2 = 0 then 'revoked' else 'failed' end::event_subscription_state
       from generate_series(1, 1000) i`,
    );
    expect((await post(as(personal.raw), follow())).status).toBe(200);
  });

  test("app limit: 10000 webhook subscriptions per app", async () => {
    const app = await newApp(dev.userId);
    const appTok = (await token(app, null)).raw;
    await db().execute(
      sql`insert into event_subscriptions (id, app_id, user_id, type, condition, transport, callback_url, secret_ciphertext, status)
       select gen_random_uuid(), ${app}::uuid, ${dev.userId}::uuid, 'channel.follow', '{"broadcaster_user_id":"x"}'::jsonb,
              'webhook', 'https://hooks.example.com/' || i, 'ct', 'enabled'
       from generate_series(1, 10000) i`,
    );
    const r = await post(as(appTok), follow());
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "subscription_limit" });
  });
});

describe("WebSocket subscriptions", () => {
  const ws = (
    sessionId: string,
    type = "channel.follow",
    condition: Record<string, string> = { broadcaster_user_id: streamer },
  ) => ({
    type,
    condition,
    transport: { method: "websocket", sessionId },
  });

  test("a session or an app token cannot", async () => {
    sessions.set("s-any", null);
    expect((await post(dev.client, ws("s-any"))).status).toBe(403);
    expect((await post(as(tokA), ws("s-any"))).status).toBe(403);
  });

  test("bind outcomes", async () => {
    const t = await token(appA, streamer, ["chat:read"]);
    const unknown = await post(as(t.raw), ws(`nope-${rand()}`));
    expect(unknown.status).toBe(412);
    expect(unknown.body.data).toEqual({ requirement: "websocket_session" });
    const full = await post(as(t.raw), ws(`full-${rand()}`));
    expect(full.status).toBe(412);
    expect(full.body.data).toEqual({ requirement: "websocket_session_limit" });
    const taken = `taken-${rand()}`;
    sessions.set(taken, { appId: appB, userId: streamer, tokenHash: "x" });
    expect((await post(as(t.raw), ws(taken))).status).toBe(403);
  });

  test("created enabled, bound with the token's grant, per-session limit, subscriptions_changed published", async () => {
    const t = await token(appA, streamer, ["chat:read"]);
    const sid = `s-${rand()}`;
    sessions.set(sid, null);
    const chat = await post(
      as(t.raw),
      ws(sid, "channel.chat.message", { broadcaster_user_id: streamer, user_id: streamer }),
    );
    expect(chat.status).toBe(200);
    expect(chat.body).toMatchObject({
      appId: appA,
      userId: streamer,
      status: "enabled",
      transport: { method: "websocket", sessionId: sid },
    });
    expect(binds.find((b) => b.sessionId === sid)?.grant).toEqual({ appId: appA, userId: streamer, tokenHash: t.hash });
    await waitFor(async () => control.find((m) => m.sessionId === sid));

    // Duplicate on the same session: CONFLICT.
    expect(
      (await post(as(t.raw), ws(sid, "channel.chat.message", { broadcaster_user_id: streamer, user_id: streamer })))
        .status,
    ).toBe(409);
    expect((await post(as(t.raw), ws(sid))).status).toBe(200);
    const over = await post(as(t.raw), ws(sid, "stream.online"));
    expect(over.status).toBe(412);
    expect(over.body.data).toEqual({ requirement: "websocket_subscription_limit" });

    // Delete: published again, no webhook job.
    const before = control.filter((m) => m.sessionId === sid).length;
    const del = await as(t.raw).call("DELETE", `/api/eventsub/subscriptions/${chat.body.id}`);
    expect(del.status).toBe(200);
    await waitFor(async () => control.filter((m) => m.sessionId === sid).length > before || null);
    expect(jobs.some((j) => j.data.subscriptionId === chat.body.id)).toBe(false);
  });

  test("a scoped WebSocket subscription needs the user's authorization", async () => {
    // `authorizeSubscription` looks at every live token of the grant, so use a user with none scoped.
    const user = await newUser();
    const t = await token(appA, user, []);
    const sid = `s-${rand()}`;
    sessions.set(sid, null);
    const r = await post(as(t.raw), ws(sid, "channel.chat.message", { broadcaster_user_id: streamer, user_id: user }));
    expect(r.status).toBe(403);
  });
});

describe("visibility, test events, redelivery, delivery log", () => {
  let other: string;
  let otherPersonal: { raw: string };
  let streamerA: { raw: string };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    other = await newUser();
    otherPersonal = await token(null, other);
    streamerA = await token(appA, streamer, ["channel:read:subscriptions"]);
    ids.aOwner = (await post(as(tokA), follow())).body.id;
    ids.aStreamer = (await post(as(streamerA.raw), follow(hook(), streamer))).body.id;
    ids.b = (await post(as(tokB), follow())).body.id;
    ids.devPersonal = (await post(dev.client, follow())).body.id;
    ids.otherPersonal = (await post(as(otherPersonal.raw), follow(hook(), other))).body.id;
  });

  const listIds = async (c: Client, query = "") => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams(query);
      q.set("limit", "5");
      if (cursor) q.set("cursor", cursor);
      const r = await c.call<{ items: Sub[]; nextCursor: string | null }>("GET", `/api/eventsub/subscriptions?${q}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((s) => s.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    return seen;
  };

  test("list across two apps and personal callers", async () => {
    const a = await listIds(as(tokA));
    expect(a).toEqual(expect.arrayContaining([ids.aOwner, ids.aStreamer]));
    expect(a).not.toContain(ids.b);
    expect(a).not.toContain(ids.devPersonal);
    const b = await listIds(as(tokB));
    expect(b).toContain(ids.b);
    expect(b).not.toContain(ids.aOwner);
    const session = await listIds(dev.client);
    expect(session).toEqual(expect.arrayContaining([ids.aOwner, ids.aStreamer, ids.b, ids.devPersonal]));
    expect(session).not.toContain(ids.otherPersonal);
    expect(await listIds(dev.client, `appId=${appB}`)).not.toContain(ids.aOwner);
    const streamerList = await listIds(as(streamerA.raw));
    expect(streamerList).toContain(ids.aStreamer);
    expect(streamerList).not.toContain(ids.aOwner);
    expect(await listIds(as(otherPersonal.raw))).toEqual([ids.otherPersonal]);
    // Newest first, no duplicates across pages.
    expect(new Set(session).size).toBe(session.length);
    const enabled = await listIds(as(tokA), "status=enabled");
    expect(enabled).not.toContain(ids.aOwner);
    expect(await listIds(as(tokA), "type=channel.subscribe")).not.toContain(ids.aStreamer);
  });

  test("unsubscribe and sendTest outside visibility are NOT_FOUND", async () => {
    expect((await as(tokB).call("DELETE", `/api/eventsub/subscriptions/${ids.aOwner}`)).status).toBe(404);
    expect(
      (await as(otherPersonal.raw).call("POST", `/api/eventsub/subscriptions/${ids.devPersonal}/test`)).status,
    ).toBe(404);
    expect((await as(streamerA.raw).call("GET", `/api/eventsub/subscriptions/${ids.aOwner}/deliveries`)).status).toBe(
      404,
    );
  });

  test("sendTest: enabled webhook subscriptions only; enqueues test-<eventId>", async () => {
    const pending = await as(tokA).call<Err>("POST", `/api/eventsub/subscriptions/${ids.aOwner}/test`);
    expect(pending.status).toBe(412);
    expect(pending.body.data).toEqual({ requirement: "not_enabled" });
    await db()
      .update(schema.eventSubscriptions)
      .set({ status: "enabled" })
      .where(eq(schema.eventSubscriptions.id, ids.aOwner!));
    const r = await as(tokA).call<{ eventId: string }>("POST", `/api/eventsub/subscriptions/${ids.aOwner}/test`);
    expect(r.status).toBe(200);
    expect(jobs).toContainEqual({
      name: "test-event",
      data: { subscriptionId: ids.aOwner, eventId: r.body.eventId },
      jobId: `test-${r.body.eventId}`,
    });

    const t = await token(appA, streamer, []);
    const sid = `s-${rand()}`;
    sessions.set(sid, null);
    const w = await post(as(t.raw), {
      type: "stream.online",
      condition: { broadcaster_user_id: streamer },
      transport: { method: "websocket", sessionId: sid },
    });
    const wt = await as(t.raw).call<Err>("POST", `/api/eventsub/subscriptions/${w.body.id}/test`);
    expect(wt.status).toBe(412);
    expect(wt.body.data).toEqual({ requirement: "webhook_only" });
  });

  test("deliveries (newest first, paged, no response body) and redeliver", async () => {
    const subId = ids.aOwner!;
    const [event] = await db()
      .insert(schema.events)
      .values({ type: "channel.follow", payload: { broadcaster_user_id: streamer } })
      .returning({ id: schema.events.id });
    const mk = async (over: Partial<typeof schema.webhookDeliveries.$inferInsert>) => {
      const [d] = await db()
        .insert(schema.webhookDeliveries)
        .values({
          id: uuidv7(),
          subscriptionId: subId,
          eventId: event!.id,
          messageId: "m-1",
          status: "failed",
          responseBody: "operator only",
          ...over,
        })
        .returning();
      return d!;
    };
    const failed = await mk({});
    const revocation = await mk({ messageType: "revocation", eventId: uuidv7() });
    const testEvent = await mk({ eventId: uuidv7(), status: "succeeded" });

    const page1 = await as(tokA).call<{ items: Record<string, unknown>[]; nextCursor: string | null }>(
      "GET",
      `/api/eventsub/subscriptions/${subId}/deliveries?limit=2`,
    );
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((d) => d.id)).toEqual([testEvent.id, revocation.id]);
    expect(page1.body.items[0]).not.toHaveProperty("responseBody");
    const page2 = await as(tokA).call<{ items: { id: string }[]; nextCursor: string | null }>(
      "GET",
      `/api/eventsub/subscriptions/${subId}/deliveries?limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items.map((d) => d.id)).toEqual([failed.id]);
    expect(page2.body.nextCursor).toBeNull();

    const r = await dev.client.call("POST", `/api/eventsub/deliveries/${failed.id}/redeliver`);
    expect(r.status).toBe(200);
    const job = jobs.find((j) => j.name === "redeliver" && j.data.deliveryId === failed.id);
    expect(job?.jobId).toMatch(new RegExp(`^redeliver-${failed.id}-\\d+$`));

    const rev = await as(tokA).call<Err>("POST", `/api/eventsub/deliveries/${revocation.id}/redeliver`);
    expect(rev.status).toBe(412);
    expect(rev.body.data).toEqual({ requirement: "notification_only" });
    const test = await as(tokA).call<Err>("POST", `/api/eventsub/deliveries/${testEvent.id}/redeliver`);
    expect(test.status).toBe(412);
    expect(test.body.data).toEqual({ requirement: "not_replayable" });
    expect((await as(tokB).call("POST", `/api/eventsub/deliveries/${failed.id}/redeliver`)).status).toBe(404);
  });

  test("unsubscribe deletes the row and its deliveries", async () => {
    const r = await as(tokA).call("DELETE", `/api/eventsub/subscriptions/${ids.aOwner}`);
    expect(r.status).toBe(200);
    expect(
      await db()
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.subscriptionId, ids.aOwner!)),
    ).toEqual([]);
    expect((await as(tokA).call("DELETE", `/api/eventsub/subscriptions/${ids.aOwner}`)).status).toBe(404);
  });
});
