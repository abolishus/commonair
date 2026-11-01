// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rollup through the real runtime, as `INTERNAL_ROUTES.analyticsTick` drives it: the API adds a
 * `reason: "test"` job on `QUEUES.analytics` and waits for it. The worker's env comes from compose
 * `env_file`, which passes `.env.example`'s blank `INFRA_COST_MODEL=` through as an empty string;
 * the job must read that as the default model (it once threw "must be JSON" and the tick got 504).
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import { ANALYTICS_JOBS, AnalyticsJobResult, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { job as rollupJob } from "../src/jobs/broadcast-rollup.ts";
import { VALKEY_URL, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const saved = process.env.INFRA_COST_MODEL;
beforeAll(async () => {
  process.env.INFRA_COST_MODEL = "";
  env = await setup({ jobs: [rollupJob], outbox: false, segments: false });
  await env.worker.start();
});
afterAll(async () => {
  await env?.close();
  if (saved === undefined) delete process.env.INFRA_COST_MODEL;
  else process.env.INFRA_COST_MODEL = saved;
});

test("a test-hook rollup job completes with a blank INFRA_COST_MODEL", async () => {
  const { channel } = await makeUser(env.t.db);
  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - 120_000);
  const [b] = await env.t.db
    .insert(schema.broadcasts)
    .values({
      id: uuidv7(),
      channelId: channel.id,
      ingestProtocol: "rtmp",
      path: `live/${channel.id}`,
      startedAt,
      endedAt,
    })
    .returning();
  await env.t.db.insert(schema.playbackSessions).values({
    id: uuidv7(),
    channelId: channel.id,
    broadcastId: b!.id,
    deviceHash: crypto.randomUUID(),
    ipHash: crypto.randomUUID(),
    assignedSource: "origin",
    startedAt,
    endedAt,
    verdict: "verified",
    verdictReasons: [],
    scoredAt: startedAt,
  });

  // The same calls as the API's analytics tick runner (services/api/src/ops/analytics-hooks.ts).
  const prefix = `test-bull-${env.tag}`;
  const qc = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
  const ec = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUES.analytics, { connection: qc, prefix });
  const events = new QueueEvents(QUEUES.analytics, { connection: ec, prefix });
  try {
    await events.waitUntilReady();
    const added = await queue.add(
      ANALYTICS_JOBS.broadcastRollup,
      { broadcastId: b!.id, reason: "test", settleSeconds: 0 },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    const out = AnalyticsJobResult.parse(await added.waitUntilFinished(events, 20_000));
    expect(out).toMatchObject({ rolledUp: 1, sessions: 1, verifiedViewerSeconds: 120, costCents: 0 });
  } finally {
    await events.close();
    await queue.close();
    qc.disconnect();
    ec.disconnect();
  }
}, 60_000);
