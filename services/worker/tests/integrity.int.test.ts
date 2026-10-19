// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The integrity pipeline end to end inside the worker: segment-stream entries become fetch
 * evidence, the scheduled scoring job turns it into verdicts, and the published viewer count
 * follows. Real Postgres and Valkey.
 */
import { KEYS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { recordHeartbeat } from "@commonair/integrity";
import { createValkey } from "@commonair/service";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { integrityJobs, INTEGRITY_JOBS } from "../src/integrity/jobs.ts";
import { withRunLock } from "../src/integrity/lock.ts";
import { startSegmentConsumer } from "../src/segments/consumer.ts";
import { createWorker, type WorkerHandle } from "../src/worker.ts";
import { fastWebhooks, makeBroadcast, makeUser, quietLogger, VALKEY_URL, waitFor } from "./fixtures.ts";

const raw = createValkey(VALKEY_URL, { name: "worker-test-integrity" });
const dbs: TestDatabase[] = [];
const workers: WorkerHandle[] = [];
const streams: string[] = [];

afterAll(async () => {
  await Promise.allSettled(workers.map((w) => w.stop(2_000)));
  if (streams.length) await raw.del(...streams);
  await Promise.allSettled(dbs.map((d) => d.drop()));
  await raw.quit();
});

async function testDb() {
  const t = await createTestDatabase();
  dbs.push(t);
  return t;
}

function worker(t: TestDatabase, tag: string, over: Parameters<typeof createWorker>[0]["jobs"], segments = false) {
  const stream = `test:stream:segments:integrity:${tag}`;
  streams.push(stream);
  const w = createWorker({
    // The least-privilege application role, as in production (ADR 0004).
    db: t.app,
    valkeyUrl: VALKEY_URL,
    logger: quietLogger,
    webhooks: fastWebhooks(),
    keyPrefix: `test:${tag}:`,
    bullPrefix: `test-bull-${tag}`,
    busChannel: `test:${tag}:bus:events`,
    segmentStream: stream,
    jobs: over,
    outbox: false,
    segments: segments ? { blockMs: 100 } : false,
  });
  workers.push(w);
  return w;
}

const DESKTOP_FP = { webdriver: false, plugins: 5, webgl: true, innerWidth: 1280, innerHeight: 720, audio: true };
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("scoring through the scheduled job", () => {
  let t: TestDatabase;
  let w: WorkerHandle;
  let channelId: string;
  const ids = { honest: "", fetchless: "", poller: "" };

  beforeAll(async () => {
    t = await testDb();
    const tag = crypto.randomUUID();
    w = worker(t, tag, integrityJobs({ everyMs: { [INTEGRITY_JOBS.scoreSessions]: 1_000 } }));
    const { channel } = await makeUser(t.db);
    channelId = channel.id;
    const broadcast = await makeBroadcast(t.db, channelId, new Date(Date.now() - 300_000));
    const now = Date.now();

    const session = async (verdict: "pending" | "verified") => {
      const [s] = await t.db
        .insert(schema.playbackSessions)
        .values({
          id: uuidv7(),
          channelId,
          broadcastId: broadcast.id,
          deviceHash: `dev-${crypto.randomUUID()}`,
          ipHash: `ip-${crypto.randomUUID()}`,
          userAgent: DESKTOP_UA,
          fingerprint: DESKTOP_FP,
          startedAt: new Date(now - 120_000),
          lastHeartbeatAt: new Date(now - 5_000),
          heartbeats: 6,
          watchSeconds: 60,
          verdict,
        })
        .returning();
      // Six human-looking heartbeats (jittered, visible, buffer moving) in the API's history.
      for (let i = 0; i < 6; i++)
        await recordHeartbeat(w.ctx.valkey, s!.id, {
          at: now - (6 - i) * 10_000 + ((i * 7919) % 300),
          playedSeconds: 10,
          bufferSeconds: 2 + (i % 3),
          visible: true,
          muted: false,
          stalls: 0,
          bytesHttp: 0,
          bytesP2p: 0,
        });
      await w.ctx.valkey.zadd(KEYS.viewers(channelId), now, s!.id);
      return s!.id;
    };
    ids.honest = await session("pending");
    // Promoted by the API's heartbeat check before the scorer ran: the scorer's verdict wins.
    ids.fetchless = await session("verified");
    ids.poller = await session("verified");

    // What the origin logged: the honest viewer fetched 60 distinct segments (plus a re-request)
    // and its playlists, the poller only playlists, the fetch-less session nothing at all.
    const xadd = (sid: string, kind: string, obj?: string) =>
      raw.xadd(
        w.ctx.segmentStream,
        "*",
        ...([
          "sid",
          sid,
          "cid",
          channelId,
          "src",
          "origin",
          "kind",
          kind,
          "bytes",
          "1000",
          "at",
          String(Date.now()),
        ].concat(obj ? ["obj", obj] : []) as [string]),
      );
    for (let i = 0; i < 60; i++) await xadd(ids.honest, "segment", `source/x_seg${i}.mp4`);
    await xadd(ids.honest, "segment", "source/x_seg59.mp4");
    for (let i = 0; i < 30; i++) await xadd(ids.honest, "playlist");
    for (let i = 0; i < 30; i++) await xadd(ids.poller, "playlist");
    // Relay-sourced entries describe the relay's pull, never the viewer: they are not evidence.
    for (let i = 0; i < 5; i++)
      await raw.xadd(
        w.ctx.segmentStream,
        "*",
        "sid",
        ids.fetchless,
        "cid",
        channelId,
        "src",
        "relay",
        "rid",
        uuidv7(),
        "kind",
        "segment",
        "bytes",
        "1000",
        "at",
        String(Date.now()),
      );

    // Drain the stream with the real consumer first, so the first scoring run sees the evidence.
    const consumer = startSegmentConsumer(w.ctx, { blockMs: 100 });
    await waitFor(
      async () => {
        const [row] = await t.db
          .select({ n: schema.playbackSessions.segmentsFetched })
          .from(schema.playbackSessions)
          .where(eq(schema.playbackSessions.id, ids.honest));
        if (row?.n !== 61) return false;
        const pending = (await raw.xpending(w.ctx.segmentStream, "worker")) as [number, ...unknown[]];
        return Number(pending[0]) === 0;
      },
      { label: "segment stream drained" },
    );
    await consumer.stop();
    await w.ctx.valkey.set(KEYS.viewerCount(channelId), "3", "EX", 60);
    await w.start();
  });

  const verdicts = async () => {
    const rows = await t.db
      .select()
      .from(schema.playbackSessions)
      .where(inArray(schema.playbackSessions.id, Object.values(ids)));
    return new Map(rows.map((r) => [r.id, r]));
  };

  test("verdicts: honest verified, fetch-less held pending, playlist poller excluded with reasons", async () => {
    const rows = await waitFor(
      async () => {
        const v = await verdicts();
        return [...v.values()].every((r) => r.scoredAt !== null) && v;
      },
      { label: "all sessions scored" },
    );
    const honest = rows.get(ids.honest)!;
    const fetchless = rows.get(ids.fetchless)!;
    const poller = rows.get(ids.poller)!;
    expect(honest.verdict).toBe("verified");
    expect(fetchless.verdict).toBe("pending");
    expect(fetchless.verdictReasons).toContain("media_unconfirmed");
    expect(poller.verdict).toBe("excluded");
    expect(poller.verdictReasons).toContain("fetch_pattern");

    const flags = await t.db
      .select()
      .from(schema.integrityFlags)
      .where(eq(schema.integrityFlags.subjectId, ids.poller));
    expect(flags.map((f) => f.signal)).toContain("fetch_pattern");
    const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, ids.poller));
    expect(audit.map((a) => a.action)).toContain("integrity.session.exclude");
    // Nobody else was flagged.
    const others = await t.db
      .select()
      .from(schema.integrityFlags)
      .where(inArray(schema.integrityFlags.subjectId, [ids.honest, ids.fetchless]));
    expect(others).toEqual([]);
  });

  test("the published verified count is republished at once and counts only the honest viewer", async () => {
    const count = await waitFor(
      async () => {
        const v = await w.ctx.valkey.get(KEYS.viewerCount(channelId));
        return v === "1" && v;
      },
      { label: "viewer count 1" },
    );
    expect(count).toBe("1");
  });

  test("exclusions are sticky across later runs", async () => {
    const flagsFor = () =>
      t.db.select().from(schema.integrityFlags).where(eq(schema.integrityFlags.subjectId, ids.poller));
    const flagsBefore = (await flagsFor()).length;
    const before = (await verdicts()).get(ids.honest)!.scoredAt!;
    const rows = await waitFor(
      async () => {
        const v = await verdicts();
        return v.get(ids.honest)!.scoredAt! > before && v;
      },
      { label: "a later scoring run" },
    );
    expect(rows.get(ids.poller)!.verdict).toBe("excluded");
    expect(rows.get(ids.honest)!.verdict).toBe("verified");
    // Flags are written once, at the exclusion, not on every run.
    expect((await flagsFor()).length).toBe(flagsBefore);
  });
});

