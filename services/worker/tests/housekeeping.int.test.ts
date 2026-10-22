// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { KEYS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import type { ObjectStorage } from "@commonair/storage";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { updateLiveCounters } from "../src/counters.ts";
import {
  closeStalePlaybackSessions,
  enforceVodRetention,
  expireAuthRows,
  markRelaysOffline,
  pruneWebhookDeliveries,
} from "../src/housekeeping.ts";
import { JOBS } from "../src/jobs/index.ts";
import { defineJob } from "../src/runtime/registry.ts";
import { makeBroadcast, makeSubscription, makeUser, setup, waitFor, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const deletedPrefixes: string[] = [];
const failingPrefixes = new Set<string>();
const fakeStorage = {
  async deletePrefix(_bucket: string, prefix: string) {
    if (failingPrefixes.has(prefix)) throw new Error("S3 503");
    deletedPrefixes.push(prefix);
    return 3;
  },
  async delete(_bucket: string, key: string) {
    if (failingPrefixes.has(key)) throw new Error("S3 503");
    deletedKeys.push(key);
  },
} as unknown as ObjectStorage;
const deletedKeys: string[] = [];

// Jobs run on demand only: no loops, no BullMQ workers.
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false, storage: fakeStorage });
});
afterAll(() => env.close());

const ctx = () => env.worker.ctx;
const MIN = 60_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

async function session(
  channelId: string,
  broadcastId: string | null,
  over: Partial<typeof schema.playbackSessions.$inferInsert> = {},
) {
  const [s] = await env.t.db
    .insert(schema.playbackSessions)
    .values({ id: uuidv7(), channelId, broadcastId, deviceHash: "d", ipHash: "i", ...over })
    .returning();
  return s!;
}

describe("live counters", () => {
  test("counts verified sessions, prunes stale members, accumulates peak and viewer-seconds", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id, at(-10 * MIN));
    const v1 = await session(channel.id, b.id, { verdict: "verified" });
    const v2 = await session(channel.id, b.id, { verdict: "verified" });
    const ex = await session(channel.id, b.id, { verdict: "excluded" });
    const pend = await session(channel.id, b.id);
    const ended = await session(channel.id, b.id, { verdict: "verified", endedAt: new Date() });
    const stale = await session(channel.id, b.id, { verdict: "verified" });
    const key = KEYS.viewers(channel.id);
    const now = Date.now();
    await ctx().valkey.zadd(
      key,
      now,
      v1.id,
      now,
      v2.id,
      now,
      ex.id,
      now,
      pend.id,
      now,
      ended.id,
      now - 31_000,
      stale.id,
    );
    await ctx().valkey.zadd(key, now, "garbage");

    const [first] = (await updateLiveCounters(ctx())).filter((c) => c.channelId === channel.id);
    expect(first).toMatchObject({ verified: 2, excluded: 1, pending: 1, elapsedSeconds: 10 });
    expect(await ctx().valkey.get(KEYS.viewerCount(channel.id))).toBe("2");
    expect(await ctx().valkey.zscore(key, stale.id)).toBeNull();
    let [row] = await env.t.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(row).toMatchObject({ peakVerifiedViewers: 2, verifiedViewerSeconds: 20, excludedViewerSeconds: 10 });

    // One viewer leaves: the count drops, the peak stays, seconds keep accumulating.
    await ctx().valkey.zrem(key, v2.id);
    await Bun.sleep(1_100);
    const [second] = (await updateLiveCounters(ctx())).filter((c) => c.channelId === channel.id);
    expect(second?.verified).toBe(1);
    expect(second?.elapsedSeconds).toBeGreaterThan(1);
    expect(second?.elapsedSeconds).toBeLessThanOrEqual(30);
    [row] = await env.t.db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(row?.peakVerifiedViewers).toBe(2);
    expect(row?.verifiedViewerSeconds).toBe(20 + Math.round(second?.elapsedSeconds ?? 0));
    expect(await ctx().valkey.get(KEYS.viewerCount(channel.id))).toBe("1");
  });

  test("ended broadcasts are left alone; empty channels publish zero", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const done = await makeBroadcast(env.t.db, channel.id, at(-60 * MIN));
    await env.t.db
      .update(schema.broadcasts)
      .set({ endedAt: at(-30 * MIN) })
      .where(eq(schema.broadcasts.id, done.id));
    const counts = (await updateLiveCounters(ctx())).filter((c) => c.channelId === channel.id);
    expect(counts.map((c) => c.broadcastId)).toEqual([b.id]);
    expect(await ctx().valkey.get(KEYS.viewerCount(channel.id))).toBe("0");
  });
});

