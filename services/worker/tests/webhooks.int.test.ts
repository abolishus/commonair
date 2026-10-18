// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { BusEvent, WEBHOOK_HEADERS } from "@commonair/contracts/events";
import { QUEUES } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { createValkey } from "@commonair/service";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { WEBHOOK_JOBS } from "../src/jobs/names.ts";
import {
  broadcasterFields,
  insertEvent,
  makeApp,
  makeSubscription,
  makeToken,
  makeUser,
  setup,
  startReceiver,
  VALKEY_URL,
  waitFor,
  type TestEnv,
} from "./fixtures.ts";

const SECRET = "receiver-secret-0123";
let env: TestEnv;
const busMessages: BusEvent[] = [];
const subscriber = createValkey(VALKEY_URL, { name: "worker-test-sub" });

// Per-path behaviour: a counter lets a path fail N times before succeeding.
const failuresLeft = new Map<string, number>();
const receiver = startReceiver(SECRET, (path, body) => {
  if (path.startsWith("/flaky")) {
    const left = failuresLeft.get(path) ?? 0;
    if (left > 0) {
      failuresLeft.set(path, left - 1);
      return new Response("busy", { status: 500 });
    }
    return new Response("ok");
  }
  if (path === "/echo")
    return new Response(typeof body.challenge === "string" ? body.challenge : "", {
      headers: { "content-type": "text/plain" },
    });
  if (path === "/wrong-echo") return new Response("not the challenge");
  if (path.startsWith("/down")) return new Response("down", { status: 503 });
  return new Response("ok");
});

beforeAll(async () => {
  env = await setup();
  await subscriber.subscribe(`test:${env.tag}:bus:events`);
  subscriber.on("message", (_ch, msg) => busMessages.push(BusEvent.parse(JSON.parse(msg))));
  await env.worker.start();
});
afterAll(async () => {
  await receiver.stop();
  await subscriber.quit();
  await env.close();
});

const deliveriesOf = (subscriptionId: string) =>
  env.t.db
    .select()
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.subscriptionId, subscriptionId))
    .orderBy(asc(schema.webhookDeliveries.createdAt), asc(schema.webhookDeliveries.attempt));
const subStatus = async (id: string) =>
  (await env.t.db.select().from(schema.eventSubscriptions).where(eq(schema.eventSubscriptions.id, id)))[0];

function followPayload(broadcaster: { id: string; username: string; name: string }, follower: { id: string }) {
  return {
    ...broadcasterFields(broadcaster),
    user_id: follower.id,
    user_login: "fan",
    user_name: "Fan",
    followed_at: new Date().toISOString(),
  };
}

