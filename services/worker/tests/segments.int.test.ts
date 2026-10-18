// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { schema, uuidv7 } from "@commonair/db";
import { createValkey } from "@commonair/service";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { minuteBucket } from "../src/segments/aggregate.ts";
import {
  BroadcastCache,
  dropPoison,
  ensureGroup,
  MAX_DELIVERIES,
  processResilient,
  SEGMENT_GROUP,
  startSegmentConsumer,
} from "../src/segments/consumer.ts";
import { makeBroadcast, makeUser, setup, VALKEY_URL, waitFor, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
// Streams are never key-prefixed (see consumer.ts); every test stream name is unique instead.
const raw = createValkey(VALKEY_URL, { name: "worker-test-streams" });
const streams: string[] = [];
const uniqueStream = (kind: string) => {
  const name = `test:stream:segments:${kind}:${crypto.randomUUID()}`;
  streams.push(name);
  return name;
};
beforeAll(async () => {
  // Only the loop under test; the BullMQ jobs and outbox are exercised elsewhere.
  env = await setup({ jobs: [], outbox: false, segments: { blockMs: 100, maintenanceEveryMs: 200, claimIdleMs: 300 } });
  await env.worker.start();
});
afterAll(async () => {
  await raw.del(env.worker.ctx.segmentStream, ...streams);
  await env.close();
  await raw.quit();
});

async function session(channelId: string, broadcastId: string | null) {
  const [s] = await env.t.db
    .insert(schema.playbackSessions)
    .values({ id: uuidv7(), channelId, broadcastId, deviceHash: "d", ipHash: "i" })
    .returning();
  return s!;
}

const xadd = (f: { sid: string; cid: string; src: string; kind: string; bytes: number; at: number }) =>
  raw.xadd(
    env.worker.ctx.segmentStream,
    "*",
    "sid",
    f.sid,
    "cid",
    f.cid,
    "src",
    f.src,
    "kind",
    f.kind,
    "bytes",
    String(f.bytes),
    "at",
    String(f.at),
  );

const egressOf = (broadcastId: string) =>
  env.t.db.select().from(schema.egressSamples).where(eq(schema.egressSamples.broadcastId, broadcastId));
const sessionRow = async (id: string) =>
  (await env.t.db.select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, id)))[0];

