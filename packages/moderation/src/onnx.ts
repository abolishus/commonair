// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The default classifier: `AdamCodd/vit-base-nsfw-detector` (int8 ONNX) on onnxruntime-node, CPU.
 * Scores `sexual` only; the other categories are not scored (absent). A separate entry point so
 * only the worker loads the native addon. Refuses to load a file whose sha256 differs from
 * `MODEL.sha256` (fail closed; there is no "no classifier" fallback).
 *
 * Model facts at revision 8587de998f441aac03fdd57a85d2e4cb808c7d64 (read 2026-10-21):
 * - `config.json` `id2label`: `{ "0": "sfw", "1": "nsfw" }`, so logit index 1 is NSFW.
 * - `onnx/preprocessor_config.json` (ViTFeatureExtractor): resize to 384×384, rescale 1/255,
 *   normalize mean 0.5 / std 0.5 per channel, NCHW float32. Upstream resizes bilinearly; we feed
 *   ffmpeg's area-scaled 384×384 RGB (the same frame media produces), a negligible difference
 *   for a downscale.
 */
import { createHash } from "node:crypto";
import * as ort from "onnxruntime-node";
import { MODERATION_CONSTANTS } from "./constants.ts";
import { MODEL } from "./model.ts";
import type { Classifier } from "./types.ts";

const SIZE = MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE;
const NSFW_INDEX = 1;

export class ModelIntegrityError extends Error {
  override name = "ModelIntegrityError";
}

/** RGB bytes (HWC) → normalized NCHW float32, `(x / 255 - 0.5) / 0.5`. */
export function preprocess(rgb: Uint8Array): Float32Array {
  if (rgb.length !== SIZE * SIZE * 3) throw new RangeError(`classifier input must be ${SIZE}x${SIZE} RGB`);
  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let p = 0, i = 0; p < plane; p++, i += 3) {
    out[p] = ((rgb[i] ?? 0) / 255 - 0.5) / 0.5;
    out[plane + p] = ((rgb[i + 1] ?? 0) / 255 - 0.5) / 0.5;
    out[2 * plane + p] = ((rgb[i + 2] ?? 0) / 255 - 0.5) / 0.5;
  }
  return out;
}

/** Numerically stable softmax. */
export function softmax(logits: ArrayLike<number>): number[] {
  const xs = Array.from(logits);
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

export const onnxProviderVersion = () => `${MODEL.revision.slice(0, 8)}:${(MODEL.sha256 ?? "").slice(0, 12)}`;

export async function createOnnxClassifier(opts: { modelPath: string }): Promise<Classifier> {
  if (MODEL.sha256 === null) throw new ModelIntegrityError("no pinned model sha256");
  const file = Bun.file(opts.modelPath);
  if (!(await file.exists())) throw new ModelIntegrityError("classifier model file is missing");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== MODEL.sha256) throw new ModelIntegrityError("classifier model sha256 does not match the pinned digest");

  // Create from the verified bytes, not the path, so the file cannot change between check and load.
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (inputName === undefined || outputName === undefined) throw new ModelIntegrityError("model has no input/output");

  // onnxruntime sessions are not safe for concurrent `run` calls in every backend; serialize.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    provider: MODEL.provider,
    providerVersion: onnxProviderVersion(),
    scored: ["sexual"],
    classify(input) {
      const pixels = preprocess(input.rgb);
      const run = queue.then(async () => {
        const tensor = new ort.Tensor("float32", pixels, [1, 3, SIZE, SIZE]);
        const out = await session.run({ [inputName]: tensor });
        const logits = out[outputName]?.data as Float32Array | undefined;
        if (!logits || logits.length !== 2) throw new Error("classifier output has an unexpected shape");
        const p = softmax(logits)[NSFW_INDEX] ?? Number.NaN;
        if (!Number.isFinite(p)) throw new Error("classifier produced a non-finite score");
        return { sexual: Math.min(1, Math.max(0, p)) };
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