describe("outbox relay", () => {
  test("publishes a validated BusEvent quickly and marks the row published", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const started = Date.now();
    const e = await insertEvent(env.t.db, "stream.offline", channel.id, { ...broadcasterFields(user), junk: 1 });
    const msg = await waitFor(async () => busMessages.find((m) => m.id === e.id), { label: "bus event" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(msg).toMatchObject({ type: "stream.offline", version: "1", channelId: channel.id });
    expect(msg.payload).toEqual(broadcasterFields(user));
    const [row] = await env.t.db.select().from(schema.events).where(eq(schema.events.id, e.id));
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });

  test("invalid rows are marked published without being published", async () => {
    const bad = await insertEvent(env.t.db, "stream.offline", null, { broadcaster_user_id: 42 });
    const unknown = await insertEvent(env.t.db, "no.such.event", null, {});
    await waitFor(async () => {
      const rows = await env.t.db.select().from(schema.events).where(eq(schema.events.id, unknown.id));
      return rows[0]?.publishedAt;
    });
    const [badRow] = await env.t.db.select().from(schema.events).where(eq(schema.events.id, bad.id));
    expect(badRow?.publishedAt).toBeInstanceOf(Date);
    expect(busMessages.some((m) => m.id === bad.id || m.id === unknown.id)).toBe(false);
  });
});

describe("webhook delivery", () => {
  test("signed notification reaches matching subscriptions only, logged as succeeded", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const other = await makeUser(env.t.db);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "channel.follow",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/follow"),
      secret: SECRET,
    });
    const otherSub = await makeSubscription(env.t.db, {
      userId: other.user.id,
      type: "channel.follow",
      condition: { broadcaster_user_id: other.user.id },
      callbackUrl: receiver.url("/follow-other"),
      secret: SECRET,
    });
    const e = await insertEvent(env.t.db, "channel.follow", channel.id, followPayload(user, other.user));

    const got = await waitFor(
      async () => receiver.on("/follow").find((r) => (r.body.event as { user_id?: string })?.user_id === other.user.id),
      {
        label: "notification",
      },
    );
    expect(got.signatureValid).toBe(true);
    expect(got.headers[WEBHOOK_HEADERS.messageType]).toBe("notification");
    expect(got.headers[WEBHOOK_HEADERS.messageRetry]).toBe("0");
    expect(got.headers[WEBHOOK_HEADERS.subscriptionType]).toBe("channel.follow");
    expect(got.body.subscription).toMatchObject({
      id: sub.id,
      type: "channel.follow",
      status: "enabled",
      condition: { broadcaster_user_id: user.id },
      transport: { method: "webhook", callback: receiver.url("/follow") },
    });
    expect(got.body.event).toMatchObject({ broadcaster_user_id: user.id, user_id: other.user.id });

    const rows = await waitFor(async () => {
      const r = await deliveriesOf(sub.id);
      return r.length > 0 && r;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: e.id,
      messageId: got.headers[WEBHOOK_HEADERS.messageId],
      status: "succeeded",
      responseStatus: 200,
      responseBody: "ok",
      attempt: 1,
      nextAttemptAt: null,
    });
    expect(rows[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(receiver.on("/follow-other")).toHaveLength(0);
    expect(await deliveriesOf(otherSub.id)).toHaveLength(0);
  });

  test("retries after 500s with a stable message id; every attempt is logged", async () => {
    const { user, channel } = await makeUser(env.t.db);
    failuresLeft.set("/flaky-1", 2);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "stream.offline",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/flaky-1"),
      secret: SECRET,
    });
    // A prior failure streak is reset by a success.
    await env.t.db
      .update(schema.eventSubscriptions)
      .set({ failureCount: 2 })
      .where(eq(schema.eventSubscriptions.id, sub.id));
    await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user));

    const rows = await waitFor(
      async () => {
        const r = await deliveriesOf(sub.id);
        return r.some((d) => d.status === "succeeded") && r;
      },
      { label: "successful retry" },
    );
    expect(rows.map((r) => [r.attempt, r.status, r.responseStatus])).toEqual([
      [1, "failed", 500],
      [2, "failed", 500],
      [3, "succeeded", 200],
    ]);
    expect(new Set(rows.map((r) => r.messageId)).size).toBe(1);
    expect(rows[0]?.nextAttemptAt).toBeInstanceOf(Date);
    expect(rows[0]?.error).toBe("HTTP 500");
    expect(rows[2]?.nextAttemptAt).toBeNull();
    const hits = receiver.on("/flaky-1");
    expect(hits.map((h) => h.headers[WEBHOOK_HEADERS.messageRetry])).toEqual(["0", "1", "2"]);
    expect(hits.every((h) => h.signatureValid)).toBe(true);
    expect((await subStatus(sub.id))?.failureCount).toBe(0);
  });

  test("consecutive exhausted events fail the subscription and send a revocation", async () => {
    const { user, channel } = await makeUser(env.t.db);
    env.worker.ctx.webhooks.maxAttempts = 2;
    env.worker.ctx.webhooks.failureThreshold = 2;
    try {
      const sub = await makeSubscription(env.t.db, {
        userId: user.id,
        type: "stream.offline",
        condition: { broadcaster_user_id: user.id },
        callbackUrl: receiver.url("/down-1"),
        secret: SECRET,
      });
      await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user));
      await waitFor(async () => (await subStatus(sub.id))?.failureCount === 1, { label: "first exhaustion" });
      expect((await subStatus(sub.id))?.status).toBe("enabled");
      await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user));
      await waitFor(async () => (await subStatus(sub.id))?.status === "failed", { label: "failed status" });
      const revocation = await waitFor(async () =>
        receiver.on("/down-1").find((r) => r.headers[WEBHOOK_HEADERS.messageType] === "revocation"),
      );
      expect(revocation.signatureValid).toBe(true);
      expect(revocation.body.subscription).toMatchObject({ id: sub.id, status: "notification_failures_exceeded" });
      const rows = await deliveriesOf(sub.id);
      expect(rows.filter((r) => r.messageType === "notification")).toHaveLength(4);
      // No further deliveries once failed.
      await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user));
      await Bun.sleep(400);
      expect((await deliveriesOf(sub.id)).filter((r) => r.messageType === "notification")).toHaveLength(4);
    } finally {
      env.worker.ctx.webhooks.maxAttempts = 5;
      env.worker.ctx.webhooks.failureThreshold = 3;
    }
  });

  test("a subscription whose app token was revoked is revoked instead of delivered", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const app = await makeApp(env.t.db, user.id);
    const token = await makeToken(env.t.db, app.id, user.id, ["channel:read:subscriptions"]);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      appId: app.id,
      type: "channel.subscribe",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/subs"),
      secret: SECRET,
    });
    const payload = {
      ...broadcasterFields(user),
      user_id: user.id,
      user_login: "x",
      user_name: "X",
      tier: "1000",
      is_gift: false,
    };
    await insertEvent(env.t.db, "channel.subscribe", channel.id, payload);
    await waitFor(async () =>
      receiver.on("/subs").find((r) => r.headers[WEBHOOK_HEADERS.messageType] === "notification"),
    );

    await env.t.db.update(schema.oauthTokens).set({ revokedAt: new Date() }).where(eq(schema.oauthTokens.id, token.id));
    await insertEvent(env.t.db, "channel.subscribe", channel.id, payload);
    await waitFor(async () => (await subStatus(sub.id))?.status === "revoked", { label: "revoked" });
    const revocation = await waitFor(async () =>
      receiver.on("/subs").find((r) => r.headers[WEBHOOK_HEADERS.messageType] === "revocation"),
    );
    expect(revocation.body.subscription).toMatchObject({ id: sub.id, status: "authorization_revoked" });
    expect(receiver.on("/subs").filter((r) => r.headers[WEBHOOK_HEADERS.messageType] === "notification")).toHaveLength(
      1,
    );
  });

  test("a token without the required scope does not authorize", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const app = await makeApp(env.t.db, user.id);
    await makeToken(env.t.db, app.id, user.id, ["chat:read"]);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      appId: app.id,
      type: "channel.subscribe",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/subs-noscope"),
      secret: SECRET,
    });
    await insertEvent(env.t.db, "channel.subscribe", channel.id, {
      ...broadcasterFields(user),
      user_id: user.id,
      user_login: "x",
      user_name: "X",
      tier: "1000",
      is_gift: false,
    });
    await waitFor(async () => (await subStatus(sub.id))?.status === "revoked", { label: "revoked" });
    expect(receiver.on("/subs-noscope").map((r) => r.headers[WEBHOOK_HEADERS.messageType])).toEqual(["revocation"]);
  });
});