describe("scheduling across replicas", () => {
  test("two worker instances register each integrity job scheduler exactly once", async () => {
    const t = await testDb();
    const tag = crypto.randomUUID();
    const a = worker(t, tag, integrityJobs());
    const b = worker(t, tag, integrityJobs());
    await Promise.all([a.start(), b.start()]);
    const schedulers = await a.runtime.queue(QUEUES.integrity).getJobSchedulers();
    const names = schedulers.map((s) => s.id ?? s.key).sort();
    expect(names).toEqual(Object.values(INTEGRITY_JOBS).sort());
    const every = Object.fromEntries(schedulers.map((s) => [s.id ?? s.key, Number(s.every)]));
    expect(every).toEqual({
      "score-sessions": 15_000,
      "verify-receipts": 60_000,
      "follow-bursts": 60_000,
      "stream-hours": 300_000,
    });
    // A restart re-registers without duplicating.
    await b.stop(2_000);
    const c = worker(t, tag, integrityJobs());
    await c.start();
    expect((await c.runtime.queue(QUEUES.integrity).getJobSchedulers()).length).toBe(4);
  });

  test("a failing job is retried and the worker keeps running the others", async () => {
    const t = await testDb();
    const tag = crypto.randomUUID();
    const w = worker(t, tag, integrityJobs({ everyMs: { [INTEGRITY_JOBS.followBursts]: 1_000 } }));
    // Break only follow-burst detection: its table is gone, every other job still works.
    await t.sql`alter table follows rename to follows_gone`;
    await w.start();
    const q = w.runtime.queue(QUEUES.integrity);
    const failed = await waitFor(
      async () => {
        // A failed attempt with attempts left waits in "delayed" for its backoff.
        const jobs = await q.getJobs(["delayed", "failed"], 0, 50);
        return jobs.find((j) => j.name === INTEGRITY_JOBS.followBursts && j.attemptsMade >= 1);
      },
      { label: "follow-bursts retry scheduled", timeoutMs: 20_000, intervalMs: 200 },
    );
    expect(failed.opts.attempts).toBe(3);
    expect(failed.opts.backoff).toEqual({ type: "exponential", delay: 10_000 });
    expect(failed.failedReason).toMatch(/follows/);
    // Scoring kept running meanwhile (its first run happens at registration).
    const done = await q.getJobs(["completed"], 0, 100);
    expect(done.some((j) => j.name === INTEGRITY_JOBS.scoreSessions)).toBe(true);
    await t.sql`alter table follows_gone rename to follows`;
  }, 60_000);
});

