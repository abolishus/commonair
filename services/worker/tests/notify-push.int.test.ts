// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `push` job against a local Bun receiver (ADR 0028 decisions 1 and 6): what reaches the push
 * service, how its answers change the stored subscription, and the payload's mature rule.
 */
import { NOTIFY_SECRET_PURPOSES, type PushPayload } from "@commonair/contracts/notify";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { b64url, encryptSecret, fromB64url } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { job as pushJobDef } from "../src/jobs/notify-push.ts";
import { decryptPushPayload } from "../src/notify/push/ece.ts";
import { PushRetry, runPushJob, VapidKeyUnusable } from "../src/notify/push/job.ts";
import { PUSH_FAILURE_LIMIT, pushTopic } from "../src/notify/push/send.ts";
import type { WebPushSettings } from "../src/notify/settings.ts";
import { AUTH_SECRET, makeBroadcast, makeUser } from "./fixtures.ts";

const { pushSubscriptions: subs } = schema;

interface Received {
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
const received: Received[] = [];
const statuses = new Map<string, number>();
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    received.push({
      path,
      headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
      body: new Uint8Array(await req.arrayBuffer()),
    });
    return new Response(null, { status: statuses.get(path) ?? 201 });
  },
});
const origin = `http://127.0.0.1:${receiver.port}`;

const logLines: string[] = [];
const logger = createLogger({ service: "worker-test-push", level: "debug", write: (l) => logLines.push(l) });

let t: TestDatabase;
let owner: Database;
let webPush: WebPushSettings;
let ctx: WorkerContext;

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  webPush = {
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64"),
    subject: "mailto:hello@example.test",
    allowInsecure: true,
  };
  ctx = {
    db: t.app.db,
    logger,
    now: () => new Date(),
    webPush,
    webhooks: { authSecret: AUTH_SECRET },
  } as unknown as WorkerContext;
}, 180_000);
afterAll(async () => {
  await receiver.stop(true);
  await t?.drop();
});

/** A browser's subscription: its ECDH pair and auth secret, stored as the API stores it. */
async function subscribe(userId: string, id: string, createdAt = new Date()) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const endpoint = `${origin}/push/${id}`;
  const subscription = await encryptSecret(
    AUTH_SECRET,
    NOTIFY_SECRET_PURPOSES.pushSubscription,
    JSON.stringify({ endpoint, p256dh: b64url(uaPublic), auth: b64url(authSecret) }),
  );
  const [row] = await owner
    .insert(subs)
    .values({ userId, endpointHash: `hash-${id}`, subscription, createdAt })
    .returning();
  return { row: row!, endpoint, path: `/push/${id}`, pair, uaPublic, authSecret };
}

async function decrypt(body: Uint8Array, s: Awaited<ReturnType<typeof subscribe>>): Promise<PushPayload> {
  const plain = await decryptPushPayload({
    message: body,
    uaPrivateKey: s.pair.privateKey,
    uaPublic: s.uaPublic,
    authSecret: s.authSecret,
  });
  return JSON.parse(new TextDecoder().decode(plain)) as PushPayload;
}

/** A streamer live with `title`, a follower, and the job data for that go-live. */
async function scene(opts: { title?: string; broadcastMature?: boolean; channelMature?: boolean } = {}) {
  const streamer = await makeUser(owner);
  const follower = await makeUser(owner);
  if (opts.channelMature)
    await owner.update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, streamer.channel.id));
  const b = await makeBroadcast(owner, streamer.channel.id);
  await owner
    .update(schema.broadcasts)
    .set({ title: opts.title ?? "Late night synths", mature: opts.broadcastMature ?? false })
    .where(eq(schema.broadcasts.id, b.id));
  return {
    streamer,
    follower,
    data: { eventId: uuidv7(), userId: follower.user.id, channelId: streamer.channel.id, broadcastId: b.id },
  };
}

const rowOf = async (id: string) => (await owner.select().from(subs).where(eq(subs.id, id)))[0];
const requestsTo = (path: string) => received.filter((r) => r.path === path);
const tag = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

