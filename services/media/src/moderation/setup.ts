// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Startup of media moderation, fail closed: the evidence public key must import, every hash list
 * must load (operator files and the database block list), or this throws and the service exits.
 * There is no configuration that skips any of it.
 */
import type { Database } from "@commonair/db";
import { T0Outbox } from "./t0-outbox.ts";
import { importSealingKey, type SealingKey } from "@commonair/moderation";
import type { Logger } from "@commonair/observability";
import { every, type Loop } from "../loop.ts";
import { loadLists, type ListTools } from "./lists.ts";
import { createModerationMetrics } from "./metrics.ts";
import { MediaModeration, type ModerationDeps } from "./moderation.ts";
import { createModerationQueue, type ModerationQueue } from "./queue.ts";
import { defaultFrameTools, type FrameTools } from "./tools.ts";

export interface ModerationEnv {
  MODERATION_SAMPLE_SECONDS: number;
  MODERATION_HASHLIST_CSAM: string;
  MODERATION_HASHLIST_NCII: string;
  EVIDENCE_PUBLIC_KEY: string;
  VALKEY_URL: string;
}

export interface ModerationOverrides {
  tools?: Partial<FrameTools>;
  listTools?: ListTools;
  queue?: ModerationQueue;
  sealer?: SealingKey;
  retry?: ModerationDeps["retry"];
}

export interface ModerationRuntime {
  moderation: MediaModeration;
  /** Taint durable broadcasts before startup recovery can upload their local segments. */
  prepareT0Replay(): Promise<Set<string>>;
  committedRecoveryBroadcastIds(): ReadonlySet<string>;
  finishT0Recovery(): Promise<void>;
  /** Start the local block list refresh loop. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function setupModeration(opts: {
  env: ModerationEnv;
  db: Database;
  valkey: ModerationDeps["valkey"];
  logger: Logger;
  ffmpeg: string;
  t0OutboxDir: string;
  bullPrefix?: string;
  kickPublisher: (path: string) => Promise<void | boolean>;
  stopBroadcast: (broadcastId: string) => Promise<void>;
  resolveBroadcastId: ModerationDeps["resolveBroadcastId"];
  t0ActionCommitted: ModerationDeps["t0ActionCommitted"];
  overrides?: ModerationOverrides;
}): Promise<ModerationRuntime> {
  const { env, logger } = opts;
  let sealer: SealingKey;
  try {
    sealer = opts.overrides?.sealer ?? (await importSealingKey(env.EVIDENCE_PUBLIC_KEY));
  } catch (err) {
    logger.fatal("EVIDENCE_PUBLIC_KEY does not import; refusing to start");
    throw new Error("evidence public key does not import", { cause: err });
  }
  const lists = await loadLists({
    db: opts.db,
    sources: { csamPath: env.MODERATION_HASHLIST_CSAM, nciiPath: env.MODERATION_HASHLIST_NCII },
    logger,
    tools: opts.overrides?.listTools,
  });
  const queue = opts.overrides?.queue ?? createModerationQueue({ valkeyUrl: env.VALKEY_URL, prefix: opts.bullPrefix });
  const moderation = new MediaModeration({
    db: opts.db,
    valkey: opts.valkey,
    queue,
    matcher: lists.matcher,
    sealer,
    tools: { ...defaultFrameTools(opts.ffmpeg), ...opts.overrides?.tools },
    kickPublisher: opts.kickPublisher,
    stopBroadcast: opts.stopBroadcast,
    resolveBroadcastId: opts.resolveBroadcastId,
    t0ActionCommitted: opts.t0ActionCommitted,
    logger,
    metrics: createModerationMetrics(),
    envSampleSeconds: env.MODERATION_SAMPLE_SECONDS,
    t0Outbox: new T0Outbox(opts.t0OutboxDir),
    retry: opts.overrides?.retry,
  });
  logger.info("media moderation ready", { keyId: sealer.keyId, sampleSeconds: env.MODERATION_SAMPLE_SECONDS });

  let loop: Loop | null = null;
  return {
    moderation,
    prepareT0Replay: () => moderation.prepareT0Replay(),
    committedRecoveryBroadcastIds: () => moderation.committedRecoveryBroadcastIds(),
    finishT0Recovery: () => moderation.finishT0Recovery(),
    async start() {
      await moderation.replayT0Outbox();
      // The block list changes when legal confirms a case or an NCII request is removed; the
      // check is one aggregate query, as often as the shortest possible sample interval allows.
      loop ??= every(env.MODERATION_SAMPLE_SECONDS * 1000, () => lists.refreshLocal(), {
        logger,
        name: "local-hash-list",
      });
    },
    async stop() {
      await loop?.stop();
      lists.stop();
      await moderation.stop();
      if (!opts.overrides?.queue) await queue.close();
    },
  };
}
