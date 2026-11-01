// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The outbox relay's batch 7 wiring (contract step §5.2): internal rows (media state, suspension,
 * the move, the inbox) reach `b7JobsFor` through `relayOutboxBatch`, and the federated-channel
 * gate reads `channels.federation_settings` in the relay transaction. The job bodies are the
 * units'; this checks only what is enqueued, on which queue, with which id.
 */
import { FEDERATION_JOBS, PORTABILITY_JOBS, QUEUES, RELAY_PURGE_JOBS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { EnqueueOptions, WorkerContext } from "../src/context.ts";
import { relayOutboxBatch } from "../src/outbox.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const before = process.env.FEDERATION_ENABLED;
beforeAll(async () => {
  // Read once per process by the hook (`b7OutboxFlags`), so set before the first relay.
  process.env.FEDERATION_ENABLED = "true";
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(async () => {
  process.env.FEDERATION_ENABLED = before;
  await env.close();
});

const B7_QUEUES = new Set<string>([QUEUES.federation, QUEUES.relayPurge, QUEUES.portability]);
type Call = { queue: string; name: string; data: unknown; opts?: EnqueueOptions };

async function relay(): Promise<Call[]> {
  const calls: Call[] = [];
  const ctx: WorkerContext = {
    ...env.worker.ctx,
    enqueueBulk: async (queue, jobs) => {
      for (const j of jobs) calls.push({ queue, ...j });
      await env.worker.ctx.enqueueBulk(queue, jobs);
    },
  };
  while ((await relayOutboxBatch(ctx, 100)) > 0);
  return calls.filter((c) => B7_QUEUES.has(c.queue));
}

async function event(type: string, channelId: string | null, payload: Record<string, unknown>, at: Date) {
  const [e] = await env.t.db
    .insert(schema.events)
    .values({ id: uuidv7(), type, channelId, payload, occurredAt: at })
    .returning();
  return e!;
}

test("internal rows reach the batch 7 hook; fan-out only for federated channels", async () => {
  const fed = await makeUser(env.t.db);
  const plain = await makeUser(env.t.db);
  await env.t.db
    .update(schema.channels)
    .set({ federationSettings: { enabled: true } })
    .where(eq(schema.channels.id, fed.channel.id));
  const t0 = Date.now();
  const at = (i: number) => new Date(t0 + i);
  const vod = { vod_id: uuidv7(), public: false, reason: "moderation" };
  const removed = await event("media.vod.state", fed.channel.id, { ...vod, channel_id: fed.channel.id }, at(0));
  const plainRemoved = await event(
    "media.vod.state",
    plain.channel.id,
    { ...vod, vod_id: uuidv7(), channel_id: plain.channel.id },
    at(1),
  );
  const moved = await event(
    "channel.moved",
    plain.channel.id,
    { channel_id: plain.channel.id, moved_to: "https://elsewhere.example/c" },
    at(2),
  );
  const itemId = uuidv7();
  await event("federation.inbox.received", null, { item_id: itemId }, at(3));
  await event("jury.panel.drawn", null, { panel_id: uuidv7() }, at(4));

  // Enqueued per queue, in the order each queue first appears.
  expect(await relay()).toEqual([
    {
      queue: QUEUES.federation,
      name: FEDERATION_JOBS.fanout,
      data: { eventId: removed.id },
      opts: { jobId: `federation-fanout-${removed.id}` },
    },
    {
      queue: QUEUES.federation,
      name: FEDERATION_JOBS.inbox,
      data: { itemId },
      opts: { jobId: `federation-inbox-${itemId}` },
    },
    {
      queue: QUEUES.relayPurge,
      name: RELAY_PURGE_JOBS.emit,
      data: { eventId: removed.id },
      opts: { jobId: `relay-purge-${removed.id}` },
    },
    {
      queue: QUEUES.relayPurge,
      name: RELAY_PURGE_JOBS.emit,
      data: { eventId: plainRemoved.id },
      opts: { jobId: `relay-purge-${plainRemoved.id}` },
    },
    {
      queue: QUEUES.portability,
      name: PORTABILITY_JOBS.moved,
      data: { channelId: plain.channel.id, eventId: moved.id },
      opts: { jobId: `portability-moved-${moved.id}` },
    },
  ]);
  // Internal rows are marked handled, and a re-relay asks for the same ids.
  const [row] = await env.t.db.select().from(schema.events).where(eq(schema.events.id, moved.id));
  expect(row?.publishedAt).not.toBeNull();
  await env.t.db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, moved.id));
  expect((await relay()).map((c) => c.opts?.jobId)).toEqual([`portability-moved-${moved.id}`]);
});

test("an internal row that fails validation starts nothing", async () => {
  await event("channel.moved", null, { channel_id: "nope" }, new Date());
  expect(await relay()).toEqual([]);
});