describe("housekeeping", () => {
  test("stale playback sessions are closed at their last heartbeat", async () => {
    const { channel } = await makeUser(env.t.db);
    const hb = at(-3 * MIN);
    const stale = await session(channel.id, null, { lastHeartbeatAt: hb, startedAt: at(-10 * MIN) });
    const neverBeat = await session(channel.id, null, { startedAt: at(-5 * MIN) });
    const fresh = await session(channel.id, null, { lastHeartbeatAt: at(-30_000), startedAt: at(-10 * MIN) });
    const young = await session(channel.id, null, { startedAt: at(-60_000) });
    await ctx().valkey.zadd(KEYS.viewers(channel.id), Date.now(), stale.id, Date.now(), fresh.id);

    const r = await closeStalePlaybackSessions(ctx());
    expect(r.closed).toBeGreaterThanOrEqual(2);
    const get = async (id: string) =>
      (await env.t.db.select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, id)))[0];
    expect((await get(stale.id))?.endedAt?.getTime()).toBe(hb.getTime());
    expect((await get(neverBeat.id))?.endedAt?.getTime()).toBe(neverBeat.startedAt.getTime());
    expect((await get(fresh.id))?.endedAt).toBeNull();
    expect((await get(young.id))?.endedAt).toBeNull();
    expect(await ctx().valkey.zscore(KEYS.viewers(channel.id), stale.id)).toBeNull();
    expect(await ctx().valkey.zscore(KEYS.viewers(channel.id), fresh.id)).not.toBeNull();
    expect((await closeStalePlaybackSessions(ctx())).closed).toBe(0);
  });

  test("relays that missed heartbeats go offline with an audit row", async () => {
    const { user } = await makeUser(env.t.db);
    const relay = async (status: "active" | "degraded" | "pending" | "suspended", lastHealthAt: Date | null) => {
      const [r] = await env.t.db
        .insert(schema.relayNodes)
        .values({
          id: uuidv7(),
          ownerId: user.id,
          name: "r",
          publicUrl: "https://relay.example.test",
          declaredCapacityMbps: 100,
          publicKey: "k",
          tokenHash: await sha256Hex(randomSecret()),
          status,
          lastHealthAt,
        })
        .returning();
      return r!;
    };
    const dead = await relay("active", at(-10 * MIN));
    const degraded = await relay("degraded", at(-4 * MIN));
    const alive = await relay("active", at(-30_000));
    const pending = await relay("pending", null);
    const suspended = await relay("suspended", at(-60 * MIN));
    await ctx().valkey.hset(KEYS.relays, dead.id, "{}", alive.id, "{}");

    expect((await markRelaysOffline(ctx())).offline).toBe(2);
    const status = async (id: string) =>
      (await env.t.db.select().from(schema.relayNodes).where(eq(schema.relayNodes.id, id)))[0]?.status;
    expect(await status(dead.id)).toBe("offline");
    expect(await status(degraded.id)).toBe("offline");
    expect(await status(alive.id)).toBe("active");
    expect(await status(pending.id)).toBe("pending");
    expect(await status(suspended.id)).toBe("suspended");
    const audits = await env.t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "relay.offline"), eq(schema.auditLog.subjectId, dead.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", subjectType: "relay_node", reason: "missed heartbeats" });
    expect(await ctx().valkey.hexists(KEYS.relays, dead.id)).toBe(0);
    expect(await ctx().valkey.hexists(KEYS.relays, alive.id)).toBe(1);
  });

  test("expired verifications and auth sessions are deleted", async () => {
    const { user } = await makeUser(env.t.db);
    const ver = (expiresAt: Date) => ({ id: uuidv7(), identifier: "x", value: "y", expiresAt });
    await env.t.db.insert(schema.verifications).values([ver(at(-MIN)), ver(at(MIN))]);
    await env.t.db.insert(schema.sessions).values([
      { id: uuidv7(), userId: user.id, token: randomSecret(), expiresAt: at(-MIN) },
      { id: uuidv7(), userId: user.id, token: randomSecret(), expiresAt: at(60 * MIN) },
    ]);
    const r = await expireAuthRows(ctx());
    expect(r).toEqual({ verifications: 1, sessions: 1 });
    expect(await env.t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.id))).toHaveLength(1);
  });

  test("webhook deliveries older than 30 days are pruned", async () => {
    const { user } = await makeUser(env.t.db);
    const sub = await makeSubscription(env.t.db, {
      userId: user.id,
      type: "stream.online",
      condition: {},
      callbackUrl: "https://hooks.example.test/",
      secret: "secret-secret",
    });
    const row = (createdAt: Date) => ({
      id: uuidv7(),
      subscriptionId: sub.id,
      eventId: uuidv7(),
      messageId: "m",
      createdAt,
    });
    await env.t.db
      .insert(schema.webhookDeliveries)
      .values([row(at(-31 * 24 * 60 * MIN)), row(at(-29 * 24 * 60 * MIN))]);
    expect(await pruneWebhookDeliveries(ctx())).toEqual({ deleted: 1 });
  });

  test("expired VODs lose their objects and become deleted; failures are retried later", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const vod = async (prefixOf: (id: string) => string, expiresAt: Date | null) => {
      const id = uuidv7();
      const [v] = await env.t.db
        .insert(schema.vods)
        .values({
          id,
          broadcastId: b.id,
          channelId: channel.id,
          title: "v",
          storagePrefix: prefixOf(id),
          expiresAt,
          status: "ready",
        })
        .returning();
      return v!;
    };
    const own = (id: string) => `vods/${id}/`;
    const expired = await vod(own, at(-MIN));
    const broken = await vod(own, at(-MIN));
    failingPrefixes.add(`vods/${broken.id}/`);
    const keep = await vod(own, at(60 * MIN));
    const forever = await vod(own, null);
    // Prefixes that are not exactly vods/<own id>/ are refused, never passed to storage.
    const other = await vod(() => `vods/${keep.id}/`, at(-MIN));
    const blank = await vod(() => "", at(-MIN));
    const root = await vod(() => "vods/", at(-MIN));
    const noSlash = await vod((id) => `vods/${id}`, at(-MIN));
    const nested = await vod((id) => `vods/${id}/../`, at(-MIN));
    const elsewhere = await vod((id) => `clips/${id}/`, at(-MIN));

    const r = await enforceVodRetention(ctx());
    expect(r).toEqual({ deleted: 1, failed: 7, objects: 3, held: 0, clipsDeleted: 0 });
    expect(deletedPrefixes).toEqual([`vods/${expired.id}/`]);
    const status = async (id: string) => (await env.t.db.select().from(schema.vods).where(eq(schema.vods.id, id)))[0];
    expect(await status(expired.id)).toMatchObject({ status: "deleted", removedReason: "retention" });
    for (const v of [broken, keep, forever, other, blank, root, noSlash, nested, elsewhere])
      expect((await status(v.id))?.status).toBe("ready");

    // The storage failure is retried on the next run and then succeeds.
    failingPrefixes.clear();
    expect(await enforceVodRetention(ctx())).toMatchObject({ deleted: 1 });
    expect((await status(broken.id))?.status).toBe("deleted");
    // Refused rows stay refused; clean them up so later runs in this file start empty.
    await env.t.db.delete(schema.vods).where(eq(schema.vods.channelId, channel.id));
  });

  test("owner-removed VODs and removed clips are purged unless the owner is under a legal hold", async () => {
    deletedPrefixes.length = 0;
    deletedKeys.length = 0;
    const purge = async (held: boolean) => {
      const { user, channel } = await makeUser(env.t.db);
      if (held)
        await env.t.db
          .insert(schema.legalHolds)
          .values({ userId: user.id, reasonCode: "law_enforcement", reason: "preservation request" });
      const b = await makeBroadcast(env.t.db, channel.id);
      const vodId = uuidv7();
      // vods.remove: removed_reason 'owner' and expires_at = now().
      await env.t.db.insert(schema.vods).values({
        id: vodId,
        broadcastId: b.id,
        channelId: channel.id,
        title: "v",
        storagePrefix: `vods/${vodId}/`,
        status: "ready",
        removedReason: "owner",
        expiresAt: at(-1000),
      });
      const clip = async (removedReason: string | null, keys: (id: string) => [string | null, string | null]) => {
        const id = uuidv7();
        const [storageKey, thumbnailKey] = keys(id);
        await env.t.db.insert(schema.clips).values({
          id,
          channelId: channel.id,
          broadcastId: b.id,
          vodId,
          title: "c",
          startOffset: 0,
          durationSeconds: 10,
          status: "ready",
          storageKey,
          thumbnailKey,
          removedReason,
        });
        return id;
      };
      const own = (id: string): [string, string] => [`clips/${id}.mp4`, `clips/${id}.webp`];
      return {
        vodId,
        byOwner: await clip("owner", own),
        byCreator: await clip("creator", (id) => [`clips/${id}.mp4`, null]),
        live: await clip(null, own),
        moderated: await clip("moderation", own),
        tampered: await clip("owner", (id) => [`clips/${id}.mp4`, `vods/${vodId}/index.m3u8`]),
      };
    };
    const free = await purge(false);
    const held = await purge(true);

    const r = await enforceVodRetention(ctx());
    // Held: the owner's VOD and both removed clips (and the tampered one) are counted, not deleted.
    expect(r).toEqual({ deleted: 1, failed: 1, objects: 3 + 3, held: 1 + 3, clipsDeleted: 2 });
    expect(deletedPrefixes).toEqual([`vods/${free.vodId}/`]);
    expect(deletedKeys.sort()).toEqual(
      [`clips/${free.byOwner}.mp4`, `clips/${free.byOwner}.webp`, `clips/${free.byCreator}.mp4`].sort(),
    );
    const vod = async (id: string) => (await env.t.db.select().from(schema.vods).where(eq(schema.vods.id, id)))[0];
    const clip = async (id: string) => (await env.t.db.select().from(schema.clips).where(eq(schema.clips.id, id)))[0];
    expect(await vod(free.vodId)).toMatchObject({ status: "deleted", removedReason: "owner" });
    expect((await clip(free.byOwner))?.status).toBe("deleted");
    expect((await clip(free.byCreator))?.status).toBe("deleted");
    for (const id of [free.live, free.moderated, free.tampered]) expect((await clip(id))?.status).toBe("ready");
    expect(await vod(held.vodId)).toMatchObject({ status: "ready", removedReason: "owner" });
    for (const id of [held.byOwner, held.byCreator, held.live, held.tampered])
      expect((await clip(id))?.status).toBe("ready");
  });
});