describe("segment stream consumer", () => {
  test("aggregates fetches into egress_samples and session counters", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const s1 = await session(channel.id, b.id);
    const s2 = await session(channel.id, b.id);
    const orphan = await session(channel.id, null);
    const t0 = minuteBucket(Date.now()).getTime();
    const pipeline = [];
    for (let i = 0; i < 30; i++)
      pipeline.push(xadd({ sid: s1.id, cid: channel.id, src: "origin", kind: "segment", bytes: 1000, at: t0 + i }));
    for (let i = 0; i < 10; i++)
      pipeline.push(xadd({ sid: s2.id, cid: channel.id, src: "relay", kind: "segment", bytes: 500, at: t0 + i }));
    pipeline.push(xadd({ sid: s2.id, cid: channel.id, src: "origin", kind: "playlist", bytes: 300, at: t0 + 5 }));
    pipeline.push(xadd({ sid: s1.id, cid: channel.id, src: "origin", kind: "segment", bytes: 1000, at: t0 - 60_000 }));
    pipeline.push(xadd({ sid: orphan.id, cid: channel.id, src: "origin", kind: "segment", bytes: 77, at: t0 }));
    pipeline.push(xadd({ sid: "not-a-uuid", cid: channel.id, src: "origin", kind: "segment", bytes: 1, at: t0 }));
    await Promise.all(pipeline);

    const rows = await waitFor(
      async () => {
        const r = await egressOf(b.id);
        const total = r.reduce((n, x) => n + x.requests, 0);
        return total === 42 && r;
      },
      { label: "egress rows" },
    );
    const view = rows.map((r) => `${r.bucketStart.getTime() - t0} ${r.source} ${r.bytes} ${r.requests}`).sort();
    expect(view).toEqual(["-60000 origin 1000 1", "0 origin 30300 31", "0 relay 5000 10"]);

    await waitFor(async () => (await sessionRow(orphan.id))?.segmentsFetched === 1, { label: "orphan counters" });
    expect(await sessionRow(s1.id)).toMatchObject({ segmentsFetched: 31, bytesHttp: 31_000 });
    expect(await sessionRow(s2.id)).toMatchObject({ segmentsFetched: 10, bytesHttp: 5_300 });
    expect(await sessionRow(orphan.id)).toMatchObject({ segmentsFetched: 1, bytesHttp: 77 });

    // Everything was acknowledged, including the malformed entry.
    await waitFor(
      async () => {
        const pending = (await raw.xpending(env.worker.ctx.segmentStream, SEGMENT_GROUP)) as [number];
        return pending[0] === 0;
      },
      { label: "no pending entries" },
    );
  });

  test("a second batch in the same minute adds to the existing rows", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const s = await session(channel.id, b.id);
    const t0 = minuteBucket(Date.now()).getTime();
    await xadd({ sid: s.id, cid: channel.id, src: "cdn", kind: "segment", bytes: 10, at: t0 });
    await waitFor(async () => (await egressOf(b.id))[0]?.requests === 1);
    await xadd({ sid: s.id, cid: channel.id, src: "cdn", kind: "segment", bytes: 15, at: t0 + 1 });
    await waitFor(async () => (await egressOf(b.id))[0]?.requests === 2);
    expect((await egressOf(b.id))[0]?.bytes).toBe(25);
  });

  test("keeps up with 200 viewers × 1 req/s (a minute of traffic in a few seconds)", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const viewers = await Promise.all(Array.from({ length: 200 }, () => session(channel.id, b.id)));
    const t0 = minuteBucket(Date.now()).getTime();
    const started = Date.now();
    for (let s = 0; s < 60; s++) {
      const p = raw.pipeline();
      for (const v of viewers)
        p.xadd(
          env.worker.ctx.segmentStream,
          "*",
          "sid",
          v.id,
          "cid",
          channel.id,
          "src",
          "origin",
          "kind",
          "segment",
          "bytes",
          "1000",
          "at",
          String(t0 + s * 1000),
        );
      await p.exec();
    }
    await waitFor(async () => (await egressOf(b.id)).reduce((n, r) => n + r.requests, 0) === 12_000, {
      label: "12k entries",
      timeoutMs: 30_000,
    });
    // A minute of traffic must drain well within a minute, even on a busy machine.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect((await egressOf(b.id)).reduce((n, r) => n + r.bytes, 0)).toBe(12_000_000);
    expect((await sessionRow(viewers[0]!.id))?.segmentsFetched).toBe(60);
  }, 60_000);

  test("entries left pending by a dead consumer are reclaimed", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const s = await session(channel.id, b.id);
    const t0 = minuteBucket(Date.now()).getTime();
    // A separate stream, so the running consumer does not see the entries first.
    const stream = uniqueStream("reclaim");
    const ctx = { ...env.worker.ctx, segmentStream: stream };
    await ensureGroup(raw, stream);
    for (let i = 0; i < 5; i++)
      await raw.xadd(
        stream,
        "*",
        "sid",
        s.id,
        "cid",
        channel.id,
        "src",
        "origin",
        "kind",
        "segment",
        "bytes",
        "100",
        "at",
        String(t0 + i),
      );
    // "dead" reads the entries and never acknowledges them.
    await raw.xreadgroup("GROUP", SEGMENT_GROUP, "dead", "COUNT", 100, "STREAMS", stream, ">");
    const consumer = startSegmentConsumer(ctx, {
      consumer: "alive",
      blockMs: 100,
      maintenanceEveryMs: 100,
      claimIdleMs: 200,
    });
    try {
      await waitFor(async () => (await egressOf(b.id))[0]?.requests === 5, { label: "reclaimed entries" });
      expect((await egressOf(b.id))[0]?.bytes).toBe(500);
      expect((await sessionRow(s.id))?.segmentsFetched).toBe(5);
    } finally {
      await consumer.stop();
    }
  });

  test("a poison entry does not hold back its batch and is dropped after repeated deliveries", async () => {
    const { channel } = await makeUser(env.t.db);
    const b = await makeBroadcast(env.t.db, channel.id);
    const good = await session(channel.id, b.id);
    const poisoned = await session(channel.id, b.id);
    const stream = uniqueStream("poison");
    const ctx = { ...env.worker.ctx, segmentStream: stream };
    await ensureGroup(raw, stream);
    const t0 = minuteBucket(Date.now()).getTime();
    const add = (sid: string) =>
      raw.xadd(
        stream,
        "*",
        "sid",
        sid,
        "cid",
        channel.id,
        "src",
        "origin",
        "kind",
        "segment",
        "bytes",
        "10",
        "at",
        String(t0),
      );
    await add(good.id);
    const poisonId = await add(poisoned.id);
    await add(good.id);
    // The poisoned session points at a broadcast that does not exist: its egress insert violates the FK.
    const cache = new BroadcastCache();
    cache.set(poisoned.id, uuidv7());
    const read = (await raw.xreadgroup("GROUP", SEGMENT_GROUP, "c1", "COUNT", 10, "STREAMS", stream, ">")) as [
      string,
      [string, string[]][],
    ][];
    const entries = read[0]?.[1] ?? [];
    expect(entries).toHaveLength(3);

    expect(await processResilient(ctx, raw, cache, entries)).toBe(2);
    expect((await egressOf(b.id))[0]?.requests).toBe(2);
    const pendingIds = async () =>
      ((await raw.xpending(stream, SEGMENT_GROUP, "-", "+", 10)) as [string][]).map(([id]) => id);
    expect(await pendingIds()).toEqual([poisonId]);

    // Each reclaim counts as a delivery; below the limit the entry is kept, at the limit it is dropped.
    for (let i = 1; i < MAX_DELIVERIES - 1; i++) await raw.xclaim(stream, SEGMENT_GROUP, "c1", 0, poisonId ?? "");
    const claim = async () =>
      ((await raw.xautoclaim(stream, SEGMENT_GROUP, "c1", 0, "0", "COUNT", 10)) as [string, [string, string[]][]])[1];
    expect(await dropPoison(ctx, raw, await claim())).toHaveLength(0);
    expect(await pendingIds()).toEqual([]);
    expect((await egressOf(b.id))[0]?.requests).toBe(2);
  });

  test("trimming continues while reclaiming fails", async () => {
    const stream = uniqueStream("trim-broken");
    const ctx = { ...env.worker.ctx, segmentStream: stream };
    const consumer = startSegmentConsumer(ctx, { consumer: "trim-broken", blockMs: 50, maintenanceEveryMs: 50 });
    try {
      await waitFor(async () => ((await raw.xinfo("GROUPS", stream).catch(() => [])) as unknown[]).length === 1, {
        label: "group created",
      });
      // Without its group every XAUTOCLAIM/XREADGROUP fails, but old entries must still be trimmed.
      await raw.xgroup("DESTROY", stream, SEGMENT_GROUP);
      const old = Date.now() - 2 * 3_600_000;
      for (let i = 0; i < 200; i++) await raw.xadd(stream, `${old + i}-0`, "sid", "x");
      await raw.xadd(stream, "*", "sid", "x");
      await waitFor(async () => (await raw.xlen(stream)) === 1, { label: "trim despite failures" });
      const entries = await raw.xrange(stream, "-", "+");
      expect(Number(entries[0]?.[0].split("-")[0])).toBeGreaterThan(old + 199);
    } finally {
      await consumer.stop();
    }
  });

  test("the stream is trimmed to the retention window", async () => {
    const stream = uniqueStream("trim");
    const ctx = { ...env.worker.ctx, segmentStream: stream };
    const old = Date.now() - 2 * 3_600_000;
    // Explicit old ids: XTRIM MINID works on entry ids, which are millisecond timestamps.
    for (let i = 0; i < 200; i++) await raw.xadd(stream, `${old + i}-0`, "sid", "x");
    await raw.xadd(stream, "*", "sid", "x");
    const consumer = startSegmentConsumer(ctx, { consumer: "trimmer", blockMs: 50, maintenanceEveryMs: 50 });
    try {
      // "~" trims whole radix-tree nodes (100 entries by default): both old nodes go, the fresh entry stays.
      await waitFor(async () => (await raw.xlen(stream)) === 1, { label: "trim" });
      const entries = await raw.xrange(stream, "-", "+");
      expect(Number(entries[0]?.[0].split("-")[0])).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      await consumer.stop();
    }
  });
});
