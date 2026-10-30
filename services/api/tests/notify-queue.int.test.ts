// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The API's producer on `QUEUES.notifications` (N1): the Discord test post lands where the worker consumes it. */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { afterAll, expect, test } from "vite-plus/test";
import { NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { uuidv7 } from "@commonair/db";
import type { Deps } from "../src/deps.ts";
import { closeNotifyQueue, createNotifyQueue, notifyQueue, setNotifyQueue } from "../src/notifications/queue.ts";
import { VALKEY_URL } from "./harness.ts";

const prefix = `test-${crypto.randomUUID()}`;
const conn = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
const reader = new Queue(QUEUES.notifications, { connection: conn, prefix });

afterAll(async () => {
  await reader.obliterate({ force: true });
  await reader.close();
  conn.disconnect();
});

test("a Discord test post is one job per channel and minute, with the job's data", async () => {
  const q = createNotifyQueue(VALKEY_URL, prefix);
  try {
    const channelId = uuidv7();
    const minute = Math.floor(Date.now() / 60_000);
    await q.enqueueDiscordTest(channelId, minute);
    await q.enqueueDiscordTest(channelId, minute);
    const job = await reader.getJob(`discord-test-${channelId}-${minute}`);
    expect(job?.name).toBe(NOTIFY_JOBS.discord);
    expect(job?.data).toEqual({ channelId, eventId: null, broadcastId: null, test: true });
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: "exponential", delay: 60_000 });
    expect(await reader.getJobCounts("waiting")).toEqual({ waiting: 1 });
    // The next minute is another post.
    await q.enqueueDiscordTest(channelId, minute + 1);
    expect(await reader.getJobCounts("waiting")).toEqual({ waiting: 2 });
  } finally {
    await q.close();
  }
});

test("one producer per deps; tests may install their own and close it", async () => {
  const deps = {} as Deps;
  const calls: string[] = [];
  const fake = {
    enqueueDiscordTest: async (id: string) => void calls.push(id),
    close: async () => void calls.push("closed"),
  };
  setNotifyQueue(deps, fake);
  expect(notifyQueue(deps)).toBe(fake);
  await notifyQueue(deps).enqueueDiscordTest("c", 1);
  await closeNotifyQueue(deps);
  await closeNotifyQueue(deps);
  expect(calls).toEqual(["c", "closed"]);
});
