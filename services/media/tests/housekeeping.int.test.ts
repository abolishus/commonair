// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Crash recovery, stale-VOD reconcile, disk-budget refusals and thumbnail cleanup against real
 * Postgres, Valkey (BullMQ), a throwaway Garage and real ffmpeg. The "crash" is a work dir that
 * ffmpeg's HLS muxer wrote exactly as the recorder does, with only part of it uploaded.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { createS3Storage, type ObjectStorage } from "@commonair/storage";
import { CLIP_DISK_REASON } from "../src/clips.ts";
import { DiskBudget } from "../src/disk.ts";
import { runCommand } from "../src/ffmpeg/run.ts";
import { startJobs, type Jobs } from "../src/jobs.ts";
import { ActiveScratch, BROADCASTS_DIR, recoverWorkDir, sweepWorkDir } from "../src/recovery.ts";
import { pruneThumbnails, thumbnailPrefix } from "../src/thumbnails.ts";
import { VOD_EMPTY_REASON } from "../src/vod/finalize.ts";
import { parsePlaylist, renderPlaylist, totalDuration } from "../src/vod/playlist.ts";
import { VOD_PLAYLIST, vodPrefix } from "../src/vod/recorder.ts";
import { reconcileVods, VOD_STALLED_REASON } from "../src/vod/reconcile.ts";
import { podmanAvailable, startGarage, type Garage } from "./helpers/containers.ts";
import { makeModeration } from "./helpers/moderation.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

if (!podmanAvailable()) throw new Error("media integration tests need podman (rootless is fine)");

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const BUCKET = "commonair-media";
const run = crypto.randomUUID().slice(0, 8);
const bullPrefix = `test-bull-hk-${run}`;
const logger = createLogger({ service: "media-hk-int", level: (process.env.TEST_LOG_LEVEL as "info") ?? "fatal" });

