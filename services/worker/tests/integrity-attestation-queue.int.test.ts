// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The attestation job through the real runtime, as `INTERNAL_ROUTES.analyticsTick` drives it: the
 * key comes from `INTEGRITY_SIGNING_KEY` in the worker's env and the origin from the instance site.
 */
import { generateKeyPairSync } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import { ANALYTICS_JOBS, AnalyticsJobResult, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { importAttestationSigningKey, verify } from "@commonair/tokens/attestation";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { rollupBroadcast } from "../src/jobs/broadcast-rollup.ts";
import { job as attestationJob } from "../src/jobs/integrity-attestation.ts";
import { siteAt } from "./e6-fixtures.ts";
import { VALKEY_URL, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const saved = process.env.INTEGRITY_SIGNING_KEY;
const pkcs8 = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
beforeAll(async () => {
  process.env.INTEGRITY_SIGNING_KEY = pkcs8;
  env = await setup({ jobs: [attestationJob], outbox: false, segments: false, site: siteAt("http://LocalHost:3000/") });
  await env.worker.start();
});
afterAll(async () => {
  await env?.close();
  if (saved === undefined) delete process.env.INTEGRITY_SIGNING_KEY;
  else process.env.INTEGRITY_SIGNING_KEY = saved;
});

test("a test-hook attestation job signs with the env key for the instance origin", async () => {
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
  await rollupBroadcast(
    env.worker.ctx,
    { broadcastId: b!.id, reason: "test", settleSeconds: 0 },
    { costModel: { currency: "usd", centsPerGb: {} } },
  );

  const prefix = `test-bull-${env.tag}`;
  const qc = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
  const ec = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUES.analytics, { connection: qc, prefix });
  const events = new QueueEvents(QUEUES.analytics, { connection: ec, prefix });
  try {
    await events.waitUntilReady();
    const added = await queue.add(
      ANALYTICS_JOBS.integrityAttestation,
      { broadcastId: b!.id, reason: "test" },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    expect(AnalyticsJobResult.parse(await added.waitUntilFinished(events, 20_000))).toMatchObject({ attested: 1 });
  } finally {
    await events.close();
    await queue.close();
    qc.disconnect();
    ec.disconnect();
  }
  const key = await importAttestationSigningKey(pkcs8);
  const [e] = await env.t.db
    .select()
    .from(schema.integrityAttestations)
    .where(eq(schema.integrityAttestations.broadcastId, b!.id));
  expect(e?.kid).toBe(key.kid);
  const r = await verify({ payload: e!.payload, signature: e!.signature }, key.publicKey);
  expect(r.ok && r.statement.origin).toBe("http://localhost:3000");
  expect(r.ok && r.statement.verifiedViewerSeconds).toBe(120);
});
