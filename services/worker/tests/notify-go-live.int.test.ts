// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The go-live fan-out (ADR 0028 decisions 3, 4 and 8) against real Postgres and Valkey: media per
 * follower, the cooldown across events and connections, idempotent retries, paging and the jobs it
 * enqueues. The code's clock is pinned (`ctx.now`); nothing compares it with Postgres's.
 */
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { GoLiveNotificationPayload, NOTIFY_RULES } from "@commonair/contracts/notify";
import { schema, uuidv7, type Database } from "@commonair/db";
import { and, eq, sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import type { EnqueueOptions, WorkerContext } from "../src/context.ts";
import { job as goLiveJob } from "../src/jobs/notify-go-live.ts";
import { fanOutGoLive, pageQuery } from "../src/notify/fanout/go-live.ts";
import { clearGoLiveSettingCache, DEFAULT_GO_LIVE_SETTING } from "../src/notify/settings.ts";
import { createWorker } from "../src/worker.ts";
import {
  broadcasterFields,
  fastWebhooks,
  insertEvent,
  makeBroadcast,
  makeUser,
  quietLogger,
  setup,
  VALKEY_URL,
  waitFor,
  type TestEnv,
} from "./fixtures.ts";

/** Code-point order, as Postgres orders uuids. */
const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const START = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;
let clock = START;
let env: TestEnv;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, now: () => clock });
});
afterAll(() => env.close());
beforeEach(() => {
  clock = START;
  clearGoLiveSettingCache();
});

const db = (): Database => env.t.db;

interface Enqueued {
  queue: string;
  name: string;
  data: unknown;
  opts?: EnqueueOptions;
}

/** The worker's context with enqueues recorded instead of sent (the database and Valkey stay real). */
function recording(over: Partial<WorkerContext> = {}): { ctx: WorkerContext; jobs: Enqueued[] } {
  const jobs: Enqueued[] = [];
  const ctx: WorkerContext = {
    ...env.worker.ctx,
    enqueue: async (queue, name, data, opts) => {
      jobs.push({ queue, name, data, opts });
    },
    enqueueBulk: async (queue, list) => {
      for (const j of list) jobs.push({ queue, name: j.name, data: j.data, opts: j.opts });
    },
    ...over,
  };
  return { ctx, jobs };
}

const WEB_PUSH = { publicKey: "k", privateKeyPkcs8: "p", subject: "mailto:ops@example.test", allowInsecure: true };

let seq = 0;
/** Users that follow `channelId` (one insert each for users and follows). */
async function followers(
  channelId: string,
  n: number,
  over: { notify?: boolean; excluded?: boolean; user?: Partial<typeof schema.users.$inferInsert> } = {},
): Promise<string[]> {
  const rows = Array.from({ length: n }, () => {
    const name = `f${++seq}x${Math.random().toString(36).slice(2, 8)}`;
    return { id: uuidv7(), name, email: `${name}@example.test`, username: name, ...over.user };
  });
  for (let i = 0; i < rows.length; i += 1000)
    await db()
      .insert(schema.users)
      .values(rows.slice(i, i + 1000));
  const follows = rows.map((r) => ({
    followerId: r.id,
    channelId,
    notify: over.notify ?? true,
    excludedAt: over.excluded ? START : null,
  }));
  for (let i = 0; i < follows.length; i += 1000)
    await db()
      .insert(schema.follows)
      .values(follows.slice(i, i + 1000));
  return rows.map((r) => r.id).sort(asc);
}

async function streamer(over: { title?: string; mature?: boolean; channelMature?: boolean } = {}) {
  const s = await makeUser(db());
  if (over.channelMature)
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, s.channel.id));
  return s;
}

