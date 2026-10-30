// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Chat retention (ADR 0012 amendment 1 decision 6) against real Postgres. */
import { schema, uuidv7 } from "@commonair/db";
import { eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { chatRetentionConfigFromEnv, enforceChatRetention } from "../src/chat/retention.ts";
import { job as chatRetentionJob } from "../src/jobs/chat-retention.ts";
import { JOBS } from "../src/jobs/index.ts";
import { makeBroadcast, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());
// One database per file: start each test from no chat at all, so counts are exact.
beforeEach(async () => {
  await env.t.db.delete(schema.chatMessages);
  await env.t.db
    .update(schema.legalHolds)
    .set({ releasedAt: new Date(), releaseReason: "test reset" })
    .where(isNull(schema.legalHolds.releasedAt));
});

const ctx = () => env.worker.ctx;
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const CFG = { retentionDays: 30, maxDays: 60 };
const META = { id: undefined, attemptsMade: 0 };

async function message(channelId: string, userId: string, broadcastId: string | null, ageDays: number) {
  const id = uuidv7();
  await env.t.db.insert(schema.chatMessages).values({
    id,
    channelId,
    userId,
    broadcastId,
    body: "hello",
    createdAt: daysAgo(ageDays),
  });
  return id;
}

async function vod(broadcastId: string, channelId: string, over: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  await env.t.db.insert(schema.vods).values({
    id,
    broadcastId,
    channelId,
    title: "vod",
    status: "ready",
    storagePrefix: `vods/${id}/`,
    ...over,
  });
  return id;
}

async function remaining(ids: string[]): Promise<Set<string>> {
  const rows = await env.t.db
    .select({ id: schema.chatMessages.id })
    .from(schema.chatMessages)
    .where(inArray(schema.chatMessages.id, ids));
  return new Set(rows.map((r) => r.id));
}

describe("enforceChatRetention", () => {
  test("VOD-attached chat is kept past 30 days, up to 60", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, daysAgo(50));
    await vod(b.id, channel.id, { expiresAt: new Date(Date.now() + 10 * DAY) });
    const at45 = await message(channel.id, user.id, b.id, 45);
    const at59 = await message(channel.id, user.id, b.id, 59);
    const at61 = await message(channel.id, user.id, b.id, 61);
    expect(await enforceChatRetention(ctx(), CFG)).toEqual({ deleted: 1, held: 0 });
    expect(await remaining([at45, at59, at61])).toEqual(new Set([at45, at59]));
  });

  test("a VOD that expired at 14 days leaves its chat to the 30-day rule", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, daysAgo(35));
    await vod(b.id, channel.id, { status: "deleted", removedReason: "retention", expiresAt: daysAgo(21) });
    const at20 = await message(channel.id, user.id, b.id, 20);
    const at31 = await message(channel.id, user.id, b.id, 31);
    expect(await enforceChatRetention(ctx(), CFG)).toEqual({ deleted: 1, held: 0 });
    expect(await remaining([at20, at31])).toEqual(new Set([at20]));
  });

  test("a removed VOD (not yet deleted) no longer keeps its chat", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, daysAgo(40));
    await vod(b.id, channel.id, { removedReason: "owner", expiresAt: new Date() });
    const at31 = await message(channel.id, user.id, b.id, 31);
    expect(await enforceChatRetention(ctx(), CFG)).toEqual({ deleted: 1, held: 0 });
    expect(await remaining([at31])).toEqual(new Set());
  });

  test("a broadcast with no VOD, and offline chat, go at 30 days", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, daysAgo(40));
    const live29 = await message(channel.id, user.id, b.id, 29);
    const live31 = await message(channel.id, user.id, b.id, 31);
    const offline29 = await message(channel.id, user.id, null, 29);
    const offline31 = await message(channel.id, user.id, null, 31);
    expect(await enforceChatRetention(ctx(), CFG)).toEqual({ deleted: 2, held: 0 });
    expect(await remaining([live29, live31, offline29, offline31])).toEqual(new Set([live29, offline29]));
  });

  test("an author under a legal hold is skipped and counted; a released hold is not", async () => {
    const { user: held, channel } = await makeUser(env.t.db);
    const { user: released } = await makeUser(env.t.db);
    const { user: other } = await makeUser(env.t.db);
    await env.t.db
      .insert(schema.legalHolds)
      .values({ userId: held.id, reasonCode: "law_enforcement", reason: "preservation request" });
    // A hold starts active (trigger-enforced); release it right away.
    await env.t.db
      .insert(schema.legalHolds)
      .values({ userId: released.id, reasonCode: "law_enforcement", reason: "preservation request" });
    await env.t.db
      .update(schema.legalHolds)
      .set({ releasedAt: new Date(), releaseReason: "test" })
      .where(eq(schema.legalHolds.userId, released.id));
    const keptOffline = await message(channel.id, held.id, null, 31);
    const keptOld = await message(channel.id, held.id, null, 90);
    const goneReleased = await message(channel.id, released.id, null, 31);
    const goneOther = await message(channel.id, other.id, null, 61);
    expect(await enforceChatRetention(ctx(), CFG)).toEqual({ deleted: 2, held: 2 });
    expect(await remaining([keptOffline, keptOld, goneReleased, goneOther])).toEqual(new Set([keptOffline, keptOld]));
    // Releasing the hold lets the next run delete them.
    await env.t.db
      .update(schema.legalHolds)
      .set({ releasedAt: new Date(), releaseReason: "test" })
      .where(eq(schema.legalHolds.userId, held.id));
    expect(await enforceChatRetention(ctx(), CFG)).toEqual({ deleted: 2, held: 0 });
  });

  test("batching stops at the budget and the next run resumes", async () => {
    const { user, channel } = await makeUser(env.t.db);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await message(channel.id, user.id, null, 31 + i));
    // A zero budget runs exactly one batch.
    expect(await enforceChatRetention(ctx(), CFG, { batchSize: 2, budgetMs: 0 })).toEqual({ deleted: 2, held: 0 });
    expect((await remaining(ids)).size).toBe(3);
    // Oldest first.
    expect(await remaining(ids.slice(3))).toEqual(new Set());
    expect(await enforceChatRetention(ctx(), CFG, { batchSize: 2, budgetMs: 0 })).toEqual({ deleted: 2, held: 0 });
    // With budget left, batches continue until nothing is due.
    expect(await enforceChatRetention(ctx(), CFG, { batchSize: 2, budgetMs: 60_000 })).toEqual({ deleted: 1, held: 0 });
    expect((await remaining(ids)).size).toBe(0);
    expect(await enforceChatRetention(ctx(), CFG, { batchSize: 2 })).toEqual({ deleted: 0, held: 0 });
  });

  test("the operator settings come from the chat env", () => {
    expect(chatRetentionConfigFromEnv({})).toEqual({ retentionDays: 30, maxDays: 60 });
    expect(chatRetentionConfigFromEnv({ CHAT_RETENTION_DAYS: "7", CHAT_REPLAY_MAX_DAYS: "14" })).toEqual({
      retentionDays: 7,
      maxDays: 14,
    });
    expect(() => chatRetentionConfigFromEnv({ CHAT_RETENTION_DAYS: "30", CHAT_REPLAY_MAX_DAYS: "10" })).toThrow(
      /CHAT_REPLAY_MAX_DAYS/,
    );
  });

  test("the job is registered and runs under its run lock", async () => {
    expect(JOBS.some((j) => j.queue === chatRetentionJob.queue && j.name === "chat-retention")).toBe(true);
    const { user, channel } = await makeUser(env.t.db);
    const old = await message(channel.id, user.id, null, 61);
    // The ops tick passes empty data; the handler reads the env defaults (30 / 60).
    expect(await chatRetentionJob.handler({}, ctx(), META)).toEqual({ deleted: 1, held: 0 });
    expect(await remaining([old])).toEqual(new Set());
    await ctx().valkey.set("worker:lock:retention:chat-retention", "other-replica", "PX", 5_000);
    try {
      expect(await chatRetentionJob.handler({}, ctx(), META)).toEqual({ skipped: 1 });
    } finally {
      await ctx().valkey.del("worker:lock:retention:chat-retention");
    }
  });
});
