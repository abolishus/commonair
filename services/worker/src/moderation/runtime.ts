// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the moderation jobs need beyond the ordinary worker context: the classifier, the evidence
 * sealing key (public half only: the worker can seal, never open) and the evidence bucket's own
 * storage client. `main.ts` builds it at startup and exits if any part is missing (fail closed);
 * there is no configuration in which these jobs run without it.
 */
import type { Classifier, SealingKey } from "@commonair/moderation";
import type { ValkeyClient } from "@commonair/service";
import type { ObjectStorage } from "@commonair/storage";
import type { WorkerContext } from "../context.ts";

export interface ModerationRuntime {
  classifier: Classifier;
  sealing: SealingKey;
  /** The evidence bucket's client (its own key: read + write on that bucket only). */
  evidenceStorage: ObjectStorage;
  evidenceBucket: string;
  /** `MODERATION_SAMPLE_SECONDS`; the effective interval is the smaller of this and the setting. */
  envSampleSeconds: number;
  /** `MODERATION_TEST_HOOKS`: only then may a job carry an `asOf` other than now. */
  testHooks: boolean;
  ffmpegPath?: string;
  /** In-process retries of the T0 transaction before the job itself is retried by BullMQ. */
  t0Retry?: { attempts: number; baseMs: number; maxMs: number };
}

/** What `createWorker` takes: the classifier may be built from the worker's own Valkey client (scripted). */
export interface ModerationOptions extends Omit<ModerationRuntime, "classifier"> {
  classifier: Classifier | ((valkey: ValkeyClient) => Classifier);
}

export function resolveModeration(opts: ModerationOptions, valkey: ValkeyClient): ModerationRuntime {
  const { classifier, ...rest } = opts;
  return { ...rest, classifier: typeof classifier === "function" ? classifier(valkey) : classifier };
}

export class ModerationNotConfiguredError extends Error {
  override name = "ModerationNotConfiguredError";
}

/** The runtime, or a loud failure: a moderation job never silently does nothing. */
export function moderationRuntime(ctx: WorkerContext): ModerationRuntime {
  if (!ctx.moderation) throw new ModerationNotConfiguredError("moderation runtime is not configured");
  return ctx.moderation;
}

/** The media bucket client, required by every job that reads or moves media objects. */
export function mediaStorage(ctx: WorkerContext) {
  if (!ctx.storage) throw new ModerationNotConfiguredError("object storage is not configured");
  return ctx.storage;
}