/** A broadcast and its `stream.online` row, as the media hook writes them. */
async function goLive(s: Awaited<ReturnType<typeof streamer>>, over: { title?: string; mature?: boolean } = {}) {
  const b = await makeBroadcast(db(), s.channel.id);
  if (over.title !== undefined || over.mature !== undefined)
    await db()
      .update(schema.broadcasts)
      .set({ title: over.title ?? "", mature: over.mature ?? false })
      .where(eq(schema.broadcasts.id, b.id));
  const e = await insertEvent(db(), "stream.online", s.channel.id, {
    ...broadcasterFields(s.user),
    id: b.id,
    type: "live",
    started_at: START.toISOString(),
  });
  return { eventId: e.id, broadcastId: b.id };
}

async function pref(
  userId: string,
  medium: "in_app" | "email" | "push",
  enabled: boolean,
  channelId: string | null = null,
) {
  await db().insert(schema.notificationPreferences).values({ userId, type: "go_live", medium, channelId, enabled });
}

async function pushSubscription(userId: string) {
  await db()
    .insert(schema.pushSubscriptions)
    .values({ userId, endpointHash: `hash-${uuidv7()}`, subscription: "ciphertext" });
}

const rowsFor = (channelId: string) =>
  db()
    .select()
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.type, "go_live"), sql`${schema.notifications.payload}->>'channelId' = ${channelId}`),
    );
const queueFor = (channelId: string) =>
  db().select().from(schema.notificationEmailQueue).where(eq(schema.notificationEmailQueue.channelId, channelId));
const sendsFor = (channelId: string) =>
  db().select().from(schema.notificationGoLiveSends).where(eq(schema.notificationGoLiveSends.channelId, channelId));

