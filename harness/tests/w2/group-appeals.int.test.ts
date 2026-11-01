// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `readGroup` and `readVerdicts` on Bun.SQL against a real database: the array parameter goes
 * through `sql.array`, and the rollup time comes back as epoch milliseconds (wave-1 CI lessons).
 */
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { readGroup, readVerdicts } from "../../src/w2/group-appeals.ts";

let t: TestDatabase;
let h: DbHandle;
const owner = uuidv7();
const channelId = uuidv7();
const broadcastId = uuidv7();
const endedAt = new Date("2026-10-31T12:34:56.789Z");
const startedAt = new Date(endedAt.getTime() - 600_000);
const rolledUpAt = new Date("2026-10-31T14:00:00.123Z");
const dc = [uuidv7(), uuidv7()];
const auto = uuidv7();
const ok = uuidv7();

beforeAll(async () => {
  t = await createTestDatabase();
  h = createDb({ url: t.url, max: 1 });
  await h.db.insert(schema.users).values({ id: owner, name: "w2 ga", email: "w2ga@example.test", username: "w2ga" });
  await h.db.insert(schema.channels).values({ id: channelId, ownerId: owner, slug: "w2ga", displayName: "w2ga" });
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
      session(dc[0] as string, "excluded", ["datacenter_ip"]),
      session(dc[1] as string, "excluded", ["datacenter_ip", "headless"]),
      session(auto, "excluded", ["headless", "datacenter_ip"]),
      session(ok, "verified", ["allowed_on_appeal"]),
    ]);
  await h.db.insert(schema.broadcastAudienceTotals).values({
    broadcastId,
    channelId,
    durationSeconds: 600,
    sessions: 4,
    peakVerifiedConcurrent: 1,
    verifiedViewerSeconds: 60,
    unverifiedViewerSeconds: 0,
    excludedViewerSeconds: 180,
    excludedSessionsByCategory: { automation: 1, datacenter: 2 },
    excludedSecondsByCategory: { automation: 60, datacenter: 120 },
    rolledUpAt,
  });
}, 120_000);
afterAll(async () => {
  await h?.close();
  await t?.drop();
});

describe("readGroup", () => {
  test("the category's excluded sessions by first reason, and the rollup row", async () => {
    const g = await readGroup(t.url, broadcastId, "datacenter");
    expect(g.sessionIds.sort()).toEqual([...dc].sort());
    // With their stored reasons, for the overturn's expected outcome.
    expect(g.sessions.map((x) => x.id).sort()).toEqual([...dc].sort());
    expect(g.sessions.every((x) => x.verdict === "excluded" && x.reasons?.[0] === "datacenter_ip")).toBe(true);
    expect(g.rollup).toEqual({
      rolledUpAtMs: rolledUpAt.getTime(),
      verified: 60,
      excluded: 180,
      bySessions: { automation: 1, datacenter: 2 },
    });
    expect((await readGroup(t.url, broadcastId, "automation")).sessionIds).toEqual([auto]);
    const none = await readGroup(t.url, uuidv7(), "datacenter");
    expect(none).toEqual({ sessions: [], sessionIds: [], rollup: null });
  });
});

describe("readVerdicts", () => {
  test("binds the ids as a uuid array, empty included", async () => {
    const v = await readVerdicts(t.url, [ok, auto]);
    const byId = Object.fromEntries(v.map((r) => [r.id, [r.verdict, r.reasons]]));
    expect(v).toHaveLength(2);
    expect(byId).toEqual({
      [ok]: ["verified", ["allowed_on_appeal"]],
      [auto]: ["excluded", ["headless", "datacenter_ip"]],
    });
    expect(await readVerdicts(t.url, [])).toEqual([]);
  });
});