describe("callback verification", () => {
  test("an echoed challenge enables the subscription", async () => {
    const { user } = await makeUser(env.t.db);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "stream.online",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/echo"),
      secret: SECRET,
      status: "verification_pending",
    });
    await env.worker.ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.verifyCallback, { subscriptionId: sub.id });
    await waitFor(async () => (await subStatus(sub.id))?.status === "enabled", { label: "enabled" });
    const hit = receiver.on("/echo").at(-1);
    expect(hit?.headers[WEBHOOK_HEADERS.messageType]).toBe("webhook_callback_verification");
    expect(hit?.signatureValid).toBe(true);
    expect(typeof hit?.body.challenge).toBe("string");
    expect(hit?.body.subscription).toMatchObject({ status: "webhook_callback_verification_pending" });
    const rows = await deliveriesOf(sub.id);
    expect(rows[0]).toMatchObject({ messageType: "webhook_callback_verification", status: "succeeded" });
  });

  test("a wrong echo or an unreachable or private callback fails it", async () => {
    const { user } = await makeUser(env.t.db);
    const wrong = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "stream.online",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/wrong-echo"),
      secret: SECRET,
      status: "verification_pending",
    });
    const dead = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "stream.offline",
      condition: { broadcaster_user_id: user.id },
      callbackUrl: "http://127.0.0.1:1/cb",
      secret: SECRET,
      status: "verification_pending",
    });
    await env.worker.ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.verifyCallback, { subscriptionId: wrong.id });
    await env.worker.ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.verifyCallback, { subscriptionId: dead.id });
    await waitFor(async () => (await subStatus(wrong.id))?.status === "failed", { label: "wrong failed" });
    await waitFor(async () => (await subStatus(dead.id))?.status === "failed", { label: "dead failed" });
    expect((await deliveriesOf(wrong.id))[0]).toMatchObject({ status: "failed", error: "challenge not echoed" });
    expect((await deliveriesOf(dead.id))[0]?.status).toBe("failed");

    // With insecure callbacks off, a loopback callback is refused before any connection.
    env.worker.ctx.webhooks.allowInsecure = false;
    try {
      const priv = await makeSubscription(env.t.db, {
        userId: user.id,
        type: "channel.update",
        condition: { broadcaster_user_id: user.id },
        callbackUrl: receiver.url("/echo"),
        secret: SECRET,
        status: "verification_pending",
      });
      const before = receiver.on("/echo").length;
      await env.worker.ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.verifyCallback, { subscriptionId: priv.id });
      await waitFor(async () => (await subStatus(priv.id))?.status === "failed", { label: "private failed" });
      expect(receiver.on("/echo").length).toBe(before);
      expect((await deliveriesOf(priv.id))[0]?.error).toContain("scheme must be https");
    } finally {
      env.worker.ctx.webhooks.allowInsecure = true;
    }
  });
});

