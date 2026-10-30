// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { BusEvent } from "@commonair/contracts/events";
import { QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { createValkey } from "@commonair/service";
import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { relayOutboxBatch } from "../src/outbox.ts";
import { broadcasterFields, insertEvent, makeUser, setup, VALKEY_URL, waitFor, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const seen: string[] = [];
const subscriber = createValkey(VALKEY_URL, { name: "worker-test-outbox-sub" });

beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
  await subscriber.subscribe(env.worker.ctx.busChannel);
  subscriber.on("message", (_c, m) => seen.push(BusEvent.parse(JSON.parse(m)).id));
});
afterAll(async () => {
  await subscriber.quit();
  await env.close();
});

test("concurrent relays (replicas) claim disjoint rows: every event is published exactly once", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const ids: string[] = [];
  for (let i = 0; i < 120; i++)
    ids.push((await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user))).id);

  // Four "replicas" draining in parallel with small batches.
  const drain = async () => {
    let total = 0;
    for (;;) {
      const n = await relayOutboxBatch(env.worker.ctx, 7);
      if (n === 0) return total;
      total += n;
    }
  };
  const totals = await Promise.all([drain(), drain(), drain(), drain()]);
  expect(totals.reduce((a, b) => a + b, 0)).toBe(120);
  await waitFor(async () => seen.length >= 120, { label: "all published" });
  await Bun.sleep(100);
  expect(seen).toHaveLength(120);
  expect(new Set(seen)).toEqual(new Set(ids));
  expect(await env.t.db.select().from(schema.events).where(isNull(schema.events.publishedAt))).toHaveLength(0);
});

test("events are published in occurrence order within a relay", async () => {
  const { user, channel } = await makeUser(env.t.db);
  seen.length = 0;
  const ids: string[] = [];
  for (let i = 0; i < 10; i++)
    ids.push((await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user))).id);
  expect(await relayOutboxBatch(env.worker.ctx, 100)).toBe(10);
  await waitFor(async () => seen.length === 10);
  expect(seen).toEqual(ids);
});

test("a hung Valkey/BullMQ call times out, rolls back and releases the row locks", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const e = await insertEvent(env.t.db, "stream.offline", channel.id, broadcasterFields(user));
  const hung = { ...env.worker.ctx, enqueueBulk: () => new Promise<void>(() => {}) };
  await expect(relayOutboxBatch(hung, 100, 200)).rejects.toThrow(/fan-out enqueue timed out/);
  const [row] = await env.t.db.select().from(schema.events).where(eq(schema.events.id, e.id));
  expect(row?.publishedAt).toBeNull();
  // The lock is gone: a healthy relay claims and publishes the same row right away.
  expect(await relayOutboxBatch(env.worker.ctx, 100)).toBeGreaterThanOrEqual(1);
  await waitFor(async () => seen.includes(e.id), { label: "republished" });
});

test("N1: a stream.online with no webhook subscription starts one go-live fan-out; a re-relay adds none", async () => {
  const { user, channel } = await makeUser(env.t.db);
  const calls: { queue: string; jobs: readonly { name: string; data: unknown; opts?: { jobId?: string } }[] }[] = [];
  const spy = {
    ...env.worker.ctx,
    enqueueBulk: async (
      queue: Parameters<typeof env.worker.ctx.enqueueBulk>[0],
      jobs: Parameters<typeof env.worker.ctx.enqueueBulk>[1],
    ) => {
      calls.push({ queue, jobs });
      await env.worker.ctx.enqueueBulk(queue, jobs);
    },
  };
  const depth = async () => (await env.worker.runtime.depth())[QUEUES.notifications] ?? 0;
  const before = await depth();
  const e = await insertEvent(env.t.db, "stream.online", channel.id, {
    ...broadcasterFields(user),
    id: uuidv7(),
    type: "live",
    started_at: new Date().toISOString(),
  });
  await relayOutboxBatch(spy, 100);
  const notify = calls.filter((c) => c.queue === QUEUES.notifications);
  expect(notify).toEqual([
    {
      queue: QUEUES.notifications,
      jobs: [{ name: "go-live", data: { eventId: e.id, after: null }, opts: { jobId: `go-live-${e.id}` } }],
    },
  ]);
  // No subscription: the webhook fan-out enqueue carries nothing.
  expect(calls.filter((c) => c.queue === QUEUES.webhooks).flatMap((c) => c.jobs)).toEqual([]);
  expect(await depth()).toBe(before + 1);

  // At-least-once: the same row relayed again enqueues under the same job id, which BullMQ drops.
  await env.t.db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, e.id));
  await relayOutboxBatch(spy, 100);
  expect(calls.filter((c) => c.queue === QUEUES.notifications)).toHaveLength(2);
  expect(await depth()).toBe(before + 1);
});
