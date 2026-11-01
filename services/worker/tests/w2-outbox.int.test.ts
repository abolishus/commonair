// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The outbox relay's W2 job wiring (batch 6 contract step §5): the delayed rollup on
 * `stream.offline` (never for a rehearsal), the attestation on `analytics.rollup.ready`, the
 * re-score rollup and the rehearsal driver. The job bodies are the units'; this checks only what
 * is enqueued, on which queue, with which id and delay.
 */
import { ANALYTICS_JOBS, analyticsJobId, QUEUES, REHEARSAL_JOBS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { AUDIENCE_SETTLE_SECONDS } from "@commonair/integrity";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { EnqueueOptions, WorkerContext } from "../src/context.ts";
import { relayOutboxBatch } from "../src/outbox.ts";
import { rehearsalDriverJobId } from "../src/w2/outbox-jobs.ts";
import { broadcasterFields, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(async () => {
  await env.close();
});

type Call = { queue: string; name: string; data: unknown; opts?: EnqueueOptions };

/** Relay everything pending through a context whose enqueues are recorded (and still sent). */
async function relay(now: Date): Promise<Call[]> {
  const calls: Call[] = [];
  const ctx: WorkerContext = {
    ...env.worker.ctx,
    now: () => now,
    enqueueBulk: async (queue, jobs) => {
      for (const j of jobs) calls.push({ queue, ...j });
      await env.worker.ctx.enqueueBulk(queue, jobs);
    },
  };
  while ((await relayOutboxBatch(ctx, 100)) > 0);
  return calls.filter((c) => c.queue === QUEUES.analytics || c.queue === QUEUES.rehearsal);
}

async function event(type: string, channelId: string | null, payload: Record<string, unknown>, occurredAt: Date) {
  const [e] = await env.t.db
    .insert(schema.events)
    .values({ id: uuidv7(), type, channelId, payload, occurredAt })
    .returning();
  return e!;
}

async function endedBroadcast(channelId: string, endedAt: Date, kind: "live" | "rehearsal" = "live") {
  const startedAt = new Date(endedAt.getTime() - 3_600_000);
  // A broadcast's kind is fixed at insert (0043 trigger), so a rehearsal is inserted as one.
  const [b] = await env.t.db
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId, ingestProtocol: "rtmp", path: `live/${channelId}`, startedAt, endedAt, kind })
    .returning();
  return b!;
}

test("stream.offline enqueues the rollup once, delayed until the settle time after the broadcast ended", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const endedAt = new Date(Date.now() - 1000);
  const b = await endedBroadcast(channel.id, endedAt);
  const e = await event("stream.offline", channel.id, broadcasterFields(user), endedAt);
  const now = new Date(endedAt.getTime() + 5000);
  const jobId = analyticsJobId(ANALYTICS_JOBS.broadcastRollup, b.id, "offline");
  expect(await relay(now)).toEqual([
    {
      queue: QUEUES.analytics,
      name: ANALYTICS_JOBS.broadcastRollup,
      data: { broadcastId: b.id, reason: "offline" },
      opts: { jobId, delayMs: AUDIENCE_SETTLE_SECONDS * 1000 - 5000 },
    },
  ]);
  // At-least-once: a re-relayed row asks for the same job id (BullMQ drops the duplicate).
  await env.t.db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, e.id));
  const again = await relay(now);
  expect(again.map((c) => c.opts?.jobId)).toEqual([jobId]);
});

test("a late relay never enqueues a negative delay", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const endedAt = new Date(Date.now() - 1000);
  await endedBroadcast(channel.id, endedAt);
  await event("stream.offline", channel.id, broadcasterFields(user), endedAt);
  const [c] = await relay(new Date(endedAt.getTime() + (AUDIENCE_SETTLE_SECONDS + 60) * 1000));
  expect(c?.opts?.delayMs).toBe(0);
});

