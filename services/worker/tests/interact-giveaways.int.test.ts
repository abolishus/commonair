// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `giveaway-close` against a real database (application role; ADR 0039 §2): a due giveaway is
 * closed with a `system` audit row, once; an early run fails so BullMQ retries; a giveaway that is
 * gone or no longer open is skipped.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { GIVEAWAY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { commit, newSalt, newSeed } from "@commonair/draw";
import { closeDueGiveaway, job } from "../src/interact/giveaways/close.ts";
import { createWorker, type WorkerHandle } from "../src/worker.ts";
import { fastWebhooks, makeUser, quietLogger, VALKEY_URL } from "./fixtures.ts";

let t: TestDatabase;
let owner: Database;
let worker: WorkerHandle;
let channelId: string;
const ctx = () => worker.ctx;

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
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
  channelId = (await makeUser(owner)).channel.id;
}, 120_000);
afterAll(async () => {
  await worker?.stop(2_000);
  await t?.drop();
});

async function giveaway(closesAt: Date | null): Promise<string> {
  const id = uuidv7();
  await owner.insert(schema.giveaways).values({
    id,
    channelId,
    title: "t",
    prize: "p",
    eligibility: { minAccountAgeDays: 0, minFollowDays: null, minVerifiedWatchSeconds: 0 },
    winnerCount: 1,
    seedCommitment: await commit(newSeed()),
    sealedSeed: "v1.sealed",
    salt: newSalt(),
    closesAt,
  });
  return id;
}
const status = async (id: string) =>
  (await owner.select().from(schema.giveaways).where(eq(schema.giveaways.id, id)))[0]?.status;

describe("giveaway-close", () => {
  test("is the interact queue's job for the contract payload", () => {
    expect(job.queue).toBe(QUEUES.interact);
    expect(job.name).toBe(GIVEAWAY_JOBS.close);
  });

  test("closes a due giveaway once, with a system audit row", async () => {
    const id = await giveaway(new Date(Date.now() - 1_000));
    expect(await closeDueGiveaway(ctx(), id)).toEqual({ closed: 1, skipped: 0 });
    expect(await status(id)).toBe("closed");
    const rows = await owner
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectType, "giveaway"), eq(schema.auditLog.subjectId, id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "giveaway.close",
      actorType: "system",
      actorId: null,
      channelId,
      details: { trigger: "timed", entries: 0 },
    });
    expect(await closeDueGiveaway(ctx(), id)).toEqual({ closed: 0, skipped: 1 });
  });

  test("an early run throws (retried) and leaves it open", async () => {
    const id = await giveaway(new Date(Date.now() + 60_000));
    await expect(closeDueGiveaway(ctx(), id)).rejects.toThrow(/before closes_at/);
    expect(await status(id)).toBe("open");
    await owner.update(schema.giveaways).set({ status: "cancelled" }).where(eq(schema.giveaways.id, id));
  });

  test("a missing, untimed or cancelled giveaway is skipped", async () => {
    expect(await closeDueGiveaway(ctx(), uuidv7())).toEqual({ closed: 0, skipped: 1 });
    const untimed = await giveaway(null);
    expect(await closeDueGiveaway(ctx(), untimed)).toEqual({ closed: 0, skipped: 1 });
    expect(await status(untimed)).toBe("open");
    await owner.update(schema.giveaways).set({ status: "cancelled" }).where(eq(schema.giveaways.id, untimed));
    expect(await closeDueGiveaway(ctx(), untimed)).toEqual({ closed: 0, skipped: 1 });
  });
});
