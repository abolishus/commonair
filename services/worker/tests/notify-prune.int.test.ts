// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notify-prune` (decided 2026-10-30) against real Postgres and Valkey: the two age rules and their
 * boundaries, batching, the run lock and a run through BullMQ as the ops tick enqueues it. The
 * code's clock is pinned and every `created_at` is written from it.
 */
import { NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { inArray, sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { job, NOTIFY_PRUNE_LOCK_KEY } from "../src/jobs/notify-prune.ts";
import { pruneBatch, pruneCutoffs, pruneNotifications, pruneRules } from "../src/notify/prune/prune.ts";
import { createWorker } from "../src/worker.ts";
import { fastWebhooks, makeUser, quietLogger, setup, VALKEY_URL, waitFor, type TestEnv } from "./fixtures.ts";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;
const META = { id: undefined, attemptsMade: 0 };
let env: TestEnv;
let userId: string;

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, now: () => NOW });
  userId = (await makeUser(env.t.db)).user.id;
});
afterAll(() => env.close());
// One database per file: every test starts from no notifications, so counts are exact.
beforeEach(async () => {
  await env.t.db.delete(schema.notifications);
});

const ctx = () => env.worker.ctx;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function row(
  ageMs: number,
  over: { type?: "go_live" | "moderation" | "raid"; read?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await env.t.db.insert(schema.notifications).values({
    id,
    userId,
    type: over.type ?? "go_live",
    payload: {},
    readAt: over.read ? ago(ageMs - 1_000) : null,
    createdAt: ago(ageMs),
  });
  return id;
}

async function remaining(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await env.t.db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(inArray(schema.notifications.id, ids));
  return new Set(rows.map((r) => r.id));
}

describe("notify-prune", () => {
  test("90 days for every row: 91 days deleted, 89 kept, exactly 90 kept", async () => {
    const old = await row(91 * DAY, { type: "moderation" });
    const young = await row(89 * DAY, { type: "moderation" });
    const boundary = await row(90 * DAY, { type: "moderation" });
    const justPast = await row(90 * DAY + 1, { type: "raid" });
    expect(await pruneNotifications(ctx())).toEqual({ deleted: 2, readGoLive: 0 });
    expect(await remaining([old, young, boundary, justPast])).toEqual(new Set([young, boundary]));
  });

  test("30 days for read go_live rows only: unread kept, other types kept, exactly 30 kept", async () => {
    const readGoLive = await row(31 * DAY, { read: true });
    const unreadGoLive = await row(31 * DAY);
    const readOther = await row(31 * DAY, { type: "moderation", read: true });
    const boundary = await row(30 * DAY, { read: true });
    const justPast = await row(30 * DAY + 1, { read: true });
    const recentRead = await row(29 * DAY, { read: true });
    expect(await pruneNotifications(ctx())).toEqual({ deleted: 2, readGoLive: 2 });
    expect(await remaining([readGoLive, unreadGoLive, readOther, boundary, justPast, recentRead])).toEqual(
      new Set([unreadGoLive, readOther, boundary, recentRead]),
    );
  });

  test("a read go_live row past both windows counts once, under the age rule", async () => {
    const both = await row(120 * DAY, { read: true });
    expect(await pruneNotifications(ctx())).toEqual({ deleted: 1, readGoLive: 0 });
    expect(await remaining([both])).toEqual(new Set());
  });

  test("more rows than one batch all go, across batches", async () => {
    const values = Array.from({ length: 23 }, (_, i) => ({
      id: uuidv7(),
      userId,
      type: "moderation" as const,
      payload: {},
      createdAt: ago(100 * DAY + i * 1_000),
    }));
    await env.t.db.insert(schema.notifications).values(values);
    const reads = Array.from({ length: 7 }, () => ({
      id: uuidv7(),
      userId,
      type: "go_live" as const,
      payload: {},
      readAt: ago(40 * DAY),
      createdAt: ago(45 * DAY),
    }));
    await env.t.db.insert(schema.notifications).values(reads);
    const keep = await row(DAY);
    // 23 = 5 + 5 + 5 + 5 + 3; 7 = 5 + 2; exactly a multiple ends on an empty batch.
    expect(await pruneNotifications(ctx(), { batchSize: 5 })).toEqual({ deleted: 30, readGoLive: 7 });
    expect(await remaining([keep])).toEqual(new Set([keep]));
    await env.t.db.insert(schema.notifications).values(values.slice(0, 10).map((v) => ({ ...v, id: uuidv7() })));
    expect(await pruneNotifications(ctx(), { batchSize: 5 })).toEqual({ deleted: 10, readGoLive: 0 });
  });

  test("the read go_live rule skips kept rows across batches, ties at a batch edge included", async () => {
    // Interleaved: read go_live (deleted) and unread / other-type rows (kept) in the 30-90 day band,
    // with pairs sharing one timestamp so a batch can end in the middle of a tie.
    const read: string[] = [];
    const kept: string[] = [];
    for (let i = 0; i < 12; i++) {
      const age = 40 * DAY + Math.floor(i / 2) * 1_000;
      read.push(await row(age, { read: true }));
      kept.push(await row(age));
      kept.push(await row(age, { type: "raid", read: true }));
    }
    expect(await pruneNotifications(ctx(), { batchSize: 5 })).toEqual({ deleted: 12, readGoLive: 12 });
    expect(await remaining(read)).toEqual(new Set());
    expect(await remaining(kept)).toEqual(new Set(kept));
  });

  test("an empty table returns zeros", async () => {
    expect(await pruneNotifications(ctx())).toEqual({ deleted: 0, readGoLive: 0 });
  });

  test("the handler runs under its run lock; a held lock answers skipped", async () => {
    const old = await row(91 * DAY);
    expect(await job.handler({}, ctx(), META)).toEqual({ deleted: 1, readGoLive: 0 });
    expect(await remaining([old])).toEqual(new Set());
    const again = await row(91 * DAY);
    await ctx().valkey.set(NOTIFY_PRUNE_LOCK_KEY, "other-replica", "PX", 5_000);
    try {
      expect(await job.handler({}, ctx(), META)).toEqual({ skipped: 1 });
      expect(await remaining([again])).toEqual(new Set([again]));
    } finally {
      await ctx().valkey.del(NOTIFY_PRUNE_LOCK_KEY);
    }
  });

  test("the ops tick runs it: enqueued with empty data on the retention queue", async () => {
    const old = await row(91 * DAY);
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
      jobs: [job],
      outbox: false,
      segments: false,
      now: () => NOW,
    });
    await w.start();
    try {
      // What `POST /internal/ops/tick {"job":"notify-prune"}` enqueues (services/api/src/ops/hooks.ts).
      await w.ctx.enqueue(QUEUES.retention, NOTIFY_JOBS.prune, {}, { jobId: `ops-${tag}` });
      await waitFor(async () => (await remaining([old])).size === 0, { label: "the old row pruned" });
      expect(await remaining([old])).toEqual(new Set());
    } finally {
      await w.stop(5_000);
    }
  });

  test("a batch uses notifications_created_idx", async () => {
    const values = Array.from({ length: 2_000 }, (_, i) => ({
      id: uuidv7(),
      userId,
      type: "go_live" as const,
      payload: {},
      createdAt: ago(i * 60_000),
    }));
    await env.t.db.insert(schema.notifications).values(values);
    await env.t.db.execute(sql`analyze notifications`);
    const rules = pruneRules(pruneCutoffs(NOW));
    const explain = async (q: ReturnType<typeof pruneBatch>) => {
      const plan = (await env.t.db.execute(sql`explain ${q}`)) as unknown as { "QUERY PLAN": string }[];
      return plan.map((r) => r["QUERY PLAN"]).join("\n");
    };
    const all = await explain(pruneBatch(rules.all, 5_000));
    const read = await explain(pruneBatch(rules.readGoLive, 5_000));
    if (process.env.NOTIFY_EXPLAIN_OUT)
      writeFileSync(
        `${process.env.NOTIFY_EXPLAIN_OUT}/prune.txt`,
        `-- age rule\n${all}\n\n-- read go_live rule\n${read}\n`,
      );
    expect(all).toContain("notifications_created_idx");
    expect(read).toContain("notifications_created_idx");
  });
});
