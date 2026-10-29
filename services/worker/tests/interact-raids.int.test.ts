// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `raids-execute` against a real database (application role) and Valkey (ADR 0026 decision 4): the
 * verified viewer count a raid carries, every re-check that cancels, overlapping runs executing a
 * raid once, and the `raid` frame on the source's chat control after commit.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { ChatControlMessage } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import { executeDueRaids } from "../src/interact/raids/execute.ts";
import { job as raidsJob } from "../src/jobs/raids-execute.ts";
import { createWorker, type WorkerHandle } from "../src/worker.ts";
import { fastWebhooks, makeBroadcast, makeUser, quietLogger, VALKEY_URL, waitFor } from "./fixtures.ts";

let t: TestDatabase;
let owner: Database;
let worker: WorkerHandle;
const sub = createValkey(VALKEY_URL, { name: "worker-test-raids-sub" });
const frames: ChatControlMessage[] = [];
const ctx = () => worker.ctx;

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  const tag = crypto.randomUUID();
  // Services run as the least-privilege application role.
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
  sub.on("message", (_c: string, m: string) => frames.push(ChatControlMessage.parse(JSON.parse(m))));
});
afterAll(async () => {
  await sub.quit();
  await worker?.stop(2_000);
  await t?.drop();
});

type Chan = Awaited<ReturnType<typeof makeUser>>["channel"];

async function liveChannel(): Promise<Chan> {
  const { channel } = await makeUser(owner);
  const b = await makeBroadcast(owner, channel.id, new Date(Date.now() - 600_000));
  const [c] = await owner
    .update(schema.channels)
    .set({ liveBroadcastId: b.id })
    .where(eq(schema.channels.id, channel.id))
    .returning();
  await sub.subscribe(BUS.chatControl(channel.id));
  return c!;
}

async function dueRaid(from: Chan, to: Chan, executeAt = new Date(Date.now() - 1000)) {
  const [r] = await owner
    .insert(schema.raids)
    .values({
      fromChannelId: from.id,
      toChannelId: to.id,
      status: "pending",
      createdAt: new Date(executeAt.getTime() - 30_000),
      executeAt,
    })
    .returning();
  return r!;
}

async function session(
  channelId: string,
  over: Partial<typeof schema.playbackSessions.$inferInsert> = {},
): Promise<void> {
  await owner.insert(schema.playbackSessions).values({
    id: uuidv7(),
    channelId,
    deviceHash: `dev-${crypto.randomUUID()}`,
    ipHash: `ip-${crypto.randomUUID()}`,
    startedAt: new Date(Date.now() - 300_000),
    lastHeartbeatAt: new Date(Date.now() - 5_000),
    verdict: "verified",
    verdictReasons: [],
    scoredAt: new Date(Date.now() - 10_000),
    ...over,
  });
}

const raidRow = async (id: string) => (await owner.select().from(schema.raids).where(eq(schema.raids.id, id)))[0]!;
const raidEvents = (targetId: string) =>
  owner
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.type, "channel.raid"), eq(schema.events.channelId, targetId)));