describe("go-live fan-out: media", () => {
  test("a follower with defaults gets one in-app row and no email or push", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1);
    const ev = await goLive(s, { title: "Speedrun" });
    const { ctx, jobs } = recording({ webPush: WEB_PUSH });
    await pushSubscription(f!);
    const r = await fanOutGoLive(ctx, { eventId: ev.eventId, after: null });
    expect(r).toEqual({ followers: 1, inApp: 1, email: 0, push: 0, cooledDown: 0, nextPage: false });
    const rows = await rowsFor(s.channel.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(f);
    expect(rows[0]?.dedupeKey).toBe(`go-live-${ev.eventId}`);
    expect(rows[0]?.readAt).toBeNull();
    expect(GoLiveNotificationPayload.parse(rows[0]?.payload)).toEqual({
      channelId: s.channel.id,
      slug: s.channel.slug,
      broadcastId: ev.broadcastId,
      title: "Speedrun",
    });
    expect(await queueFor(s.channel.id)).toHaveLength(0);
    expect(jobs).toEqual([]);
  });

  test("email on + verified → one queue row; unverified → none (in-app still)", async () => {
    const s = await streamer();
    const [verified] = await followers(s.channel.id, 1, { user: { emailVerified: true } });
    const [unverified] = await followers(s.channel.id, 1);
    await pref(verified!, "email", true);
    await pref(unverified!, "email", true);
    const ev = await goLive(s);
    const r = await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null });
    expect(r).toMatchObject({ followers: 2, inApp: 2, email: 1, push: 0 });
    const q = await queueFor(s.channel.id);
    expect(q.map((x) => ({ userId: x.userId, eventId: x.eventId, broadcastId: x.broadcastId }))).toEqual([
      { userId: verified, eventId: ev.eventId, broadcastId: ev.broadcastId },
    ]);
    expect((await rowsFor(s.channel.id)).map((x) => x.userId).sort(asc)).toEqual([verified!, unverified!].sort(asc));
  });

  test("email only (in-app off): a queue row and no in-app row", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1, { user: { emailVerified: true } });
    await pref(f!, "in_app", false);
    await pref(f!, "email", true, s.channel.id);
    const ev = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      inApp: 0,
      email: 1,
    });
    expect(await rowsFor(s.channel.id)).toHaveLength(0);
  });

  test("push on + a subscription + push enabled → one push job; push off on the instance → none", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1);
    await pref(f!, "push", true);
    await pushSubscription(f!);
    const ev = await goLive(s);
    const off = recording();
    expect(await fanOutGoLive(off.ctx, { eventId: ev.eventId, after: null })).toMatchObject({ push: 0, inApp: 1 });
    expect(off.jobs).toEqual([]);
    // A retry with push on passes the cooldown again (same event) and now enqueues the push job.
    const on = recording({ webPush: WEB_PUSH });
    expect(await fanOutGoLive(on.ctx, { eventId: ev.eventId, after: null })).toMatchObject({ push: 1, inApp: 0 });
    expect(on.jobs).toEqual([
      {
        queue: QUEUES.notifications,
        name: NOTIFY_JOBS.push,
        data: { eventId: ev.eventId, userId: f, channelId: s.channel.id, broadcastId: ev.broadcastId },
        opts: { jobId: `push-${ev.eventId}-${f}` },
      },
    ]);
  });

  test("push on without a subscription → no push job", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1);
    await pref(f!, "push", true);
    const ev = await goLive(s);
    const { ctx, jobs } = recording({ webPush: WEB_PUSH });
    expect(await fanOutGoLive(ctx, { eventId: ev.eventId, after: null })).toMatchObject({ push: 0, inApp: 1 });
    expect(jobs).toEqual([]);
  });

  test("an excluded follow → in-app only, whatever email and push say", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1, { excluded: true, user: { emailVerified: true } });
    await pref(f!, "email", true);
    await pref(f!, "push", true);
    await pushSubscription(f!);
    const ev = await goLive(s);
    const { ctx, jobs } = recording({ webPush: WEB_PUSH });
    expect(await fanOutGoLive(ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      inApp: 1,
      email: 0,
      push: 0,
    });
    expect(jobs).toEqual([]);
    expect(await queueFor(s.channel.id)).toHaveLength(0);
  });

  test("the bell off → nothing, and no cooldown row", async () => {
    const s = await streamer();
    await followers(s.channel.id, 1, { notify: false });
    const ev = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null })).toEqual({
      followers: 0,
      inApp: 0,
      email: 0,
      push: 0,
      cooledDown: 0,
      nextPage: false,
    });
    expect(await rowsFor(s.channel.id)).toHaveLength(0);
    expect(await sendsFor(s.channel.id)).toHaveLength(0);
  });

  test("no medium left (in-app off for this channel) → skipped and the cooldown is not consumed", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1);
    await pref(f!, "in_app", true);
    await pref(f!, "in_app", false, s.channel.id);
    const ev = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      followers: 1,
      inApp: 0,
      cooledDown: 0,
    });
    expect(await sendsFor(s.channel.id)).toHaveLength(0);
  });

  test("a demo follower gets no email row", async () => {
    const s = await streamer();
    const handle = `${DEMO_FIXTURES.usernamePrefix}fan${++seq}`;
    const [f] = await followers(s.channel.id, 1, {
      user: { username: handle, email: `${handle}@${DEMO_FIXTURES.emailDomain}`, emailVerified: true },
    });
    await pref(f!, "email", true);
    const ev = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      inApp: 1,
      email: 0,
    });
    expect(await queueFor(s.channel.id)).toHaveLength(0);
  });

  test("bots, the owner and deleted accounts are never notified", async () => {
    const s = await streamer();
    const [human] = await followers(s.channel.id, 1);
    await followers(s.channel.id, 1, { user: { accountType: "bot" } });
    await followers(s.channel.id, 1, { user: { deletedAt: START } });
    await followers(s.channel.id, 1, { user: { pseudonymizedAt: START } });
    await db().insert(schema.follows).values({ followerId: s.user.id, channelId: s.channel.id });
    const ev = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      followers: 1,
      inApp: 1,
    });
    expect((await rowsFor(s.channel.id)).map((r) => r.userId)).toEqual([human]);
  });

  test("mature: unconfirmed followers get no title; confirmed ones do; the channel flag counts too", async () => {
    for (const where of ["broadcast", "channel"] as const) {
      const s = await streamer({ channelMature: where === "channel" });
      const [unconfirmed] = await followers(s.channel.id, 1);
      const [confirmed] = await followers(s.channel.id, 1, { user: { matureConfirmedAt: START } });
      const ev = await goLive(s, { title: "After dark", mature: where === "broadcast" });
      await fanOutGoLive(recording().ctx, { eventId: ev.eventId, after: null });
      const byUser = new Map((await rowsFor(s.channel.id)).map((r) => [r.userId, r.payload]));
      expect(byUser.get(unconfirmed!)?.title, where).toBe("");
      expect(byUser.get(confirmed!)?.title, where).toBe("After dark");
    }
  });
});

