// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Dependencies shared by every per-broadcast worker. */
import type { Valkey } from "iovalkey";
import type { LiveEvent } from "@commonair/contracts/internal";
import type { Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import type { DiskBudget } from "./disk.ts";
import type { Capabilities } from "./ffmpeg/hwaccel.ts";
import type { MediaMtxClient } from "./mediamtx.ts";
import type { MediaModeration } from "./moderation/moderation.ts";
import type { MediaTimings } from "./settings.ts";
import type { SlotLimiter } from "./transcode/slots.ts";
import type { FinalizeJobControl } from "./vod/reconcile.ts";

export interface MediaContext {
  db: Database;
  /** Command connection (keys are prefixed in tests). */
  valkey: Valkey;
  publishLive: (event: LiveEvent) => Promise<void>;
  storage: ObjectStorage;
  bucket: string;
  mtx: MediaMtxClient;
  logger: Logger;
  timings: MediaTimings;
  caps: Capabilities;
  /** PDQ matching, T0 and the classifier hand-off (always on). */
  moderation: MediaModeration;
  /** Root for per-broadcast segment directories and clip scratch space. */
  workDir: string;
  ffmpeg: string;
  ffprobe: string;
  /** MEDIA_INTERNAL_PASSWORD: the internal MediaMTX user's password (never INTERNAL_API_SECRET). */
  internalSecret: string;
  /** AUTH_SECRET: decrypts simulcast stream keys. */
  authSecret: string;
  /** MEDIAMTX_RTSP_URL. */
  rtspBase: string;
  transcodeThreshold: number;
  enqueueVodFinalize: (vodId: string) => Promise<void>;
  /** Finalize-job state, for the stale-VOD reconcile. */
  vodJobs: FinalizeJobControl;
  /** Global budget for `workDir`: refuses new recordings and clip cuts when exceeded. */
  diskBudget: DiskBudget;
  /** Per-host cap on concurrent transcode ladders. */
  transcodeSlots: SlotLimiter;
  /** Dev/test only: allow simulcast targets on loopback/private addresses. */
  simulcastAllowPrivate: boolean;
}

/** What workers need to know about a live broadcast. */
export interface BroadcastInfo {
  broadcastId: string;
  channelId: string;
  slug: string;
  /** MediaMTX path, `live/<slug>`. */
  path: string;
  title: string;
  startedAt: Date;
  vodEnabled: boolean;
}
