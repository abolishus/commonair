// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (h) through the real relay: `channel.federation {enabled:false}` reads the actor and its
 * followers in the relay transaction, queues one actor `Delete` per inbox and the follower cleanup,
 * and the cleanup removes only the followers who were there when federation went off.
 */
import { FEDERATION_JOBS, type FederationFollowerCleanupJob, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { EnqueueOptions, WorkerContext } from "../src/context.ts";
import { job as cleanup } from "../src/jobs/federation-follower-cleanup.ts";
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

type Call = { queue: string; name: string; data: unknown; opts?: EnqueueOptions };

async function relay(): Promise<Call[]> {
  const calls: Call[] = [];
  const ctx: WorkerContext = {
    ...env.worker.ctx,
    // Recorded, not queued: the deliveries would try to reach the made-up inboxes.
    enqueueBulk: async (queue, jobs) => {
      for (const j of jobs) calls.push({ queue, ...j });
    },
  };
  while ((await relayOutboxBatch(ctx, 100)) > 0);
  return calls.filter((c) => c.queue === QUEUES.federation);
}

const follower = (channelId: string, host: string, createdAt: Date, sharedInbox: string | null = null) => ({
  id: uuidv7(),
  channelId,
  actorId: `https://${host}/users/x`,
  inbox: `https://${host}/users/x/inbox`,
  sharedInbox,
  domain: host,
  createdAt,
});

test("federation off: one Delete per inbox, then the cleanup removes the followers of that moment", async () => {
  const s = await makeUser(env.t.db);
  const db = env.t.db;
  await db.insert(schema.federationActors).values({
    channelId: s.channel.id,
    enabled: false,
    keyId: `https://air.test/ap/channels/${s.channel.id}#main-key`,
    publicKeyPem: "pem",
    privateKeyEnc: "enc",
  });
  const t0 = Date.now();
  const off = new Date(t0);
  await db.insert(schema.federationFollowers).values([
    follower(s.channel.id, "a.example", new Date(t0 - 2000), "https://a.example/inbox"),
    // Same shared inbox: one delivery for both.
    {
      ...follower(s.channel.id, "a.example", new Date(t0 - 1000), "https://a.example/inbox"),
      actorId: "https://a.example/users/y",
    },
    follower(s.channel.id, "b.example", new Date(t0 - 500)),
    // Arrived after the change (federation back on): neither told nor removed.
    follower(s.channel.id, "c.example", new Date(t0 + 60_000)),
  ]);
  const [e] = await db
    .insert(schema.events)
    .values({
      id: uuidv7(),
      type: "channel.federation",
      channelId: s.channel.id,
      payload: { channel_id: s.channel.id, enabled: false },
      occurredAt: off,
    })
    .returning();

  const calls = await relay();
  expect(calls.map((c) => [c.name, (c.data as { inbox?: string }).inbox ?? null])).toEqual([
    [FEDERATION_JOBS.deliver, "https://a.example/inbox"],
    [FEDERATION_JOBS.deliver, "https://b.example/users/x/inbox"],
    [FEDERATION_JOBS.followerCleanup, null],
  ]);
  const data = calls[2]?.data as FederationFollowerCleanupJob;
  expect(data).toEqual({ channelId: s.channel.id, upTo: off.toISOString() });
  expect(calls[2]?.opts?.jobId).toBe(`${FEDERATION_JOBS.followerCleanup}-${e!.id}`);

  expect(await cleanup.handler(cleanup.data.parse(data), env.worker.ctx, { id: undefined, attemptsMade: 0 })).toEqual({
    removed: 3,
  });
  const left = await db
    .select({ domain: schema.federationFollowers.domain })
    .from(schema.federationFollowers)
    .where(eq(schema.federationFollowers.channelId, s.channel.id));
  expect(left).toEqual([{ domain: "c.example" }]);
});
