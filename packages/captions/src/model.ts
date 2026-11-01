// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The captions model's weights (ADR 0011 decision 1, batch 6 decision (j)): `ggml-base-q5_1.bin`
 * from the whisper.cpp ggml repository, fetched by `bun scripts/fetch-model.ts --model captions`
 * and mounted read-only into the whisper sidecar. Never committed, never baked into an image,
 * never served to clients.
 *
 * Licence: MIT. Read at the pinned revision from the repository's `README.md` model card
 * (front matter `license: mit`; the repository has no separate LICENSE file); the weights are
 * OpenAI Whisper's (`github.com/openai/whisper`, LICENSE: MIT) converted to ggml. Checked
 * 2026-11-01. Unlike the classifier entry, the digest is required: `fetch-model` refuses a
 * captions file with no pinned digest or a different one (ADR 0011 decision 1).
 *
 * Why `base` quantized (q5_1, 57 MiB): multilingual, about 1 s per 3 s chunk on two CPU threads,
 * so two streams per media host fit beside the ladder (decision (j)); `small` costs roughly three
 * times the CPU. The `captions` harness's WER threshold (< 0.40, ADR 0011 History) gates it.
 */
import { fileURLToPath } from "node:url";

export interface CaptionsModelEntry {
  repo: string;
  revision: string | null;
  file: string;
  sha256: string | null;
  sizeBytes: number | null;
  provider: string;
}

export const CAPTIONS_MODEL: CaptionsModelEntry = {
  repo: "ggerganov/whisper.cpp",
  /** The repository head on 2026-11-01; the file itself last changed in f281eb45 (2023-09-06). */
  revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
  file: "ggml-base-q5_1.bin",
  /** sha256 of the file at the revision (the Hugging Face LFS oid). */
  sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  sizeBytes: 59_707_625,
  provider: "whisper.cpp:ggml-base-q5_1",
};

/** Where fetch-model writes the captions weights by default (the sidecar mounts this file). */
export const DEFAULT_CAPTIONS_MODEL_PATH = fileURLToPath(
  new URL("../../../.cache/models/whisper-ggml-base-q5_1.bin", import.meta.url),
);

/** The download URL; null while the revision is unpinned: nothing may fetch an unpinned file. */
export const captionsModelUrl = (entry: CaptionsModelEntry = CAPTIONS_MODEL): string | null =>
  entry.revision === null ? null : `https://huggingface.co/${entry.repo}/resolve/${entry.revision}/${entry.file}`;
