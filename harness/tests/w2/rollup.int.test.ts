// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `readRollup` on Bun.SQL: the swarm ids are an array parameter, which Bun.SQL bound as joined text
 * (`malformed array literal: ""`, CI run 41291975172, integrity-basic "read the rollup and the
 * verdicts"), with an empty swarm and with a real one.
 */
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { readRollup } from "../../src/w2/rollup.ts";

let t: TestDatabase;
let h: DbHandle;
const owner = uuidv7();
const channelId = uuidv7();
const broadcastId = uuidv7();
const endedAt = new Date("2026-10-31T12:34:56.789Z");
const startedAt = new Date(endedAt.getTime() - 600_000);
const swarm = [uuidv7(), uuidv7()];
const honest = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  h = createDb({ url: t.url, max: 1 });
  await h.db
    .insert(schema.users)
    .values({ id: owner, name: "w2 rollup", email: "w2rollup@example.test", username: "w2rollup" });
  await h.db
    .insert(schema.channels)
    .values({ id: channelId, ownerId: owner, slug: "w2rollup", displayName: "w2rollup" });
  await h.db.insert(schema.broadcasts).values({
    id: broadcastId,
    channelId,
    ingestProtocol: "rtmp",
    path: `live/${uuidv7()}`,
    startedAt,
    endedAt,
  });
  const session = (id: string, verdict: "excluded" | "verified", reasons: string[]) => ({
    id,
    channelId,
    broadcastId,
    deviceHash: `d-${id}`,
    ipHash: `i-${id}`,
    startedAt: new Date(startedAt.getTime() + 60_000),
    endedAt: new Date(startedAt.getTime() + 120_000),
    verdict,
    verdictReasons: reasons,
  });
  await h.db
    .insert(schema.playbackSessions)
    .values([
      session(swarm[0] as string, "excluded", ["headless", "datacenter_ip"]),
      session(swarm[1] as string, "excluded", ["datacenter_ip"]),
      session(honest, "verified", []),
    ]);
  await h.db.insert(schema.broadcastAudienceTotals).values({
    broadcastId,
    channelId,
    durationSeconds: 600,
    sessions: 3,
    peakVerifiedConcurrent: 1,
    verifiedViewerSeconds: 60,
    unverifiedViewerSeconds: 0,
    excludedViewerSeconds: 120,
    excludedSessionsByCategory: { automation: 1, datacenter: 1 },
    excludedSecondsByCategory: { automation: 60, datacenter: 60 },
  });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await t?.drop();
});

describe("readRollup", () => {
  test("counts the swarm's excluded sessions and their first-reason categories", async () => {
    const r = await readRollup(t.url, broadcastId, swarm);
    expect(r.totals).toEqual({
      sessions: 3,
      verified: 60,
      unverified: 0,
      excluded: 120,
      bySessions: { automation: 1, datacenter: 1 },
      bySeconds: { automation: 60, datacenter: 60 },
    });
    expect(r.verdicts).toEqual({ sessions: 3, excluded: 2, swarmExcluded: 2 });
    expect(r.swarmCategories).toEqual({ automation: 1, datacenter: 1 });
  });

  test("an empty swarm binds as an empty array", async () => {
    const r = await readRollup(t.url, broadcastId, []);
    expect(r.verdicts).toEqual({ sessions: 3, excluded: 2, swarmExcluded: 0 });
    expect(r.swarmCategories).toEqual({});
  });

  test("a broadcast without a rollup row reads as null", async () => {
    const r = await readRollup(t.url, uuidv7(), swarm);
    expect(r.totals).toBeNull();
    expect(r.verdicts).toEqual({ sessions: 0, excluded: 0, swarmExcluded: 0 });
  });
});