test("no rollup for a rehearsal, or for an offline event no broadcast ended with", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const endedAt = new Date(Date.now() - 1000);
  await endedBroadcast(channel.id, endedAt, "rehearsal");
  await event("stream.offline", channel.id, broadcasterFields(user), endedAt);
  expect(await relay(new Date())).toEqual([]);

  const other = await makeUser(env.t.db);
  // Its last broadcast ended an hour before the event: the event is not about it.
  await endedBroadcast(other.channel.id, new Date(endedAt.getTime() - 3_600_000));
  await event("stream.offline", other.channel.id, broadcasterFields(other.user), endedAt);
  expect(await relay(new Date())).toEqual([]);
});

test("analytics.rollup.ready enqueues the attestation, one job per event", async () => {
  const { channel } = await makeUser(env.t.db);
  const broadcastId = uuidv7();
  const now = new Date();
  const e1 = await event(
    "analytics.rollup.ready",
    channel.id,
    { broadcast_id: broadcastId, channel_id: channel.id, reason: "offline" },
    now,
  );
  const e2 = await event(
    "analytics.rollup.ready",
    channel.id,
    { broadcast_id: broadcastId, channel_id: channel.id, reason: "rescore" },
    new Date(now.getTime() + 1),
  );
  expect(await relay(now)).toEqual([
    {
      queue: QUEUES.analytics,
      name: ANALYTICS_JOBS.integrityAttestation,
      data: { broadcastId, reason: "rollup" },
      opts: { jobId: analyticsJobId(ANALYTICS_JOBS.integrityAttestation, broadcastId, `rollup-${e1.id}`) },
    },
    {
      queue: QUEUES.analytics,
      name: ANALYTICS_JOBS.integrityAttestation,
      data: { broadcastId, reason: "recheck" },
      opts: { jobId: analyticsJobId(ANALYTICS_JOBS.integrityAttestation, broadcastId, `recheck-${e2.id}`) },
    },
  ]);
});

test("integrity.sessions.rescored re-runs the rollup now; rehearsal.armed starts the driver", async () => {
  const { channel } = await makeUser(env.t.db);
  const broadcastId = uuidv7();
  const armId = uuidv7();
  const now = new Date();
  const r = await event(
    "integrity.sessions.rescored",
    channel.id,
    { broadcast_id: broadcastId, channel_id: channel.id, sessions: 12 },
    now,
  );
  await event(
    "rehearsal.armed",
    channel.id,
    { channel_id: channel.id, arm_id: armId, expires_at: new Date(now.getTime() + 600_000).toISOString() },
    new Date(now.getTime() + 1),
  );
  expect(await relay(now)).toEqual([
    {
      queue: QUEUES.analytics,
      name: ANALYTICS_JOBS.broadcastRollup,
      data: { broadcastId, reason: "rescore" },
      opts: { jobId: analyticsJobId(ANALYTICS_JOBS.broadcastRollup, broadcastId, `rescore-${r.id}`) },
    },
    {
      queue: QUEUES.rehearsal,
      name: REHEARSAL_JOBS.driver,
      data: { armId, channelId: channel.id },
      opts: { jobId: rehearsalDriverJobId(armId) },
    },
  ]);
  // The internal events never reach the bus, and are marked handled.
  const pending = await env.t.db.select().from(schema.events).where(eq(schema.events.id, r.id));
  expect(pending[0]?.publishedAt).not.toBeNull();
});

test("integrity.key.compromised re-checks every broadcast it names", async () => {
  const b1 = uuidv7();
  const b2 = uuidv7();
  const kid = "k_test";
  await event("integrity.key.compromised", null, { kid, broadcast_ids: [b1, b2] }, new Date());
  expect(await relay(new Date())).toEqual(
    [b1, b2].map((broadcastId) => ({
      queue: QUEUES.analytics,
      name: ANALYTICS_JOBS.integrityAttestation,
      data: { broadcastId, reason: "recheck" },
      opts: { jobId: analyticsJobId(ANALYTICS_JOBS.integrityAttestation, broadcastId, `reissue-${kid}`) },
    })),
  );
});

test("an internal event that fails validation starts nothing", async () => {
  const { channel } = await makeUser(env.t.db);
  await event("analytics.rollup.ready", channel.id, { broadcast_id: "nope" }, new Date());
  expect(await relay(new Date())).toEqual([]);
});