describe("test events and redelivery", () => {
  test("a test event is a catalog-valid notification delivered once", async () => {
    const { user } = await makeUser(env.t.db);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "channel.raid",
      condition: { to_broadcaster_user_id: user.id },
      callbackUrl: receiver.url("/test-event"),
      secret: SECRET,
    });
    const eventId = crypto.randomUUID();
    await env.worker.ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.testEvent, { subscriptionId: sub.id, eventId });
    const hit = await waitFor(async () => receiver.on("/test-event")[0]);
    expect(hit.signatureValid).toBe(true);
    expect(hit.body.event).toMatchObject({ to_broadcaster_user_id: user.id, viewers: 1 });
    const rows = await waitFor(async () => {
      const r = await deliveriesOf(sub.id);
      return r.length > 0 && r;
    });
    expect(rows[0]).toMatchObject({ eventId, status: "succeeded" });
  });

  test("redelivery re-sends a failed notification with the same message id", async () => {
    const { user, channel } = await makeUser(env.t.db);
    env.worker.ctx.webhooks.maxAttempts = 1;
    failuresLeft.set("/flaky-redeliver", 1);
    let sub;
    try {
      sub = await makeSubscription(env.t.db, {
        userId: user.id,
        type: "stream.offline",
        condition: { broadcaster_user_id: user.id },
        callbackUrl: receiver.url("/flaky-redeliver"),
        secret: SECRET,
      });
      await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user));
      await waitFor(async () => (await subStatus(sub!.id))?.failureCount === 1, { label: "exhausted" });
    } finally {
      env.worker.ctx.webhooks.maxAttempts = 5;
    }
    const [failed] = await deliveriesOf(sub.id);
    expect(failed?.status).toBe("failed");
    await env.worker.ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.redeliver, { deliveryId: failed!.id });
    const rows = await waitFor(
      async () => {
        const r = await deliveriesOf(sub.id);
        return r.length === 2 && r;
      },
      { label: "redelivery" },
    );
    expect(rows[1]).toMatchObject({ status: "succeeded", attempt: 2, messageId: failed!.messageId });
    const hits = receiver.on("/flaky-redeliver");
    expect(hits[1]?.headers[WEBHOOK_HEADERS.messageId]).toBe(failed!.messageId);
    expect(hits[1]?.signatureValid).toBe(true);
  });
});