describe("runtime", () => {
  test("registers schedulers, removes stale ones, runs scheduled and enqueued jobs", async () => {
    const t = await setup({ jobs: [], outbox: false, segments: false });
    try {
      // A scheduler left over from an older deployment must be removed on start.
      await t.worker.runtime
        .queue(QUEUES.retention)
        .upsertJobScheduler("obsolete", { every: 60_000 }, { name: "obsolete" });
      const ran: string[] = [];
      const fast = defineJob({
        queue: QUEUES.retention,
        name: "tick",
        description: "test",
        data: z.object({}),
        schedule: { every: 1_000 },
        handler: async () => {
          ran.push("tick");
        },
      });
      const echo = defineJob({
        queue: QUEUES.integrity,
        name: "echo",
        description: "test",
        data: z.object({ n: z.number() }),
        handler: async ({ n }) => {
          ran.push(`echo:${n}`);
        },
      });
      const t2 = await setup({ jobs: [fast, echo], outbox: false, segments: false, bullPrefix: `test-bull-${t.tag}` });
      try {
        await t2.worker.start();
        const ids = (await t2.worker.runtime.queue(QUEUES.retention).getJobSchedulers()).map((s) => s.id ?? s.key);
        expect(ids).toEqual(["tick"]);
        await t2.worker.ctx.enqueue(QUEUES.integrity, "echo", { n: 7 });
        await expect(t2.worker.ctx.enqueue(QUEUES.integrity, "echo", { n: "x" })).rejects.toThrow(/expected number/);
        await waitFor(async () => ran.includes("tick") && ran.includes("echo:7"), { label: "jobs ran" });
        expect(await t2.worker.runtime.depth()).toMatchObject({ [QUEUES.integrity]: 0 });
      } finally {
        await t2.close();
      }
    } finally {
      await t.close();
    }
  });

  test("the production registry starts against an isolated prefix", async () => {
    const t = await setup({ jobs: JOBS, outbox: false, segments: false });
    try {
      await t.worker.start();
      const integrity = (await t.worker.runtime.queue(QUEUES.integrity).getJobSchedulers()).map((s) => s.id ?? s.key);
      expect(integrity.sort()).toEqual([
        "close-stale-sessions",
        "follow-bursts",
        "live-counters",
        "relays-offline",
        "score-sessions",
        "stream-hours",
        "verify-receipts",
      ]);
      for (const check of Object.values(t.worker.checks)) await check();
    } finally {
      await t.close();
    }
  });
});
