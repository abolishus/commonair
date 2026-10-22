// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Co-op jobs against a real database (application role) and Valkey: the job handlers and their
 * results, the run lock, and the share cancellation on share-payment expiry.
 */
import { COOP_JOBS } from "@commonair/contracts/internal";
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { FAST_GOVERNANCE, createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { coopLockKey, withCoopLock } from "../src/coop/job.ts";
import { job as councilJob } from "../src/jobs/coop-council-recompute.ts";
import { job as electionsJob } from "../src/jobs/coop-elections-advance.ts";
import { job as membershipJob } from "../src/jobs/coop-membership-sync.ts";
import { job as proposalsJob } from "../src/jobs/coop-proposals-advance.ts";
import { job as streamHoursJob } from "../src/jobs/coop-stream-hours.ts";
import { runLockKey } from "../src/integrity/jobs.ts";
import { expirePendingPayments } from "../src/money/expire.ts";
import { createWorker, type WorkerHandle } from "../src/worker.ts";
import { fastWebhooks, quietLogger, VALKEY_URL } from "./fixtures.ts";

let t: TestDatabase;
let worker: WorkerHandle;
let app: Database;
const meta = { id: undefined, attemptsMade: 0 };
const ctx = () => worker.ctx;

beforeAll(async () => {
  t = await createTestDatabase({ governance: FAST_GOVERNANCE });
  app = t.app.db;
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
});
afterAll(async () => {
  await worker?.stop(2_000);
  await t?.drop();
});

let seq = 0;
async function user(): Promise<string> {
  const name = `cw${++seq}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

describe("share payment expiry", () => {
  test("an expired share payment cancels its pending share with an event; a live one is untouched", async () => {
    const share = async (expiresAt: Date) => {
      const userId = await user();
      const [pay] = await app
        .insert(s.payments)
        .values({
          id: uuidv7(),
          provider: "manual",
          providerRef: `CA-${crypto.randomUUID().slice(0, 8)}`,
          kind: "membership_share",
          userId,
          amountCents: 500,
          currency: "usd",
          expiresAt,
        })
        .returning({ id: s.payments.id });
      const [sh] = await app
        .insert(s.membershipShares)
        .values({ userId, amountCents: 500, currency: "usd", paymentId: pay!.id })
        .returning({ id: s.membershipShares.id });
      return { userId, paymentId: pay!.id, shareId: sh!.id };
    };
    const expired = await share(new Date(Date.now() - 3_600_000));
    const live = await share(new Date(Date.now() + 3_600_000));

    const r = await expirePendingPayments(ctx(), { batchSize: 100, budgetMs: 30_000 });
    expect(r).toMatchObject({ payments: 1, shares: 1 });

    const statusOf = async (id: string) =>
      (await app.select().from(s.membershipShares).where(eq(s.membershipShares.id, id)))[0]!.status;
    expect(await statusOf(expired.shareId)).toBe("cancelled");
    expect(await statusOf(live.shareId)).toBe("pending");
    const [pay] = await app.select().from(s.payments).where(eq(s.payments.id, expired.paymentId));
    expect(pay!.status).toBe("failed");

    const events = await app
      .select()
      .from(s.events)
      .where(and(eq(s.events.type, "coop.share.update"), sql`${s.events.payload}->>'share_id' = ${expired.shareId}`));
    expect(events.map((e) => e.payload)).toEqual([
      { share_id: expired.shareId, user_id: expired.userId, status: "cancelled", amount_cents: 500 },
    ]);
    const [audit] = await app.select().from(s.auditLog).where(eq(s.auditLog.subjectId, expired.shareId));
    expect(audit).toMatchObject({ actorType: "system", action: "coop.share.cancel" });
    expect(audit!.details).toEqual({ shareId: expired.shareId, paymentId: expired.paymentId, amountCents: 500 });

    // The cancelled share no longer blocks a new one (one open share per user).
    await app.insert(s.membershipShares).values({ userId: expired.userId, amountCents: 500, currency: "usd" });
    // A second run finds nothing.
    expect(await expirePendingPayments(ctx(), { batchSize: 100, budgetMs: 30_000 })).toMatchObject({
      payments: 0,
      shares: 0,
    });
  });
});

describe("run lock", () => {
  test("a run waits for a lock held elsewhere and gives up as skipped", async () => {
    await ctx().valkey.set(coopLockKey(COOP_JOBS.councilRecompute), "other-replica", "PX", 5_000);
    let ran = false;
    const r = await withCoopLock(
      ctx(),
      COOP_JOBS.councilRecompute,
      { maxRunMs: 1_000, waitMs: 300, pollMs: 50 },
      async () => {
        ran = true;
        return { created: 1 };
      },
    );
    expect(r).toEqual({ skipped: 1 });
    expect(ran).toBe(false);
    await ctx().valkey.del(coopLockKey(COOP_JOBS.councilRecompute));
  });

  test("a run that waits takes the lock once it is released, and releases it afterwards", async () => {
    await ctx().valkey.set(coopLockKey(COOP_JOBS.electionsAdvance), "other-replica", "PX", 300);
    const r = await withCoopLock(
      ctx(),
      COOP_JOBS.electionsAdvance,
      { maxRunMs: 1_000, waitMs: 5_000, pollMs: 50 },
      async () => ({
        closed: 0,
      }),
    );
    expect(r).toEqual({ closed: 0 });
    expect(await ctx().valkey.get(coopLockKey(COOP_JOBS.electionsAdvance))).toBeNull();
  });

  test("the stream-hours tick waits for the integrity job's own lock, then runs the pass", async () => {
    await ctx().valkey.set(runLockKey("stream-hours"), "scheduled-run", "PX", 300);
    const r = (await streamHoursJob.handler({}, ctx(), meta)) as Record<string, number>;
    expect(Object.keys(r).sort()).toEqual(["eligible", "updated"]);
    expect(await ctx().valkey.get(runLockKey("stream-hours"))).toBeNull();
  });

  test("two concurrent handler runs do the work once", async () => {
    const author = await user();
    await app.insert(s.memberships).values({ userId: author, class: "viewer", basis: "share" });
    const [p] = await app
      .insert(s.proposals)
      .values({ authorId: author, title: "Locked", body: "b", kind: "ordinary", affectsCreators: false, changes: [] })
      .returning({ id: s.proposals.id });
    await app.update(s.proposals).set({ status: "discussion" }).where(eq(s.proposals.id, p!.id));
    await Bun.sleep(20);
    const [a, b] = (await Promise.all([
      proposalsJob.handler({}, ctx(), meta),
      proposalsJob.handler({}, ctx(), meta),
    ])) as Record<string, number>[];
    expect((a!.votingOpened ?? 0) + (b!.votingOpened ?? 0)).toBe(1);
    const [row] = await app.select().from(s.proposals).where(eq(s.proposals.id, p!.id));
    expect(row!.status).toBe("voting");
  });
});

describe("job handlers", () => {
  test("return counts only (CoopJobResult) and write through the governance steps", async () => {
    const streamer = await user();
    await app.insert(s.memberships).values({ userId: streamer, class: "streamer", basis: "streaming_hours" });

    const council = (await councilJob.handler({}, ctx(), meta)) as Record<string, number>;
    expect(council).toEqual({ created: 1, seats: 0 });
    // council.config needs eligible hours to seat anyone; the term itself is recorded.
    expect(await councilJob.handler({}, ctx(), meta)).toEqual({ created: 0, seats: 0 });

    const membership = (await membershipJob.handler({}, ctx(), meta)) as Record<string, number>;
    expect(Object.keys(membership).sort()).toEqual(["activated", "confirmed", "lapseRefused", "lapsed"]);
    for (const v of Object.values(membership)) expect(Number.isInteger(v)).toBe(true);

    expect(await electionsJob.handler({}, ctx(), meta)).toEqual({ votingOpened: 0, closed: 0, failed: 0 });

    const proposals = (await proposalsJob.handler({}, ctx(), meta)) as Record<string, number>;
    expect(Object.keys(proposals).sort()).toEqual(
      [
        "applied",
        "applyRefused",
        "councilReview",
        "disagreements",
        "failed",
        "notified",
        "passed",
        "rejected",
        "votingOpened",
      ].sort(),
    );
  });
});
