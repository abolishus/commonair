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
import { probeCapabilities, type Capabilities } from "./ffmpeg/hwaccel.ts";
import { startJobs, type Jobs } from "./jobs.ts";
import { LiveCoordinator } from "./lifecycle.ts";
import { every, type Loop } from "./loop.ts";
import { MediaMtxClient } from "./mediamtx.ts";
import { HashMatchEnforcer } from "./safety/enforce.ts";
import { createHashMatcher, type HashMatcher } from "./safety/hashmatch.ts";
import { DEFAULT_TIMINGS, type MediaTimings } from "./settings.ts";

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
  hashMatcher?: HashMatcher;
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
  const matcher = opts.hashMatcher ?? createHashMatcher(env);

  let coordinator: LiveCoordinator | undefined;
  const enforcer = new HashMatchEnforcer({
    db: dbh.db,
    storage,
    bucket: env.S3_BUCKET_MEDIA,
    mtx,
    matcher,
    logger,
    // The broadcast ended, but its VOD must not be finalized (published): it is quarantined.
    stopBroadcast: async (id) => coordinator?.offline(id, true, false),
  });

  const jobsRef: { jobs?: Jobs } = {};
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
    enforcer,
    workDir,
    ffmpeg,
    ffprobe,
    internalSecret: env.MEDIA_INTERNAL_PASSWORD,
    authSecret: env.AUTH_SECRET,
    rtspBase: env.MEDIAMTX_RTSP_URL,
    transcodeThreshold: env.TRANSCODE_VIEWER_THRESHOLD,
    enqueueVodFinalize: async (vodId) => {
      if (!jobsRef.jobs) throw new Error("job queues not started");
      await jobsRef.jobs.enqueueVodFinalize(vodId);
    },
  };
  coordinator = new LiveCoordinator(ctx);
  const live = coordinator;

  const jobs = startJobs({
    valkeyUrl: env.VALKEY_URL,
    prefix: opts.bullPrefix,
    logger,
    finalize: {
      db: dbh.db,
      storage,
      bucket: ctx.bucket,
      enforcer,
      ffmpeg,
      imageFormat: caps.imageFormat,
      workDir,
      logger,
    },
    clips: {
      db: dbh.db,
      storage,
      bucket: ctx.bucket,
      enforcer,
      ffmpeg,
      encoder: caps.encoder,
      imageFormat: caps.imageFormat,
      workDir,
      logger,
      liveWindow: (id, start, d) => live.liveWindow(id, start, d),
    },
  });
  jobsRef.jobs = jobs;

  let reconcileLoop: Loop | null = null;
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
      subscriber.on("message", onMessage);
      await subscriber.subscribe(busChannel);
      // Recover broadcasts that went live while we were down, then keep reconciling.
      await live.reconcile().catch((err: unknown) => logger.warn("initial reconcile failed", { err }));
      reconcileLoop = every(timings.reconcileMs, () => live.reconcile(), { logger, name: "reconcile" });
      logger.info("media service started");
    },
    async stop() {
      await subscriber.unsubscribe(busChannel).catch(() => {});
      subscriber.off("message", onMessage);
      await reconcileLoop?.stop();
      await live.shutdown();
      await jobs.close();
      await Promise.allSettled([subscriber.quit(), bus.quit(), valkey.quit()]);
      await dbh.close();
    },
  };
}
