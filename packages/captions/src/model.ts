// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The captions model's weights (ADR 0011, batch 6 decision (j)): `ggml-base-q5_1.bin` from the
 * whisper.cpp ggml repository, fetched by `bun scripts/fetch-model.ts` and mounted read-only into
 * the whisper sidecar. Never committed, never baked into an image, never served to clients.
 *
 * Placeholder from the W2 contract step: W2-captions pins `revision`, `sha256` (required: fetch
 * refuses null or a mismatch) and `sizeBytes`, names the MIT licence file read at that revision,
 * and adds the model selector to `fetch-model.ts`. Same shape as `MODEL` in
 * `packages/moderation/src/model.ts`.
 */
import { fileURLToPath } from "node:url";

export const CAPTIONS_MODEL = {
  repo: "ggerganov/whisper.cpp",
  revision: null as string | null,
  file: "ggml-base-q5_1.bin",
  sha256: null as string | null,
  sizeBytes: null as number | null,
  provider: "whisper.cpp:ggml-base-q5_1",
} as const;

/** Where fetch-model writes the captions weights by default (the sidecar mounts this file). */
export const DEFAULT_CAPTIONS_MODEL_PATH = fileURLToPath(
  new URL("../../../.cache/models/whisper-ggml-base-q5_1.bin", import.meta.url),
);

/** Null until the revision is pinned: nothing may fetch an unpinned file. */
export const captionsModelUrl = (): string | null =>
  CAPTIONS_MODEL.revision === null
    ? null
    : `https://huggingface.co/${CAPTIONS_MODEL.repo}/resolve/${CAPTIONS_MODEL.revision}/${CAPTIONS_MODEL.file}`;