describe("go-live fan-out: cooldown and idempotency", () => {
  test("a second event inside the window → nothing; after the window → sent", async () => {
    const s = await streamer();
    const [f] = await followers(s.channel.id, 1);
    const first = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: first.eventId, after: null })).toMatchObject({ inApp: 1 });

    clock = new Date(START.getTime() + (DEFAULT_GO_LIVE_SETTING.cooldownHours * HOUR) / 2);
    const second = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: second.eventId, after: null })).toMatchObject({
      followers: 1,
      inApp: 0,
      cooledDown: 1,
    });
    expect(await rowsFor(s.channel.id)).toHaveLength(1);

    // Exactly the cooldown after the last send passes (`<=`).
    clock = new Date(START.getTime() + DEFAULT_GO_LIVE_SETTING.cooldownHours * HOUR);
    const third = await goLive(s);
    expect(await fanOutGoLive(recording().ctx, { eventId: third.eventId, after: null })).toMatchObject({
      inApp: 1,
      cooledDown: 0,
    });
    expect(await rowsFor(s.channel.id)).toHaveLength(2);
    const [send] = await sendsFor(s.channel.id);
    expect(send).toMatchObject({ userId: f, eventId: third.eventId, lastSentAt: clock });
  });

  test("the cooldown is per channel: another channel's go-live is not held back", async () => {
    const a = await streamer();
    const b = await streamer();
    const [f] = await followers(a.channel.id, 1);
    await db().insert(schema.follows).values({ followerId: f!, channelId: b.channel.id });
    const ea = await goLive(a);
    const eb = await goLive(b);
    expect(await fanOutGoLive(recording().ctx, { eventId: ea.eventId, after: null })).toMatchObject({ inApp: 1 });
    expect(await fanOutGoLive(recording().ctx, { eventId: eb.eventId, after: null })).toMatchObject({ inApp: 1 });
  });

  test("the same event processed twice → one row and one queue row per member, push jobs with the same ids", async () => {
    const s = await streamer();
    const members = await followers(s.channel.id, 3, { user: { emailVerified: true } });
    for (const m of members) {
      await pref(m, "email", true);
      await pref(m, "push", true);
      await pushSubscription(m);
    }
    const ev = await goLive(s);
    const one = recording({ webPush: WEB_PUSH });
    const two = recording({ webPush: WEB_PUSH });
    expect(await fanOutGoLive(one.ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      inApp: 3,
      email: 3,
      push: 3,
    });
    clock = new Date(START.getTime() + 60_000);
    expect(await fanOutGoLive(two.ctx, { eventId: ev.eventId, after: null })).toMatchObject({
      followers: 3,
      inApp: 0,
      email: 0,
      push: 3,
      cooledDown: 0,
    });
    expect(await rowsFor(s.channel.id)).toHaveLength(3);
    expect(await queueFor(s.channel.id)).toHaveLength(3);
    const ids = (r: Enqueued[]) => r.map((j) => j.opts?.jobId ?? "").sort(asc);
    expect(ids(two.jobs)).toEqual(ids(one.jobs));
    expect(ids(one.jobs)).toEqual(members.map((m) => `push-${ev.eventId}-${m}`).sort(asc));
  });

  test("two concurrent jobs for two events of one channel (two connections) → each member passes once", async () => {
    const s = await streamer();
    const members = await followers(s.channel.id, 40);
    const a = await goLive(s);
    const b = await goLive(s);
    const ctxA = recording().ctx;
    // The least-privilege app role: a second pool, as a second replica would have.
    const ctxB = recording({ db: env.t.app.db, sql: env.t.app.sql }).ctx;
    const [ra, rb] = await Promise.all([
      fanOutGoLive(ctxA, { eventId: a.eventId, after: null }),
      fanOutGoLive(ctxB, { eventId: b.eventId, after: null }),
    ]);
    expect(ra.inApp + rb.inApp).toBe(members.length);
    expect(ra.cooledDown + rb.cooledDown).toBe(members.length);
    const rows = await rowsFor(s.channel.id);
    expect(rows.map((r) => r.userId).sort(asc)).toEqual(members);
  });
});