describe("notify-push job", () => {
  test("is registered with the contract's queue, attempts and backoff", () => {
    expect(pushJobDef.queue).toBe("notifications");
    expect(pushJobDef.name).toBe("push");
    expect(pushJobDef.attempts).toBe(4);
    expect(pushJobDef.backoffMs).toBe(30_000);
  });

  test("one subscription → one POST with the RFC 8030 headers, whose body decrypts to the in-app payload", async () => {
    const { streamer, follower, data } = await scene();
    // The in-app row wins over the broadcast: push and the bell say the same thing.
    await owner.insert(schema.notifications).values({
      userId: follower.user.id,
      type: "go_live",
      dedupeKey: `go-live-${data.eventId}`,
      payload: {
        channelId: data.channelId,
        slug: streamer.channel.slug,
        broadcastId: data.broadcastId,
        title: "From the bell",
      },
    });
    const s = await subscribe(follower.user.id, tag());
    logLines.length = 0;

    const result = await pushJobDef.handler(data, ctx, { id: undefined, attemptsMade: 0 });
    expect(result).toEqual({ sent: 1, removed: 0 });

    const [req] = requestsTo(s.path);
    expect(requestsTo(s.path)).toHaveLength(1);
    expect(req!.headers["content-encoding"]).toBe("aes128gcm");
    expect(req!.headers["content-type"]).toBe("application/octet-stream");
    expect(req!.headers.ttl).toBe("3600");
    expect(req!.headers.urgency).toBe("normal");
    expect(req!.headers.topic).toBe(await pushTopic(data.channelId));
    expect(req!.headers["user-agent"]).toBe("CommonAir-Push/1");
    expect(req!.headers.authorization).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${webPush.publicKey}$`),
    );
    const claims = JSON.parse(
      new TextDecoder().decode(fromB64url(req!.headers.authorization!.split(" ")[1]!.slice(2).split(".")[1]!)),
    ) as { aud: string; sub: string };
    expect(claims.aud).toBe(origin);
    expect(claims.sub).toBe(webPush.subject);
    expect(await decrypt(req!.body, s)).toEqual({
      v: 1,
      type: "go_live",
      slug: streamer.channel.slug,
      title: "From the bell",
    });

    const row = await rowOf(s.row.id);
    expect(row?.lastSuccessAt).toBeInstanceOf(Date);
    expect(row?.failures).toBe(0);
    // Endpoints and keys are never logged.
    const logs = logLines.join("\n");
    expect(logs).not.toContain(s.endpoint);
    expect(logs).not.toContain(b64url(s.authSecret));
  });

  test("410 deletes the subscription", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    statuses.set(s.path, 410);
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 1 });
    expect(requestsTo(s.path)).toHaveLength(1);
    expect(await rowOf(s.row.id)).toBeUndefined();
  });

  test("404 deletes the subscription too", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    statuses.set(s.path, 404);
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 1 });
    expect(await rowOf(s.row.id)).toBeUndefined();
  });

  test("429 on one browser: the others are still sent, then the job throws for a retry", async () => {
    const { follower, data } = await scene();
    const busy = await subscribe(follower.user.id, tag(), new Date(Date.now() - 2_000));
    const ok = await subscribe(follower.user.id, tag(), new Date(Date.now() - 1_000));
    const down = await subscribe(follower.user.id, tag(), new Date(Date.now() - 3_000));
    statuses.set(busy.path, 429);
    statuses.set(down.path, 503);

    await expect(runPushJob(ctx, data)).rejects.toBeInstanceOf(PushRetry);
    expect(requestsTo(busy.path)).toHaveLength(1);
    expect(requestsTo(ok.path)).toHaveLength(1);
    expect(requestsTo(down.path)).toHaveLength(1);
    expect((await rowOf(ok.row.id))?.lastSuccessAt).toBeInstanceOf(Date);
    // Retryable answers keep the row as it was.
    expect(await rowOf(busy.row.id)).toMatchObject({ failures: 0, lastSuccessAt: null });
  });

  test(`403 counts failures and deletes at ${PUSH_FAILURE_LIMIT} in a row; a success resets the count`, async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    statuses.set(s.path, 403);
    for (let i = 1; i < PUSH_FAILURE_LIMIT; i++) {
      expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 0 });
      expect((await rowOf(s.row.id))?.failures).toBe(i);
    }
    statuses.set(s.path, 201);
    expect(await runPushJob(ctx, data)).toEqual({ sent: 1, removed: 0 });
    expect((await rowOf(s.row.id))?.failures).toBe(0);

    statuses.set(s.path, 401);
    for (let i = 1; i < PUSH_FAILURE_LIMIT; i++) await runPushJob(ctx, data);
    expect((await rowOf(s.row.id))?.failures).toBe(PUSH_FAILURE_LIMIT - 1);
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 1 });
    expect(await rowOf(s.row.id)).toBeUndefined();
  });

  test("413 is logged as an error and neither retried nor deleted", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    statuses.set(s.path, 413);
    logLines.length = 0;
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 0 });
    expect(await rowOf(s.row.id)).toMatchObject({ failures: 0 });
    expect(logLines.some((l) => l.includes('"level":"error"') && l.includes("413"))).toBe(true);
  });

  test("an endpoint the address guard refuses is deleted", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    const strict = { ...ctx, webPush: { ...webPush, allowInsecure: false } } as WorkerContext;
    expect(await runPushJob(strict, data)).toEqual({ sent: 0, removed: 1 });
    expect(requestsTo(s.path)).toHaveLength(0);
    expect(await rowOf(s.row.id)).toBeUndefined();
  });

  test("a row this worker cannot decrypt (AUTH_SECRET differs from the API's) is kept, with no POST", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    const other = { ...ctx, webhooks: { authSecret: "another-secret-0123456789-abcdefghijklmnop" } } as WorkerContext;
    logLines.length = 0;
    expect(await runPushJob(other, data)).toEqual({ sent: 0, removed: 0 });
    expect(requestsTo(s.path)).toHaveLength(0);
    expect(await rowOf(s.row.id)).toMatchObject({ failures: 0 });
    expect(logLines.some((l) => l.includes('"level":"error"'))).toBe(true);
  });

  test("a row that decrypts to something other than a subscription is deleted", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    const junk = await encryptSecret(AUTH_SECRET, NOTIFY_SECRET_PURPOSES.pushSubscription, '{"endpoint":1}');
    await owner.update(subs).set({ subscription: junk }).where(eq(subs.id, s.row.id));
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 1 });
    expect(await rowOf(s.row.id)).toBeUndefined();
  });

  test("stored keys of the wrong shape delete the row without a POST", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    const bad = await encryptSecret(
      AUTH_SECRET,
      NOTIFY_SECRET_PURPOSES.pushSubscription,
      JSON.stringify({ endpoint: s.endpoint, p256dh: b64url(s.uaPublic), auth: b64url(new Uint8Array(8)) }),
    );
    await owner.update(subs).set({ subscription: bad }).where(eq(subs.id, s.row.id));
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 1 });
    expect(requestsTo(s.path)).toHaveLength(0);
    expect(await rowOf(s.row.id)).toBeUndefined();
  });

  test("a VAPID_PRIVATE_KEY that does not import throws before any send and keeps every row", async () => {
    const { follower, data } = await scene();
    const a = await subscribe(follower.user.id, tag());
    const b = await subscribe(follower.user.id, tag());
    for (const privateKeyPkcs8 of [
      "bm90IGEga2V5IGF0IGFsbCwganVzdCB0ZXh0IGJ5dGVz",
      webPush.privateKeyPkcs8.slice(0, 40),
    ]) {
      const broken = { ...ctx, webPush: { ...webPush, privateKeyPkcs8 } } as WorkerContext;
      logLines.length = 0;
      await expect(runPushJob(broken, data)).rejects.toBeInstanceOf(VapidKeyUnusable);
      expect(logLines.some((l) => l.includes('"level":"error"') && l.includes("VAPID_PRIVATE_KEY"))).toBe(true);
    }
    expect(requestsTo(a.path)).toHaveLength(0);
    expect(requestsTo(b.path)).toHaveLength(0);
    expect(await rowOf(a.row.id)).toBeDefined();
    expect(await rowOf(b.row.id)).toBeDefined();
  });

  test("a retry attempt does not count a 403 again", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    statuses.set(s.path, 403);
    expect(await runPushJob(ctx, data, { attemptsMade: 0 })).toEqual({ sent: 0, removed: 0 });
    for (let attempt = 1; attempt < 4; attempt++) await runPushJob(ctx, data, { attemptsMade: attempt });
    expect(requestsTo(s.path)).toHaveLength(4);
    expect((await rowOf(s.row.id))?.failures).toBe(1);
  });

  test("push off after the enqueue → zeros and nothing sent", async () => {
    const { follower, data } = await scene();
    const s = await subscribe(follower.user.id, tag());
    const off = { ...ctx } as Partial<WorkerContext>;
    delete off.webPush;
    expect(await runPushJob(off as WorkerContext, data)).toEqual({ sent: 0, removed: 0 });
    expect(requestsTo(s.path)).toHaveLength(0);
  });

  test("no subscriptions, or a broadcast that is gone → zeros", async () => {
    const { follower, data } = await scene();
    expect(await runPushJob(ctx, data)).toEqual({ sent: 0, removed: 0 });
    const s = await subscribe(follower.user.id, tag());
    expect(await runPushJob(ctx, { ...data, broadcastId: uuidv7() })).toEqual({ sent: 0, removed: 0 });
    expect(requestsTo(s.path)).toHaveLength(0);
  });

  test("without an in-app row: built from the broadcast, and a mature one hides the title from an unconfirmed member", async () => {
    // Broadcast mature.
    const a = await scene({ title: "Spicy", broadcastMature: true });
    const sa = await subscribe(a.follower.user.id, tag());
    await runPushJob(ctx, a.data);
    expect(await decrypt(requestsTo(sa.path)[0]!.body, sa)).toEqual({
      v: 1,
      type: "go_live",
      slug: a.streamer.channel.slug,
      title: "",
    });

    // Channel labelled mature after the broadcast started.
    const b = await scene({ title: "Spicy too", channelMature: true });
    const sb = await subscribe(b.follower.user.id, tag());
    await runPushJob(ctx, b.data);
    expect((await decrypt(requestsTo(sb.path)[0]!.body, sb)).title).toBe("");

    // A member who confirmed 18+ sees it.
    const c = await scene({ title: "Spicy three", broadcastMature: true });
    await owner
      .update(schema.users)
      .set({ matureConfirmedAt: new Date() })
      .where(eq(schema.users.id, c.follower.user.id));
    const sc = await subscribe(c.follower.user.id, tag());
    await runPushJob(ctx, c.data);
    expect((await decrypt(requestsTo(sc.path)[0]!.body, sc)).title).toBe("Spicy three");

    // Not mature: the title.
    const d = await scene({ title: "Morning coffee" });
    const sd = await subscribe(d.follower.user.id, tag());
    await runPushJob(ctx, d.data);
    expect((await decrypt(requestsTo(sd.path)[0]!.body, sd)).title).toBe("Morning coffee");
  });
});
