// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The default classifier's weights (ADR 0006 Q2, ADR 0008): fetched by `bun scripts/fetch-model.ts`
 * at a pinned revision and checked by sha256 on load. Never committed, never served to clients.
 */
import { fileURLToPath } from "node:url";

export const MODEL = {
  repo: "AdamCodd/vit-base-nsfw-detector",
  revision: "8587de998f441aac03fdd57a85d2e4cb808c7d64",
  file: "onnx/model_int8.onnx",
  /** sha256 of the file at the revision (equals the Hugging Face LFS oid; checked 2026-10-20). */
  sha256: "d25aa73fe1eec78459e35ff911e2af98f652ee919b48d9c54316c86d5ff435fa" as string | null,
  sizeBytes: 88_500_985,
  provider: "onnx:adamcodd-vit-nsfw",
} as const;

/** Where fetch-model writes by default and where the worker looks when MODERATION_CLASSIFIER_MODEL is empty. */
export const DEFAULT_MODEL_PATH = fileURLToPath(
  new URL("../../../.cache/models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx", import.meta.url),
);

export const modelUrl = () => `https://huggingface.co/${MODEL.repo}/resolve/${MODEL.revision}/${MODEL.file}`;
