// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 contract step: the job stubs are registered on their queues with the contract's
 * payloads (§3.6), and the outbox routes the two federation events (§3.1, decision (h)).
 */
import {
  B8_JOBS,
  FEDERATION_JOBS,
  patronagePayoutJobId,
  payoutTransferJobId,
  QUEUES,
} from "@commonair/contracts/internal";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { describe, expect, test } from "vite-plus/test";
import { type ActorDeleteTarget, actorDeleteJobs, b7JobsFor } from "../src/b7/outbox-jobs.ts";
import { b8Stub } from "../src/b8/stub.ts";
import { deliverJobId } from "../src/federation/deliver.ts";
import { JOBS } from "../src/jobs/index.ts";
import { buildRegistry, scheduledJobs } from "../src/runtime/registry.ts";

describe("batch 8 jobs", () => {
  const reg = buildRegistry(JOBS);
  const def = (queue: string, name: string) => reg.get(queue as never)?.get(name);

  test("each stub is on its queue with its schedule", () => {
    expect(def(QUEUES.payments, B8_JOBS.refundReconcile)?.schedule).toEqual({ pattern: "*/15 * * * *" });
    expect(def(QUEUES.payments, B8_JOBS.payoutTransfers)?.schedule).toBeUndefined();
    expect(def(QUEUES.payments, B8_JOBS.patronagePayout)?.schedule).toBeUndefined();
    expect(def(QUEUES.portability, B8_JOBS.incomingCleanup)?.schedule).toEqual({ pattern: "13 4 * * *" });
    expect(def(QUEUES.portability, B8_JOBS.importRecordExpiry)?.schedule).toEqual({ pattern: "19 4 * * *" });
    expect(def(QUEUES.federation, FEDERATION_JOBS.followerCleanup)?.schedule).toBeUndefined();
    const b8 = new Set<string>(Object.values(B8_JOBS));
    expect(
      scheduledJobs(reg)
        .filter((j) => b8.has(j.name))
        .map((j) => j.name)
        .sort(),
    ).toEqual([B8_JOBS.importRecordExpiry, B8_JOBS.incomingCleanup, B8_JOBS.refundReconcile].sort());
  });

  test("payloads are the contract's", () => {
    const id = uuidv7();
    const ok = (queue: string, name: string, data: unknown) => def(queue, name)?.data.safeParse(data).success;
    expect(ok(QUEUES.payments, B8_JOBS.refundReconcile, {})).toBe(true);
    expect(ok(QUEUES.payments, B8_JOBS.payoutTransfers, { payoutId: id })).toBe(true);
    expect(ok(QUEUES.payments, B8_JOBS.payoutTransfers, {})).toBe(false);
    expect(ok(QUEUES.payments, B8_JOBS.patronagePayout, { periodId: id, userId: id })).toBe(true);
    expect(ok(QUEUES.payments, B8_JOBS.patronagePayout, { periodId: id })).toBe(false);
    expect(ok(QUEUES.portability, B8_JOBS.incomingCleanup, {})).toBe(true);
    expect(ok(QUEUES.portability, B8_JOBS.importRecordExpiry, {})).toBe(true);
    expect(
      ok(QUEUES.federation, FEDERATION_JOBS.followerCleanup, { channelId: id, upTo: new Date().toISOString() }),
    ).toBe(true);
    expect(ok(QUEUES.federation, FEDERATION_JOBS.followerCleanup, { channelId: id })).toBe(false);
    // The on-demand ids are ones BullMQ accepts.
    expect(payoutTransferJobId(id)).not.toContain(":");
    expect(patronagePayoutJobId(id, id)).not.toContain(":");
  });

  test("every stub completes with skipped and touches nothing", async () => {
    const logs: unknown[] = [];
    const ctx = { logger: { debug: (...a: unknown[]) => logs.push(a) } } as never;
    const meta = { id: undefined, attemptsMade: 0 };
    for (const [queue, name] of [
      [QUEUES.payments, B8_JOBS.refundReconcile],
      [QUEUES.payments, B8_JOBS.payoutTransfers],
      [QUEUES.payments, B8_JOBS.patronagePayout],
      // B8-server filled `portability-incoming-cleanup` and `import-record-expiry`.
    ] as const)
      expect(await def(queue, name)?.handler({}, ctx, meta)).toEqual({ skipped: "stub" });
    expect(logs).toHaveLength(3);
    expect(await b8Stub("x")({}, ctx)).toEqual({ skipped: "stub" });
  });
});

type Row = typeof schema.events.$inferSelect;
const row = (type: string, payload: Record<string, unknown>, occurredAt = new Date()): Row => ({
  id: uuidv7(),
  type,
  version: "1",
  channelId: null,
  payload,
  occurredAt,
  publishedAt: null,
});

