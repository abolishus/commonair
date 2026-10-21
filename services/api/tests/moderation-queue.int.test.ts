// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The real BullMQ producer: jobs the API enqueues land on `QUEUES.moderation` where the worker
 * consumes them. Regression: `bullmq` was not a dependency of the API, so every enqueue (T0 upload,
 * legal escalation, NCII hash) failed at runtime while tests used the in-memory queue.
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { afterAll, expect, test } from "vite-plus/test";
import { MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { uuidv7 } from "@commonair/db";
import { createModerationQueue, nciiHashJobId } from "../src/moderation/queue.ts";
import { VALKEY_URL } from "./harness.ts";

const prefix = `test-${crypto.randomUUID()}`;
const conn = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
const reader = new Queue(QUEUES.moderation, { connection: conn, prefix });

afterAll(async () => {
  await reader.obliterate({ force: true });
  await reader.close();
  conn.disconnect();
});

test("an enqueued job is on the moderation queue, durable and idempotent by id", async () => {
  const q = await createModerationQueue(VALKEY_URL, prefix);
  try {
    const requestId = uuidv7();
    await q.nciiHash({ requestId });
    await q.nciiHash({ requestId });
    const job = await reader.getJob(nciiHashJobId(requestId));
    expect(job?.name).toBe(MODERATION_JOBS.nciiHash);
    expect(job?.data).toEqual({ requestId });
    expect(job?.opts.attempts).toBe(50);
    expect(await reader.getJobCounts("waiting")).toEqual({ waiting: 1 });
  } finally {
    await q.close();
  }
});