const lockLog = { job: "test", logger: quietLogger };

describe("run lock", () => {
  test("a second run is skipped while the first holds the lock, and runs after release", async () => {
    const key = `test:lock:${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withRunLock(raw, key, { ttlMs: 1_000, maxHoldMs: 10_000, ...lockLog }, () =>
      gate.then(() => "first"),
    );
    await waitFor(async () => (await raw.exists(key)) === 1, { label: "lock taken" });
    // Held past its TTL: renewal keeps it.
    await Bun.sleep(1_300);
    expect(await withRunLock(raw, key, { ttlMs: 1_000, maxHoldMs: 10_000, ...lockLog }, async () => "second")).toEqual({
      acquired: false,
    });
    release();
    expect(await first).toEqual({ acquired: true, value: "first" });
    expect(await raw.exists(key)).toBe(0);
    expect(await withRunLock(raw, key, { ttlMs: 1_000, maxHoldMs: 10_000, ...lockLog }, async () => "third")).toEqual({
      acquired: true,
      value: "third",
    });
  });

  test("a run stuck past maxHoldMs stops renewing, so the next tick can run", async () => {
    const key = `test:lock:${crypto.randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stuck = withRunLock(raw, key, { ttlMs: 300, maxHoldMs: 0, ...lockLog }, () => gate);
    await waitFor(async () => (await raw.exists(key)) === 0, { label: "lock lapsed", timeoutMs: 3_000 });
    const next = await withRunLock(raw, key, { ttlMs: 300, maxHoldMs: 0, ...lockLog }, async () => "next");
    expect(next).toEqual({ acquired: true, value: "next" });
    release();
    await stuck;
  });
});
