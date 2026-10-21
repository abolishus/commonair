// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Build the required moderation runtime at process startup; no disabled or classifier-free mode. */
import { KEYS, ModerationScores } from "@commonair/contracts/internal";
import { DEFAULT_MODEL_PATH, importSealingKey, scriptedClassifier } from "@commonair/moderation";
import { createOnnxClassifier } from "@commonair/moderation/onnx";
import type { ValkeyClient } from "@commonair/service";
import { createS3Storage } from "@commonair/storage";
import type { WorkerEnv } from "../env.ts";
import type { ModerationOptions } from "./runtime.ts";

export type ModerationStartupEnv = Pick<
  WorkerEnv,
  | "S3_ENDPOINT"
  | "S3_REGION"
  | "S3_FORCE_PATH_STYLE"
  | "S3_BUCKET_EVIDENCE"
  | "S3_EVIDENCE_ACCESS_KEY_ID"
  | "S3_EVIDENCE_SECRET_ACCESS_KEY"
  | "EVIDENCE_PUBLIC_KEY"
  | "MODERATION_CLASSIFIER"
  | "MODERATION_CLASSIFIER_MODEL"
  | "MODERATION_SAMPLE_SECONDS"
  | "MODERATION_TEST_HOOKS"
>;

export async function buildModerationOptions(env: ModerationStartupEnv): Promise<ModerationOptions> {
  if (!env.S3_ENDPOINT) throw new Error("worker moderation requires a private S3 endpoint");
  if (env.MODERATION_CLASSIFIER === "scripted" && !env.MODERATION_TEST_HOOKS)
    throw new Error("scripted moderation classifier requires test hooks");

  const sealing = await importSealingKey(env.EVIDENCE_PUBLIC_KEY);
  const evidenceStorage = createS3Storage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_EVIDENCE_ACCESS_KEY_ID,
    secretAccessKey: env.S3_EVIDENCE_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  const classifier =
    env.MODERATION_CLASSIFIER === "scripted"
      ? (valkey: ValkeyClient) =>
          scriptedClassifier(async (channelId) => {
            const raw = await valkey.get(KEYS.moderationScript(channelId));
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            return ModerationScores.parse(parsed);
          })
      : await createOnnxClassifier({ modelPath: env.MODERATION_CLASSIFIER_MODEL || DEFAULT_MODEL_PATH });

  return {
    classifier,
    sealing,
    evidenceStorage,
    evidenceBucket: env.S3_BUCKET_EVIDENCE,
    envSampleSeconds: env.MODERATION_SAMPLE_SECONDS,
    testHooks: env.MODERATION_TEST_HOOKS,
  };
}
