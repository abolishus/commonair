// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel owner is not their own audience (ADR 0014 amendment 2026-11-11): the owner's
 * sessions count nowhere, live (the counter, its peak and viewer-seconds) or settled (the rollup's
 * totals and minutes). A signed-out session and another account's still count.
 */
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { refreshViewerCounts, updateLiveCounters } from "../src/counters.ts";
import { rollupBroadcast } from "../src/jobs/broadcast-rollup.ts";
import { makeBroadcast, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());

const MIN = 60_000;
const HOUR = 3_600_000;
const model = { currency: "usd", centsPerGb: { origin: 2, relay: 0.5 } };

async function session(
  channelId: string,
  broadcastId: string,
  over: Partial<typeof schema.playbackSessions.$inferInsert> = {},
) {
  const [s] = await env.t.db
    .insert(schema.playbackSessions)
    .values({
      id: uuidv7(),
      channelId,
      broadcastId,
      deviceHash: crypto.randomUUID(),
      ipHash: crypto.randomUUID(),
      ...over,
    })
    .returning();
  return s!;
}

describe("live counter", () => {
  test("the owner's sessions are left out of the count, the peak and the viewer-seconds", async () => {
    const { user: owner, channel } = await makeUser(env.t.db);
    const { user: fan } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, new Date(Date.now() - 10 * MIN));
    const ids = [
      await session(channel.id, b.id, { userId: owner.id, verdict: "verified" }),
      await session(channel.id, b.id, { userId: owner.id, verdict: "excluded" }),
      await session(channel.id, b.id, { userId: owner.id }),
      await session(channel.id, b.id, { userId: owner.id, verdict: "verified", playbackMode: "dvr" }),
      await session(channel.id, b.id, { verdict: "verified" }),
      await session(channel.id, b.id, { userId: fan.id, verdict: "verified" }),
    ].map((s) => s.id);
    const now = Date.now();
    await env.worker.ctx.valkey.zadd(KEYS.viewers(channel.id), ...ids.flatMap((id) => [now, id]));

    const [c] = (await updateLiveCounters(env.worker.ctx)).filter((x) => x.channelId === channel.id);
    expect(c).toMatchObject({ verified: 2, excluded: 0, pending: 0, catchingUp: 0, elapsedSeconds: 10 });
    expect(await env.worker.ctx.valkey.get(KEYS.viewerCount(channel.id))).toBe("2");
    expect(await env.worker.ctx.valkey.get(KEYS.catchingUpCount(channel.id))).toBe("0");
    const [row] = await env.t.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(row).toMatchObject({ peakVerifiedViewers: 2, verifiedViewerSeconds: 20, excludedViewerSeconds: 0 });

    // The scorer's immediate recount uses the same rule.
    await env.worker.ctx.valkey.del(KEYS.viewerCount(channel.id));
    expect(await refreshViewerCounts(env.worker.ctx, [channel.id])).toBe(1);
    expect(await env.worker.ctx.valkey.get(KEYS.viewerCount(channel.id))).toBe("2");
  });

  test("a channel watched only by its owner publishes zero", async () => {
    const { user: owner, channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, new Date(Date.now() - 10 * MIN));
    const s = await session(channel.id, b.id, { userId: owner.id, verdict: "verified" });
    await env.worker.ctx.valkey.zadd(KEYS.viewers(channel.id), Date.now(), s.id);
    const [c] = (await updateLiveCounters(env.worker.ctx)).filter((x) => x.channelId === channel.id);
    expect(c).toMatchObject({ verified: 0 });
    expect(await env.worker.ctx.valkey.get(KEYS.viewerCount(channel.id))).toBe("0");
    const [row] = await env.t.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(row).toMatchObject({ peakVerifiedViewers: 0, verifiedViewerSeconds: 0 });
  });
});

describe("rollup", () => {
  test("the owner's sessions are left out of the settled totals and minutes", async () => {
    const { user: owner, channel } = await makeUser(env.t.db);
    const { user: fan } = await makeUser(env.t.db);
    const endedAt = new Date(Math.floor((Date.now() - 3 * HOUR) / MIN) * MIN);
    const startedAt = new Date(endedAt.getTime() - HOUR);
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
    const m = (min: number) => new Date(startedAt.getTime() + min * MIN);
    const watched = (start: number, end: number, over: Partial<typeof schema.playbackSessions.$inferInsert>) =>
      session(channel.id, b!.id, { startedAt: m(start), endedAt: m(end), scoredAt: m(start), ...over });
    // The owner watches the whole hour, verified and excluded; a signed-out viewer and a fan 30 min each.
    await watched(0, 60, { userId: owner.id, verdict: "verified" });
    await watched(0, 60, { userId: owner.id, verdict: "excluded", verdictReasons: ["headless"] });
    await watched(0, 30, { verdict: "verified" });
    await watched(0, 30, { userId: fan.id, verdict: "verified" });

    const ctx: WorkerContext = { ...env.worker.ctx, now: () => new Date(), enqueue: async () => undefined };
    const out = await rollupBroadcast(ctx, { broadcastId: b!.id, reason: "offline" }, { costModel: model });
    expect(out).toMatchObject({ rolledUp: 1, sessions: 2, verifiedViewerSeconds: 3600, excludedViewerSeconds: 0 });

    const [t] = await env.t.db
      .select()
      .from(schema.broadcastAudienceTotals)
      .where(eq(schema.broadcastAudienceTotals.broadcastId, b!.id));
    expect(t).toMatchObject({
      sessions: 2,
      verifiedViewerSeconds: 3600,
      excludedViewerSeconds: 0,
      peakVerifiedConcurrent: 2,
    });
    const minutes = await env.t.db
      .select()
      .from(schema.broadcastAudienceMinutes)
      .where(eq(schema.broadcastAudienceMinutes.broadcastId, b!.id))
      .orderBy(asc(schema.broadcastAudienceMinutes.minute));
    expect(minutes[10]).toMatchObject({ verified: 2, excluded: 0 });
    // After the two viewers leave, the owner's half hour adds nothing.
    for (const row of minutes.slice(30)) expect(row.verified + row.unverified + row.excluded).toBe(0);
  });
});
