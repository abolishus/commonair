// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Wires the media service together; `main.ts` runs it, integration tests embed it. */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { BUS } from "@commonair/contracts/events";
import type { ModerationT0Job } from "@commonair/contracts/internal";
import { createDb, schema, type DbHandle } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { createLogger } from "@commonair/observability";
import { createValkey, valkeyCheck, type ReadinessCheck } from "@commonair/service";
import { storageFromEnv, type ObjectStorage } from "@commonair/storage";
import { hostSynchronized, initHostClock } from "./clock/host.ts";
import { createMediaClock } from "./clock/media-clock.ts";
import { createClockMetrics, observeHostSynchronized } from "./clock/metrics.ts";
import { assertSrtSecret } from "./ffmpeg/args.ts";
import type { MediaContext } from "./context.ts";
import type { MediaServiceEnv } from "./env.ts";
import { DiskBudget } from "./disk.ts";
import { errorCategory } from "./moderation/logging.ts";
import { probeCapabilities, type Capabilities } from "./ffmpeg/hwaccel.ts";
import { startJobs, type Jobs } from "./jobs.ts";
import { LiveCoordinator } from "./lifecycle.ts";
import { every, type Loop } from "./loop.ts";
import { startRtspPublishProxy } from "./ffmpeg/rtsp-publish-proxy.ts";
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
  /**
   * Tests only: publish renditions straight to MediaMTX, without the sender-report relay. For an
   * ffmpeg that runs outside this host's network namespace and cannot reach its loopback.
   */
  directRtspPublish?: boolean;
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
  // Fail at boot: every SRT reader (ladder, AAC copy, recorder) would otherwise retry forever.
  assertSrtSecret(env.MEDIA_INTERNAL_PASSWORD);
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
    t0OutboxDir: join(workDir, "moderation-t0-outbox"),
    bullPrefix: opts.bullPrefix,
    kickPublisher: async (path) => {
      return mtx.kickPublisher(path);
    },
    // A replay can run before local sessions are restored, so kick from the durable broadcast
    // path first; then stop any local workers and flush the recorder before the T0 reaches a worker.
    stopBroadcast: async (id) => {
      const [broadcast] = await dbh.db
        .select({ path: schema.broadcasts.path })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, id))
        .limit(1);
      if (broadcast) await mtx.kickPublisher(broadcast.path);
      await coordinator?.offline(id, true, false, true);
    },
    resolveBroadcastId: async (job: ModerationT0Job) => {
      if (job.subjectType === "broadcast") return job.subjectId;
      if (job.subjectType === "vod") {
        const [vod] = await dbh.db
          .select({ broadcastId: schema.vods.broadcastId })
          .from(schema.vods)
          .where(eq(schema.vods.id, job.subjectId))
          .limit(1);
        return vod?.broadcastId ?? null;
      }
      if (job.subjectType === "clip") {
        const [clip] = await dbh.db
          .select({ broadcastId: schema.clips.broadcastId, vodId: schema.clips.vodId })
          .from(schema.clips)
          .where(eq(schema.clips.id, job.subjectId))
          .limit(1);
        if (clip?.broadcastId) return clip.broadcastId;
        if (clip?.vodId) {
          const [vod] = await dbh.db
            .select({ broadcastId: schema.vods.broadcastId })
            .from(schema.vods)
            .where(eq(schema.vods.id, clip.vodId))
            .limit(1);
          return vod?.broadcastId ?? null;
        }
      }
      return null;
    },
    t0ActionCommitted: async (job: ModerationT0Job) => {
      const c = schema.moderationCases;
      const [row] = await dbh.db
        .select({ id: c.id })
        .from(c)
        .where(
          and(
            eq(c.subjectType, job.subjectType),
            eq(c.subjectId, job.subjectId),
            eq(c.tier, "t0"),
            eq(c.origin, "hash_list"),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
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

  const clock = createMediaClock({
    hlsBase: env.MEDIAMTX_HLS_URL,
    password: env.MEDIA_INTERNAL_PASSWORD,
    logger,
    metrics: createClockMetrics(),
  });

  // The ladder and the AAC copy publish through this relay so MediaMTX uses ffmpeg's first sender
  // report: without it a useAbsoluteTimestamp path drops the first ~5 s (clock/README.md).
  const publishRelay = opts.directRtspPublish
    ? null
    : await startRtspPublishProxy(env.MEDIAMTX_RTSP_URL).catch(async (err: unknown) => {
        await moderationRuntime.stop();
        await Promise.allSettled([subscriber.quit(), bus.quit(), valkey.quit(), dbh.close()]);
        throw err;
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
    rtspPublishBase: publishRelay?.base ?? env.MEDIAMTX_RTSP_URL,
    srtBase: env.MEDIAMTX_SRT_URL,
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
    // ADR 0012 variant A2: W0 from the source's LL-HLS, recorder runs anchored from it.
    clock,
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
    await moderation.pruneCommittedT0Outbox();
    const { removed } = await sweepWorkDir({
      clock,
      db: dbh.db,
      storage,
      bucket: ctx.bucket,
      workDir,
      logger,
      owned: new Set([...live.liveBroadcasts, ...moderation.protectedBroadcastIds()]),
      activeScratch,
      broadcastDirMaxAgeMs: timings.broadcastDirMaxAgeMs,
      discardBroadcastIds: moderation.committedRecoveryBroadcastIds(),
    });
    await moderationRuntime.finishT0Recovery();
    if (removed.length > 0) diskBudget.invalidate();
  };
  const onMessage = (channel: string, message: string) => {
    if (channel !== busChannel) return;
    void live
      .handleMessage(message)
      .catch((err: unknown) => logger.error("live event handling failed", { error: errorCategory(err) }));
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
      // ADR 0012 decision 2: the media clock is this host's wall clock. Warn, never fail health.
      await initHostClock();
      observeHostSynchronized(hostSynchronized);
      if (hostSynchronized() === false)
        logger.warn("host clock is not NTP-synchronized; broadcast times (PDT) follow it (ADR 0012)");
      await storage.ensureBucket(ctx.bucket).catch((err: unknown) => {
        logger.warn("could not ensure media bucket exists (bootstrap should create it)", { error: errorCategory(err) });
      });
      const protectedBroadcastIds = await moderationRuntime.prepareT0Replay();
      // Crash recovery first: no session records and no job reads a playlist until the work dir
      // left by a previous process is repaired. Durable T0 broadcasts are excluded so recovery
      // cannot republish their local segments before the queued cleanup runs.
      try {
        const r = await recoverWorkDir({
          clock,
          db: dbh.db,
          storage,
          bucket: ctx.bucket,
          workDir,
          logger,
          protectedBroadcastIds,
          discardBroadcastIds: moderationRuntime.committedRecoveryBroadcastIds(),
        });
        if (r.directories > 0) logger.info("work dir recovered", { ...r });
        await sweepScratchAtStartup({ workDir, logger });
        diskBudget.invalidate();
        await moderationRuntime.finishT0Recovery();
      } catch (err) {
        logger.warn("work dir recovery failed", { error: errorCategory(err) });
        throw err;
      }
      await moderationRuntime.start();
      jobs.run();
      subscriber.on("message", onMessage);
      await subscriber.subscribe(busChannel);
      // Recover broadcasts that went live while we were down, then keep reconciling.
      await live
        .reconcile()
        .catch((err: unknown) => logger.warn("initial reconcile failed", { error: errorCategory(err) }));
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
      await publishRelay?.close();
      await jobs.close();
      await moderationRuntime.stop();
      await Promise.allSettled([subscriber.quit(), bus.quit(), valkey.quit()]);
      await dbh.close();
    },
  };
}