describe("go-live fan-out: pages, Discord, missing events", () => {
  test("1,203 followers → 3 pages, every member once", async () => {
    expect(NOTIFY_RULES.fanoutPageSize).toBe(500);
    const s = await streamer();
    const members = await followers(s.channel.id, 1_203);
    const ev = await goLive(s);
    const results = [];
    const nextJobs: (Enqueued | undefined)[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const { ctx, jobs } = recording();
      const r = await fanOutGoLive(ctx, { eventId: ev.eventId, after });
      results.push(r);
      const next = jobs.find((j) => j.name === NOTIFY_JOBS.goLive);
      nextJobs.push(next);
      if (!r.nextPage) break;
      after = (next?.data as { after: string } | undefined)?.after ?? null;
    }
    // The next-page jobs: after the last follower of each full page, none after the short one.
    expect(nextJobs.map((j) => j?.queue)).toEqual([QUEUES.notifications, QUEUES.notifications, undefined]);
    expect(nextJobs.map((j) => j?.opts?.jobId)).toEqual([
      `go-live-${ev.eventId}-${members[499]}`,
      `go-live-${ev.eventId}-${members[999]}`,
      undefined,
    ]);
    expect(results.map((r) => [r.followers, r.inApp, r.nextPage])).toEqual([
      [500, 500, true],
      [500, 500, true],
      [203, 203, false],
    ]);
    const rows = await rowsFor(s.channel.id);
    expect(rows.map((r) => r.userId).sort(asc)).toEqual(members);
  });

  test("through BullMQ: the first page's job pages through every follower", async () => {
    const s = await streamer();
    const members = await followers(s.channel.id, 1_203);
    const ev = await goLive(s);
    const tag = crypto.randomUUID();
    const w = createWorker({
      db: env.t,
      valkeyUrl: VALKEY_URL,
      logger: quietLogger,
      webhooks: fastWebhooks(),
      keyPrefix: `test:${tag}:`,
      bullPrefix: `test-bull-${tag}`,
      busChannel: `test:${tag}:bus:events`,
      segmentStream: `test:${tag}:stream:segments`,
      jobs: [goLiveJob],
      outbox: false,
      segments: false,
      now: () => clock,
    });
    await w.start();
    try {
      // As the outbox relay enqueues it (`notify/outbox-jobs.ts`).
      await w.ctx.enqueue(
        QUEUES.notifications,
        NOTIFY_JOBS.goLive,
        { eventId: ev.eventId, after: null },
        {
          jobId: `go-live-${ev.eventId}`,
        },
      );
      await waitFor(async () => (await rowsFor(s.channel.id)).length === members.length, {
        timeoutMs: 45_000,
        label: "every follower notified",
      });
    } finally {
      await w.stop(5_000);
    }
    expect((await rowsFor(s.channel.id)).map((r) => r.userId).sort(asc)).toEqual(members);
  });

  test("a Discord webhook → one DiscordJob on page one only", async () => {
    const s = await streamer();
    await followers(s.channel.id, 3);
    await db().insert(schema.discordWebhooks).values({ channelId: s.channel.id, url: "ciphertext" });
    const ev = await goLive(s);
    const p1 = recording();
    const r1 = await fanOutGoLive(p1.ctx, { eventId: ev.eventId, after: null }, { pageSize: 2 });
    expect(r1.nextPage).toBe(true);
    expect(p1.jobs.filter((j) => j.name === NOTIFY_JOBS.discord)).toEqual([
      {
        queue: QUEUES.notifications,
        name: NOTIFY_JOBS.discord,
        data: { channelId: s.channel.id, eventId: ev.eventId, broadcastId: ev.broadcastId, test: false },
        opts: { jobId: `discord-${ev.eventId}` },
      },
    ]);
    const nextJob = p1.jobs.find((j) => j.name === NOTIFY_JOBS.goLive);
    expect(nextJob).toBeDefined();
    const after = (nextJob!.data as { after: string }).after;
    const p2 = recording();
    const r2 = await fanOutGoLive(p2.ctx, { eventId: ev.eventId, after }, { pageSize: 2 });
    expect(r2).toMatchObject({ followers: 1, nextPage: false });
    expect(p2.jobs).toEqual([]);
  });

  test("no Discord webhook → no DiscordJob", async () => {
    const s = await streamer();
    await followers(s.channel.id, 1);
    const ev = await goLive(s);
    const { ctx, jobs } = recording();
    await fanOutGoLive(ctx, { eventId: ev.eventId, after: null });
    expect(jobs).toEqual([]);
  });

  test("a missing event, another type or a missing broadcast → zeros, no throw", async () => {
    const zeros = { followers: 0, inApp: 0, email: 0, push: 0, cooledDown: 0, nextPage: false };
    const { ctx, jobs } = recording();
    expect(await fanOutGoLive(ctx, { eventId: uuidv7(), after: null })).toEqual(zeros);
    const s = await streamer();
    await followers(s.channel.id, 1);
    const offline = await insertEvent(db(), "stream.offline", s.channel.id, { ...broadcasterFields(s.user) });
    expect(await fanOutGoLive(ctx, { eventId: offline.id, after: null })).toEqual(zeros);
    const ghost = await insertEvent(db(), "stream.online", s.channel.id, {
      ...broadcasterFields(s.user),
      id: uuidv7(),
      type: "live",
      started_at: START.toISOString(),
    });
    expect(await fanOutGoLive(ctx, { eventId: ghost.id, after: null })).toEqual(zeros);
    expect(jobs).toEqual([]);
    expect(await rowsFor(s.channel.id)).toHaveLength(0);
  });

  test("the job handler runs the fan-out", async () => {
    const s = await streamer();
    await followers(s.channel.id, 2);
    const ev = await goLive(s);
    const { ctx } = recording();
    expect(
      await goLiveJob.handler({ eventId: ev.eventId, after: null }, ctx, { id: undefined, attemptsMade: 0 }),
    ).toEqual({
      followers: 2,
      inApp: 2,
      email: 0,
      push: 0,
      cooledDown: 0,
      nextPage: false,
    });
  });

  test("the page query uses follows_channel_notify_idx and notification_prefs_uq", async () => {
    const s = await streamer();
    const members = await followers(s.channel.id, 600);
    for (const m of members.slice(0, 200)) await pref(m, "email", true);
    await db().execute(sql`analyze follows; analyze notification_preferences; analyze users`);
    const q = pageQuery({ channelId: s.channel.id, ownerId: s.user.id }, members[100] ?? null, 500);
    // A test database is tiny, so the planner rightly prefers sequential scans; with them off it
    // shows the plan a large table gets (the indexes exist and fit the predicates).
    const text = await db().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = (await tx.execute(sql`explain ${q}`)) as unknown as { "QUERY PLAN": string }[];
      return plan.map((r) => r["QUERY PLAN"]).join("\n");
    });
    if (process.env.NOTIFY_EXPLAIN_OUT) writeFileSync(`${process.env.NOTIFY_EXPLAIN_OUT}/page.txt`, text);
    expect(text).toContain("follows_channel_notify_idx");
    expect(text).toContain("notification_prefs_uq");
  });
});
