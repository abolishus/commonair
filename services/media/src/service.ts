// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Wires the media service together; `main.ts` runs it, integration tests embed it. */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS } from "@commonair/contracts/events";
import { createDb, type DbHandle } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { createLogger } from "@commonair/observability";
import { createValkey, valkeyCheck, type ReadinessCheck } from "@commonair/service";
import { storageFromEnv, type ObjectStorage } from "@commonair/storage";
import type { MediaContext } from "./context.ts";
import type { MediaServiceEnv } from "./env.ts";
import { DiskBudget } from "./disk.ts";
import { probeCapabilities, type Capabilities } from "./ffmpeg/hwaccel.ts";
import { startJobs, type Jobs } from "./jobs.ts";
import { LiveCoordinator } from "./lifecycle.ts";
import { every, type Loop } from "./loop.ts";
import { MediaMtxClient } from "./mediamtx.ts";
import { setupModeration, type ModerationOverrides } from "./moderation/setup.ts";
import { ActiveScratch, recoverWorkDir, sweepScratchAtStartup, sweepWorkDir } from "./recovery.ts";
import { DEFAULT_TIMINGS, type MediaTimings } from "./settings.ts";
import { defaultTranscodeSlots, SlotLimiter } from "./transcode/slots.ts";

export interface MediaServiceOptions {
  env: MediaServiceEnv;
  logger?: Logger;
  timings?: Partial<MediaTimings>;
  /** Valkey key prefix for state keys (tests isolate with a unique one). */
  keyPrefix?: string;
  /** BullMQ prefix (tests isolate with a unique one). */
  bullPrefix?: string;
  /** Pub/sub channel for live events (tests use a unique one). */
  busChannel?: string;
  /** Tests only: fakes for the moderation primitives (production always uses @commonair/moderation). */
  moderation?: ModerationOverrides;
  workDir?: string;
  ffmpeg?: string;
  ffprobe?: string;
  /** Skip the startup encoder probe (tests). */
  capabilities?: Capabilities;
}

export interface MediaService {
  start(): Promise<void>;
  stop(): Promise<void>;
  checks: Record<string, ReadinessCheck>;
  coordinator: LiveCoordinator;
  jobs: Jobs;
  ctx: MediaContext;
}