describe("b7JobsFor: the federation events (decision (h))", () => {
  const A = uuidv7();
  const now = new Date();
  const on = { federation: true, publicUrl: "https://air.test" };
  const off = { federation: false, publicUrl: "https://air.test" };
  const keyCreatedAt = new Date("2026-10-01T00:00:00.000Z");
  const inboxes = ["https://a.example/inbox", "https://b.example/users/x/inbox"];
  // The federated-channel lookup is never reached by these rows; the target reader is faked.
  const tx = {} as Executor;
  const reader = (target: ActorDeleteTarget | null) => {
    const calls: [string, Date][] = [];
    const fn = async (_tx: Executor, channelId: string, upTo: Date) => {
      calls.push([channelId, upTo]);
      return target;
    };
    return { fn, calls };
  };
  const disabled = (at?: Date) => row("federation.actor.disabled", { channel_id: A }, at);
  const toggled = (enabled: boolean, at?: Date) => row("channel.federation", { channel_id: A, enabled }, at);

  test("federation.actor.disabled queues the actor Delete to each inbox", async () => {
    const r = disabled();
    const { fn, calls } = reader({ keyCreatedAt, inboxes });
    const jobs = await b7JobsFor(tx, [r], now, on, fn);
    expect(calls).toEqual([[A, r.occurredAt]]);
    const actor = `https://air.test/ap/channels/${A}`;
    expect(jobs.map((j) => [j.queue, j.name])).toEqual([
      [QUEUES.federation, FEDERATION_JOBS.deliver],
      [QUEUES.federation, FEDERATION_JOBS.deliver],
    ]);
    const activityId = `${actor}#delete/key-${keyCreatedAt.getTime()}`;
    for (const [i, j] of jobs.entries()) {
      expect(j.data).toEqual({
        channelId: A,
        inbox: inboxes[i],
        objectId: null,
        activity: expect.objectContaining({ id: activityId, type: "Delete", actor, object: actor }),
        attempt: 1,
      });
      expect(j.opts.jobId).toBe(await deliverJobId(activityId, inboxes[i]!, 1));
      expect(j.opts.jobId).not.toContain(":");
    }
  });

  test("channel.federation off queues the same Delete and the follower cleanup; on queues nothing", async () => {
    const r = toggled(false);
    const jobs = await b7JobsFor(tx, [r], now, on, reader({ keyCreatedAt, inboxes }).fn);
    expect(jobs.map((j) => j.name)).toEqual([
      FEDERATION_JOBS.deliver,
      FEDERATION_JOBS.deliver,
      FEDERATION_JOBS.followerCleanup,
    ]);
    expect(jobs[2]).toEqual({
      queue: QUEUES.federation,
      name: FEDERATION_JOBS.followerCleanup,
      data: { channelId: A, upTo: r.occurredAt.toISOString() },
      opts: { jobId: `${FEDERATION_JOBS.followerCleanup}-${r.id}` },
    });

    const quiet = reader({ keyCreatedAt, inboxes });
    expect(await b7JobsFor(tx, [toggled(true)], now, on, quiet.fn)).toEqual([]);
    expect(quiet.calls).toEqual([]);
  });

  test("with no followers only the cleanup is queued; with no actor nothing is", async () => {
    const jobs = await b7JobsFor(tx, [toggled(false), disabled()], now, on, reader({ keyCreatedAt, inboxes: [] }).fn);
    expect(jobs.map((j) => j.name)).toEqual([FEDERATION_JOBS.followerCleanup]);
    expect(await b7JobsFor(tx, [toggled(false), disabled()], now, on, reader(null).fn)).toEqual([]);
  });

  test("the instance flag off queues nothing and reads nothing", async () => {
    const { fn, calls } = reader({ keyCreatedAt, inboxes });
    expect(await b7JobsFor(tx, [toggled(false), disabled()], now, off, fn)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("the Delete is stable per channel and key generation: both events, or a repeat, queue it once", async () => {
    const target = { keyCreatedAt, inboxes };
    const jobs = await b7JobsFor(tx, [toggled(false), disabled(), disabled()], now, on, reader(target).fn);
    expect(jobs.map((j) => j.name)).toEqual([
      FEDERATION_JOBS.deliver,
      FEDERATION_JOBS.deliver,
      FEDERATION_JOBS.followerCleanup,
    ]);
    // A later relay of another event for the same generation names the same jobs.
    const again = await b7JobsFor(tx, [disabled()], now, on, reader(target).fn);
    expect(again.map((j) => j.opts.jobId)).toEqual(jobs.slice(0, 2).map((j) => j.opts.jobId));
    // A rotated key is a new generation, so a new Delete.
    const rotated = await actorDeleteJobs("https://air.test", A, { keyCreatedAt: new Date(), inboxes });
    expect(rotated.map((j) => j.opts.jobId)).not.toEqual(again.map((j) => j.opts.jobId));
  });
});