let tdb: TestDatabase;
let garage: Garage;
let storage: ObjectStorage;
let jobs: Jobs;
let channelId: string;
const workDir = mkdtempSync(join(tmpdir(), "media-hk-work-"));
const HOUR = 3600_000;

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${lastErr instanceof Error ? `: ${lastErr.message}` : ""}`);
}

async function broadcast(endedAgoMs: number | null): Promise<string> {
  const id = uuidv7();
  const now = Date.now();
  await tdb.db.insert(schema.broadcasts).values({
    id,
    channelId,
    ingestProtocol: "rtmp",
    path: `live/hk_${run}`,
    startedAt: new Date(now - (endedAgoMs ?? 0) - HOUR),
    endedAt: endedAgoMs === null ? null : new Date(now - endedAgoMs),
  });
  return id;
}

async function vod(broadcastId: string, status: "recording" | "processing"): Promise<string> {
  const id = uuidv7();
  await tdb.db
    .insert(schema.vods)
    .values({ id, broadcastId, channelId, title: "t", status, storagePrefix: vodPrefix(id) });
  return id;
}

const vodRow = async (id: string) => (await tdb.db.select().from(schema.vods).where(eq(schema.vods.id, id)))[0];

/** What the recorder's ffmpeg leaves in a broadcast directory: fMP4 HLS with PDT, one run. */
async function recordRun(dir: string, runId: string, seconds: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x180:rate=30:duration=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${seconds}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "60",
      "-c:a",
      "aac",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_list_size",
      "0",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      `init_${runId}.mp4`,
      "-hls_segment_filename",
      `${dir}/${runId}_%06d.m4s`,
      "-hls_flags",
      "independent_segments+program_date_time+temp_file",
      `${dir}/${runId}.m3u8`,
    ],
    { timeoutMs: 60_000 },
  );
}

beforeAll(async () => {
  tdb = await createTestDatabase();
  garage = await startGarage(BUCKET);
  storage = createS3Storage({
    endpoint: garage.endpoint,
    region: "garage",
    accessKeyId: garage.accessKeyId,
    secretAccessKey: garage.secretAccessKey,
    forcePathStyle: true,
  });
  await storage.ensureBucket(BUCKET);
  const [user] = await tdb.db
    .insert(schema.users)
    .values({ name: `hk_${run}`, email: `hk_${run}@test.invalid`, username: `hk_${run}` })
    .returning({ id: schema.users.id });
  if (!user) throw new Error("no user");
  const [channel] = await tdb.db
    .insert(schema.channels)
    .values({ ownerId: user.id, slug: `hk_${run}`, displayName: "hk", vodEnabled: true, vodRetentionDays: 7 })
    .returning({ id: schema.channels.id });
  if (!channel) throw new Error("no channel");
  channelId = channel.id;

  // Moderation is not under test here: fake frames that never match (synthetic, quality 0).
  const { moderation } = await makeModeration({ db: tdb.db, logger });
  const common = { db: tdb.db, storage, bucket: BUCKET, moderation, ffmpeg: "ffmpeg", workDir, logger };
  jobs = startJobs({
    valkeyUrl: VALKEY_URL,
    prefix: bullPrefix,
    logger,
    finalize: { ...common, imageFormat: "jpeg" },
    clips: {
      ...common,
      encoder: "libx264",
      imageFormat: "jpeg",
      // Nothing fits: every clip cut is refused.
      diskBudget: new DiskBudget({
        dir: workDir,
        logger,
        config: { maxBytes: 0, minFreeBytes: Number.MAX_SAFE_INTEGER },
        cacheMs: 0,
      }),
      liveWindow: () => null,
    },
  });
}, 180_000);

afterAll(async () => {
  await jobs?.close();
  const raw = createValkey(VALKEY_URL);
  const keys = await raw.keys(`${bullPrefix}:*`);
  if (keys.length > 0) await raw.del(...keys);
  await raw.quit();
  garage?.stop();
  await tdb?.drop();
  rmSync(workDir, { recursive: true, force: true });
}, 60_000);

describe("crash recovery and stale VODs", () => {
  let crashedBroadcast: string;
  let crashedVod: string;
  let localDuration: number;

  test("startup recovery uploads what a crashed recorder left behind and discards the rest", async () => {
    crashedBroadcast = await broadcast(HOUR);
    crashedVod = await vod(crashedBroadcast, "processing");
    const dir = join(workDir, BROADCASTS_DIR, crashedBroadcast);
    await recordRun(dir, "r1", 12);
    const local = parsePlaylist(await Bun.file(join(dir, "r1.m3u8")).text()).segments;
    expect(local.length).toBeGreaterThanOrEqual(5);
    localDuration = totalDuration(local);
    // The dead process had uploaded the init segment and the first two media segments.
    const prefix = vodPrefix(crashedVod);
    await storage.put(BUCKET, `${prefix}init_r1.mp4`, await Bun.file(join(dir, "init_r1.mp4")).bytes());
    for (const s of local.slice(0, 2))
      await storage.put(BUCKET, prefix + s.uri, await Bun.file(join(dir, s.uri)).bytes());
    await storage.put(BUCKET, prefix + VOD_PLAYLIST, renderPlaylist(local.slice(0, 2), { ended: false }));
    // A segment ffmpeg was still writing when the process died.
    writeFileSync(join(dir, "r1_000099.m4s.tmp"), "partial");

    // A broadcast without a VOD, and a stray non-broadcast directory: both discarded.
    const noVod = await broadcast(HOUR);
    await recordRun(join(workDir, BROADCASTS_DIR, noVod), "r1", 2);
    mkdirSync(join(workDir, BROADCASTS_DIR, "not-a-broadcast"));

    const result = await recoverWorkDir({ db: tdb.db, storage, bucket: BUCKET, workDir, logger });
    expect(result).toEqual({ directories: 3, uploaded: local.length - 2, kept: 0 });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(workDir, BROADCASTS_DIR, noVod))).toBe(false);
    expect(existsSync(join(workDir, BROADCASTS_DIR, "not-a-broadcast"))).toBe(false);

    const published = parsePlaylist((await (await storage.get(BUCKET, prefix + VOD_PLAYLIST))?.text()) ?? "");
    expect(published.ended).toBe(false);
    expect(published.segments.map((s) => s.uri)).toEqual(local.map((s) => s.uri));
    for (const s of local) expect(await storage.head(BUCKET, prefix + s.uri), s.uri).not.toBeNull();
    const keys: string[] = [];
    for await (const o of storage.list(BUCKET, prefix)) keys.push(o.key);
    expect(keys.some((k) => k.includes(".tmp"))).toBe(false);
  }, 120_000);

  test("reconcile re-queues unowned VODs, fails long-stalled ones and leaves owned or live ones alone", async () => {
    const stalled = await vod(await broadcast(25 * HOUR), "processing");
    const orphanRecording = await vod(await broadcast(HOUR), "recording");
    const liveHere = await broadcast(HOUR);
    const liveVod = await vod(liveHere, "recording");
    const stillLive = await vod(await broadcast(null), "recording");
    const owned = await vod(await broadcast(HOUR), "processing");
    await jobs.enqueueVodFinalize(owned);

    const result = await reconcileVods(
      { db: tdb.db, jobs: jobs.vodFinalize, logger, failAfterMs: 24 * HOUR, retryAfterMs: 10 * 60_000 },
      new Set([liveHere]),
    );
    expect(result.failed).toEqual([stalled]);
    expect(result.requeued.sort()).toEqual([crashedVod, orphanRecording].sort());
    expect(await vodRow(stalled)).toMatchObject({
      status: "failed",
      failedReason: VOD_STALLED_REASON,
      removedReason: null,
    });
    for (const id of [crashedVod, orphanRecording, owned])
      expect((await jobs.vodFinalize.info(id)).state, id).toBe("waiting");
    for (const id of [liveVod, stillLive]) {
      expect((await jobs.vodFinalize.info(id)).state).toBe("unknown");
      expect((await vodRow(id))?.status).toBe("recording");
    }

    // A second pass finds everything owned: nothing is queued twice.
    const again = await reconcileVods(
      { db: tdb.db, jobs: jobs.vodFinalize, logger, failAfterMs: 24 * HOUR, retryAfterMs: 10 * 60_000 },
      new Set([liveHere]),
    );
    expect(again).toEqual({ requeued: [], failed: [] });
  }, 60_000);

  test("once workers run, the recovered VOD is finalized with everything up to the crash", async () => {
    jobs.run();
    const ready = await waitFor(
      "recovered VOD ready",
      async () => {
        const v = await vodRow(crashedVod);
        return v?.status === "ready" ? v : null;
      },
      90_000,
    );
    expect(ready.durationSeconds).toBeCloseTo(localDuration, 1);
    const text = await (await storage.get(BUCKET, vodPrefix(crashedVod) + VOD_PLAYLIST))?.text();
    expect(text?.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  }, 120_000);

  test("a finished job is replaced on re-queue (BullMQ would otherwise ignore the duplicate id)", async () => {
    const id = await vod(await broadcast(HOUR), "processing");
    await jobs.enqueueVodFinalize(id);
    // No segments: finalize marks it failed, the job completes.
    await waitFor("job completed", async () => (await jobs.vodFinalize.info(id)).state === "completed");
    await tdb.db.update(schema.vods).set({ status: "processing" }).where(eq(schema.vods.id, id));
    await jobs.vodFinalize.requeue(id);
    await waitFor("re-run finished", async () => (await vodRow(id))?.status === "failed");
    expect(await vodRow(id)).toMatchObject({ failedReason: VOD_EMPTY_REASON, removedReason: null });
  }, 60_000);
});

describe("periodic sweep", () => {
  test("recovers an unowned recording before deleting it; keeps a processing one; drops finished ones", async () => {
    const root = join(workDir, BROADCASTS_DIR);
    const age = (dir: string) => {
      const t = (Date.now() - HOUR) / 1000;
      utimesSync(dir, t, t);
    };
    const recordingB = await broadcast(HOUR);
    const recordingVod = await vod(recordingB, "recording");
    await recordRun(join(root, recordingB), "r1", 6);
    const local = parsePlaylist(await Bun.file(join(root, recordingB, "r1.m3u8")).text()).segments;
    const processingB = await broadcast(HOUR);
    await vod(processingB, "processing");
    await recordRun(join(root, processingB), "r1", 2);
    const readyB = await broadcast(HOUR);
    const readyVod = await vod(readyB, "processing");
    await tdb.db.update(schema.vods).set({ status: "ready" }).where(eq(schema.vods.id, readyVod));
    await recordRun(join(root, readyB), "r1", 2);
    const ownedB = await broadcast(null);
    await recordRun(join(root, ownedB), "r1", 2);
    for (const b of [recordingB, processingB, readyB, ownedB]) age(join(root, b));

    const { removed } = await sweepWorkDir({
      db: tdb.db,
      storage,
      bucket: BUCKET,
      workDir,
      logger,
      owned: new Set([ownedB]),
      activeScratch: new ActiveScratch(),
      broadcastDirMaxAgeMs: 15 * 60_000,
    });
    expect(removed.sort()).toEqual([join(root, recordingB), join(root, readyB)].sort());
    expect(existsSync(join(root, processingB))).toBe(true);
    expect(existsSync(join(root, ownedB))).toBe(true);
    const published = parsePlaylist(
      (await (await storage.get(BUCKET, vodPrefix(recordingVod) + VOD_PLAYLIST))?.text()) ?? "",
    );
    expect(published.segments.map((s) => s.uri)).toEqual(local.map((s) => s.uri));
    expect(await storage.head(BUCKET, `${vodPrefix(recordingVod)}init_r1.mp4`)).not.toBeNull();
    rmSync(join(root, processingB), { recursive: true, force: true });
    rmSync(join(root, ownedB), { recursive: true, force: true });
  }, 120_000);
});

describe("disk budget", () => {
  test("a clip is refused with a clear reason when the work dir is over budget", async () => {
    const b = await broadcast(HOUR);
    const clipId = uuidv7();
    await tdb.db
      .insert(schema.clips)
      .values({ id: clipId, channelId, broadcastId: b, title: "c", startOffset: 1, durationSeconds: 2 });
    await jobs.enqueueClip(clipId);
    const clip = await waitFor("clip refused", async () => {
      const [c] = await tdb.db.select().from(schema.clips).where(eq(schema.clips.id, clipId));
      return c && c.status !== "processing" ? c : null;
    });
    expect(clip).toMatchObject({ status: "failed", removedReason: CLIP_DISK_REASON });
  }, 60_000);
});

describe("thumbnail history", () => {
  test("keeps the newest N timestamped thumbnails and the stable latest copy", async () => {
    const b = uuidv7();
    const prefix = thumbnailPrefix(b);
    const stamps = Array.from({ length: 15 }, (_, i) => 1_760_000_000_000 + i * 60_000);
    for (const t of stamps) await storage.put(BUCKET, `${prefix}${t}.jpg`, new Uint8Array([1, 2, 3]));
    await storage.put(BUCKET, `${prefix}latest.jpg`, new Uint8Array([1]));
    // Another broadcast's history is untouched.
    await storage.put(BUCKET, `${thumbnailPrefix(uuidv7())}${stamps[0]}.jpg`, new Uint8Array([1]));

    expect(await pruneThumbnails(storage, BUCKET, b, 10)).toBe(5);
    const left: string[] = [];
    for await (const o of storage.list(BUCKET, prefix)) left.push(o.key);
    expect(left.sort()).toEqual([...stamps.slice(5).map((t) => `${prefix}${t}.jpg`), `${prefix}latest.jpg`].sort());
    expect(await pruneThumbnails(storage, BUCKET, b, 10)).toBe(0);
  }, 60_000);
});