export async function createMediaService(opts: MediaServiceOptions): Promise<MediaService> {
  const { env } = opts;
  const logger = opts.logger ?? createLogger({ service: "media", level: env.LOG_LEVEL });
  const timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const ffprobe = opts.ffprobe ?? "ffprobe";
  const caps = opts.capabilities ?? (await probeCapabilities(env.TRANSCODE_HWACCEL, ffmpeg));
  logger.info("media capabilities", { encoder: caps.encoder, imageFormat: caps.imageFormat });
  if (caps.imageFormat !== "webp") logger.warn("ffmpeg lacks libwebp: thumbnails are JPEG");

  const workDir = opts.workDir ?? env.MEDIA_WORK_DIR ?? join(tmpdir(), "commonair-media");
  await mkdir(workDir, { recursive: true });
  const busChannel = opts.busChannel ?? BUS.live;

  const dbh: DbHandle = createDb({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, applicationName: "media" });
  const valkey = createValkey(env.VALKEY_URL, { keyPrefix: opts.keyPrefix, name: "media" });
  const bus = createValkey(env.VALKEY_URL, { name: "media-bus" });
  const subscriber = createValkey(env.VALKEY_URL, { name: "media-sub" });
  const storage: ObjectStorage = storageFromEnv(env);
  const mtx = new MediaMtxClient(env.MEDIAMTX_API_URL, env.MEDIA_INTERNAL_PASSWORD);

  let coordinator: LiveCoordinator | undefined;
  // Fail closed: a bad evidence key or hash list throws here and the service does not start.
  const moderationRuntime = await setupModeration({
    env,
    db: dbh.db,
    valkey,
    logger,
    ffmpeg,
    bullPrefix: opts.bullPrefix,
    kickPublisher: async (path) => {
      return mtx.kickPublisher(path);
    },
    // The broadcast ended, but its VOD must not be finalized (published): the worker removes it.
    stopBroadcast: async (id) => coordinator?.offline(id, true, false),
    overrides: opts.moderation,
  }).catch(async (err: unknown) => {
    await Promise.allSettled([subscriber.quit(), bus.quit(), valkey.quit(), dbh.close()]);
    throw err;
  });
  const moderation = moderationRuntime.moderation;

  const diskBudget = new DiskBudget({
    dir: workDir,
    config: { maxBytes: env.MEDIA_WORK_DIR_MAX_BYTES, minFreeBytes: env.MEDIA_WORK_DIR_MIN_FREE_BYTES },
    logger,
  });
  const transcodeSlots = new SlotLimiter(env.TRANSCODE_MAX_LADDERS ?? defaultTranscodeSlots(caps.encoder));
  logger.info("media limits", {
    transcodeSlots: transcodeSlots.capacity,
    workDirMaxBytes: diskBudget.config.maxBytes,
    workDirMinFreeBytes: diskBudget.config.minFreeBytes,
  });

  const jobsRef: { jobs?: Jobs } = {};
  const jobsNotStarted = () => new Error("job queues not started");
  const ctx: MediaContext = {
    db: dbh.db,
    valkey,
    publishLive: async (event) => {
      await bus.publish(busChannel, JSON.stringify(event));
    },
    storage,
    bucket: env.S3_BUCKET_MEDIA,
    mtx,
    logger,
    timings,
    caps,
    moderation,
    workDir,
    ffmpeg,
    ffprobe,
    internalSecret: env.MEDIA_INTERNAL_PASSWORD,
    authSecret: env.AUTH_SECRET,
    rtspBase: env.MEDIAMTX_RTSP_URL,
    transcodeThreshold: env.TRANSCODE_VIEWER_THRESHOLD,
    enqueueVodFinalize: async (vodId) => {
      if (!jobsRef.jobs) throw jobsNotStarted();
      await jobsRef.jobs.enqueueVodFinalize(vodId);
    },
    vodJobs: {
      info: async (vodId) => {
        if (!jobsRef.jobs) throw jobsNotStarted();
        return jobsRef.jobs.vodFinalize.info(vodId);
      },
      requeue: async (vodId) => {
        if (!jobsRef.jobs) throw jobsNotStarted();
        await jobsRef.jobs.vodFinalize.requeue(vodId);
      },
    },
    diskBudget,
    transcodeSlots,
    simulcastAllowPrivate: env.OUTBOUND_ALLOW_PRIVATE_NETWORKS,
  };
  coordinator = new LiveCoordinator(ctx);
  const live = coordinator;

  const activeScratch = new ActiveScratch();
  const jobs = startJobs({
    valkeyUrl: env.VALKEY_URL,
    prefix: opts.bullPrefix,
    logger,
    finalize: {
      db: dbh.db,
      storage,
      bucket: ctx.bucket,
      moderation,
      ffmpeg,
      imageFormat: caps.imageFormat,
      workDir,
      logger,
      diskBudget,
      scratch: activeScratch,
    },
    clips: {
      db: dbh.db,
      storage,
      bucket: ctx.bucket,
      moderation,
      ffmpeg,
      encoder: caps.encoder,
      imageFormat: caps.imageFormat,
      workDir,
      logger,
      diskBudget,
      scratch: activeScratch,
      liveWindow: (id, start, d) => live.liveWindow(id, start, d),
    },
  });
  jobsRef.jobs = jobs;

  let reconcileLoop: Loop | null = null;
  let sweepLoop: Loop | null = null;
  const sweep = async () => {
    const { removed } = await sweepWorkDir({
      db: dbh.db,
      storage,
      bucket: ctx.bucket,
      workDir,
      logger,
      owned: new Set(live.liveBroadcasts),
      activeScratch,
      broadcastDirMaxAgeMs: timings.broadcastDirMaxAgeMs,
    });
    if (removed.length > 0) diskBudget.invalidate();
  };
  const onMessage = (channel: string, message: string) => {
    if (channel !== busChannel) return;
    void live.handleMessage(message).catch((err: unknown) => logger.error("live event handling failed", { err }));
  };

  const checks: Record<string, ReadinessCheck> = {
    mediamtx: () => mtx.check(),
    postgres: async () => {
      await dbh.sql`select 1`;
    },
    valkey: valkeyCheck(valkey),
    s3: async () => {
      // A HEAD on a missing key answers 404 (fine) when the endpoint and credentials work.
      await storage.head(ctx.bucket, "healthcheck");
    },
  };

  return {
    ctx,
    coordinator: live,
    jobs,
    checks,
    async start() {
      await storage.ensureBucket(ctx.bucket).catch((err: unknown) => {
        logger.warn("could not ensure media bucket exists (bootstrap should create it)", { err });
      });
      // Crash recovery first: no session records and no job reads a playlist until the work dir
      // left by a previous process is repaired. Job workers are idle until now, so every
      // scratch directory is a leftover.
      try {
        const r = await recoverWorkDir({ db: dbh.db, storage, bucket: ctx.bucket, workDir, logger });
        if (r.directories > 0) logger.info("work dir recovered", { ...r });
        await sweepScratchAtStartup({ workDir, logger });
        diskBudget.invalidate();
      } catch (err) {
        logger.warn("work dir recovery failed", { err });
      }
      jobs.run();
      moderationRuntime.start();
      subscriber.on("message", onMessage);
      await subscriber.subscribe(busChannel);
      // Recover broadcasts that went live while we were down, then keep reconciling.
      await live.reconcile().catch((err: unknown) => logger.warn("initial reconcile failed", { err }));
      reconcileLoop = every(timings.reconcileMs, () => live.reconcile(), { logger, name: "reconcile" });
      sweepLoop = every(timings.sweepMs, () => sweep(), { logger, name: "work-dir-sweep" });
      logger.info("media service started");
    },
    async stop() {
      await subscriber.unsubscribe(busChannel).catch(() => {});
      subscriber.off("message", onMessage);
      await reconcileLoop?.stop();
      await sweepLoop?.stop();
      await live.shutdown();
      await jobs.close();
      await moderationRuntime.stop();
      await Promise.allSettled([subscriber.quit(), bus.quit(), valkey.quit()]);
      await dbh.close();
    },
  };
}
