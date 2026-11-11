// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 2 (d2-membership): the hourly membership sync (`coop-membership-sync`, the
 * backstop to the payment webhook) tells members in their inbox when a membership starts or ends,
 * once per membership: a second run, or a notice the API already wrote with the same key, adds none.
 */
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { syncMemberships } from "@commonair/governance";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { membershipNoticeKey, membershipNotices } from "../src/coop/run.ts";
import { job as membershipJob } from "../src/jobs/coop-membership-sync.ts";
import { createWorker, type WorkerHandle } from "../src/worker.ts";
import { fastWebhooks, quietLogger, VALKEY_URL } from "./fixtures.ts";

const DAY = 86_400_000;
let t: TestDatabase;
let worker: WorkerHandle;
let app: Database;
let channelId: string;
const meta = { id: undefined, attemptsMade: 0 };

let seq = 0;
async function user(): Promise<string> {
  const name = `mn${++seq}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function subscribe(subscriberId: string, priceCents: number): Promise<string> {
  const [row] = await app
    .insert(s.subscriptions)
    .values({
      id: uuidv7(),
      channelId,
      subscriberId,
      tier: 1,
      provider: "manual",
      priceCents,
      currency: "usd",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
    })
    .returning({ id: s.subscriptions.id });
  return row!.id;
}

const notices = (userId: string) =>
  app
    .select()
    .from(s.notifications)
    .where(and(eq(s.notifications.userId, userId), eq(s.notifications.type, "membership")))
    .orderBy(s.notifications.createdAt);
const viewer = async (userId: string) =>
  (
    await app
      .select()
      .from(s.memberships)
      .where(and(eq(s.memberships.userId, userId), eq(s.memberships.class, "viewer")))
      .orderBy(s.memberships.createdAt)
  ).at(-1);

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  const tag = crypto.randomUUID();
  worker = createWorker({
    db: t.app,
    valkeyUrl: VALKEY_URL,
    logger: quietLogger,
    webhooks: fastWebhooks(),
    keyPrefix: `test:${tag}:`,
    bullPrefix: `test-bull-${tag}`,
    busChannel: `test:${tag}:bus:events`,
    jobs: [],
    outbox: false,
    segments: false,
  });
  const owner = await user();
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId: owner, slug: `mnc${owner.slice(-10)}`, displayName: "Channel" })
    .returning({ id: s.channels.id });
  channelId = c!.id;
});
afterAll(async () => {
  await worker?.stop(2_000);
  await t?.drop();
});

describe("membership sync notices", () => {
  let subscriber: string;
  let subscriptionId: string;

  test("the sync's activation sends one membership_started notice; a second run sends none", async () => {
    subscriber = await user();
    subscriptionId = await subscribe(subscriber, 499);
    const first = (await membershipJob.handler({}, worker.ctx, meta)) as Record<string, number>;
    expect(first.activated).toBeGreaterThanOrEqual(1);
    const m = await viewer(subscriber);
    expect(m).toMatchObject({ status: "active", basis: "subscription" });
    const n = await notices(subscriber);
    expect(n.map((x) => [x.payload, x.dedupeKey])).toEqual([
      [{ kind: "membership_started", basis: "subscription" }, membershipNoticeKey("membership_started", m!.id)],
    ]);
    await membershipJob.handler({}, worker.ctx, meta);
    expect(await notices(subscriber)).toHaveLength(1);
  });

  test("when the subscription ends, the lapse sends membership_ended", async () => {
    await app.update(s.subscriptions).set({ status: "canceled" }).where(eq(s.subscriptions.id, subscriptionId));
    const r = (await membershipJob.handler({}, worker.ctx, meta)) as Record<string, number>;
    expect(r.lapsed).toBe(1);
    const n = await notices(subscriber);
    expect(n.map((x) => x.payload)).toEqual([
      { kind: "membership_started", basis: "subscription" },
      { kind: "membership_ended", basis: "subscription" },
    ]);
    const m = await viewer(subscriber);
    expect(m?.status).toBe("lapsed");
    expect(n[1]?.dedupeKey).toBe(membershipNoticeKey("membership_ended", m!.id));
  });

  test("a notice the payment webhook already wrote (same key) is not repeated; nothing to say writes nothing", async () => {
    const other = await user();
    await subscribe(other, 999);
    // What the sync is about to activate, announced already under the shared key format.
    const result = await syncMemberships(app, new Date());
    const started = result.activated.find((c) => c.userId === other);
    expect(started).toBeDefined();
    await app.insert(s.notifications).values({
      userId: other,
      type: "membership",
      payload: { kind: "membership_started", basis: "subscription" },
      dedupeKey: membershipNoticeKey("membership_started", started!.membershipId),
    });
    expect(await membershipNotices(app, result, new Date())).toBe(0);
    expect(await notices(other)).toHaveLength(1);
    expect(await membershipNotices(app, { activated: [], lapsed: [] }, new Date())).toBe(0);
  });

  test("the key format matches the API's", () => {
    const id = "0192f000-0000-7000-8000-000000000001";
    expect(membershipNoticeKey("membership_started", id)).toBe(`membership-started-${id}`);
    expect(membershipNoticeKey("membership_ended", id)).toBe(`membership-ended-${id}`);
  });
});