describe("execute", () => {
  test("carries the gate-eligible viewers only: verified 1, excluded 0, fetch_unjudged 0", async () => {
    const [src, dst] = [await liveChannel(), await liveChannel()];
    const { user: viewer } = await makeUser(owner);
    // Counted: a verified, scored, judged session (and the same viewer's second one counts once).
    await session(src.id, { userId: viewer.id });
    await session(src.id, { userId: viewer.id });
    // Not counted: excluded, unjudged (CDN), not yet scored, stale heartbeat, ended, another channel.
    await session(src.id, { verdict: "excluded", verdictReasons: ["headless"] });
    await session(src.id, { verdictReasons: ["fetch_unjudged"] });
    await session(src.id, { scoredAt: null });
    await session(src.id, { lastHeartbeatAt: new Date(Date.now() - 120_000) });
    await session(src.id, { endedAt: new Date() });
    await session(dst.id);
    const raid = await dueRaid(src, dst);

    const r = await executeDueRaids(ctx());
    expect(r).toEqual({ executed: 1, canceled: 0 });
    const row = await raidRow(raid.id);
    expect(row).toMatchObject({ status: "completed", viewerCount: 1, cancelReason: null });
    expect(row.executedAt).toBeInstanceOf(Date);

    const evs = await raidEvents(dst.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toEqual({
      from_broadcaster_user_id: src.ownerId,
      from_broadcaster_user_login: src.slug,
      from_broadcaster_user_name: src.displayName,
      to_broadcaster_user_id: dst.ownerId,
      to_broadcaster_user_login: dst.slug,
      to_broadcaster_user_name: dst.displayName,
      viewers: 1,
    });

    const f = await waitFor(async () => frames.find((x) => x.op === "raid" && x.raidId === raid.id), {
      label: "completed frame",
    });
    expect(f).toEqual({
      op: "raid",
      channel: src.slug,
      raidId: raid.id,
      status: "completed",
      to: dst.slug,
      toDisplayName: dst.displayName,
      executeAt: raid.executeAt.toISOString(),
    });

    // Settled raids are never touched again.
    expect(await executeDueRaids(ctx())).toEqual({ executed: 0, canceled: 0 });
  });

  test("a raid still counting down is left alone", async () => {
    const [src, dst] = [await liveChannel(), await liveChannel()];
    const raid = await dueRaid(src, dst, new Date(Date.now() + 20_000));
    expect(await executeDueRaids(ctx())).toEqual({ executed: 0, canceled: 0 });
    expect((await raidRow(raid.id)).status).toBe("pending");
    await owner.delete(schema.raids).where(eq(schema.raids.id, raid.id));
  });

  test("the job handler returns the counts", async () => {
    const [src, dst] = [await liveChannel(), await liveChannel()];
    await dueRaid(src, dst);
    expect(await raidsJob.handler({}, ctx(), { id: undefined, attemptsMade: 0 })).toEqual({ executed: 1, canceled: 0 });
  });
});

describe("re-checks at execute cancel", () => {
  const cases: {
    name: string;
    reason: string;
    setup: (src: Chan, dst: Chan) => Promise<unknown>;
  }[] = [
    {
      name: "the source suspended",
      reason: "suspended",
      setup: (src) =>
        owner.update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, src.id)),
    },
    {
      name: "the target suspended",
      reason: "suspended",
      setup: (_s, dst) =>
        owner.update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, dst.id)),
    },
    {
      name: "the source offline",
      reason: "source_offline",
      setup: (src) =>
        owner.update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.id, src.id)),
    },
    {
      name: "the target offline",
      reason: "target_offline",
      setup: (_s, dst) =>
        owner.update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.id, dst.id)),
    },
    {
      name: "the target's policy now off",
      reason: "target_refused",
      setup: (_s, dst) =>
        owner.update(schema.channels).set({ raidPolicy: "off" }).where(eq(schema.channels.id, dst.id)),
    },
    {
      name: "the target's policy now followed, without the follow",
      reason: "target_refused",
      setup: (_s, dst) =>
        owner.update(schema.channels).set({ raidPolicy: "followed" }).where(eq(schema.channels.id, dst.id)),
    },
  ];
  for (const c of cases)
    test(`${c.name} → canceled (${c.reason}), canceled frame, no channel.raid`, async () => {
      const [src, dst] = [await liveChannel(), await liveChannel()];
      const raid = await dueRaid(src, dst);
      await c.setup(src, dst);
      expect(await executeDueRaids(ctx())).toEqual({ executed: 0, canceled: 1 });
      const row = await raidRow(raid.id);
      expect(row).toMatchObject({ status: "canceled", cancelReason: c.reason, executedAt: null, viewerCount: 0 });
      expect(row.canceledAt).toBeInstanceOf(Date);
      expect(await raidEvents(dst.id)).toHaveLength(0);
      await waitFor(
        async () => frames.find((x) => x.op === "raid" && x.raidId === raid.id && x.status === "canceled"),
        {
          label: "canceled frame",
        },
      );
    });

  test("the target's policy followed, with the follow → executes", async () => {
    const [src, dst] = [await liveChannel(), await liveChannel()];
    await owner.update(schema.channels).set({ raidPolicy: "followed" }).where(eq(schema.channels.id, dst.id));
    await owner.insert(schema.follows).values({ followerId: dst.ownerId, channelId: src.id });
    const raid = await dueRaid(src, dst);
    expect(await executeDueRaids(ctx())).toEqual({ executed: 1, canceled: 0 });
    expect((await raidRow(raid.id)).status).toBe("completed");
  });
});

test("overlapping runs execute each raid once", async () => {
  const raids = [];
  for (let i = 0; i < 6; i++) raids.push(await dueRaid(await liveChannel(), await liveChannel()));
  const results = await Promise.all([executeDueRaids(ctx()), executeDueRaids(ctx()), executeDueRaids(ctx())]);
  expect(results.reduce((n, r) => n + r.executed, 0)).toBe(6);
  expect(results.reduce((n, r) => n + r.canceled, 0)).toBe(0);
  for (const r of raids) {
    expect((await raidRow(r.id)).status).toBe("completed");
    expect(await raidEvents(r.toChannelId)).toHaveLength(1);
  }
});
