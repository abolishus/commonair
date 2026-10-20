// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The default classifier: `AdamCodd/vit-base-nsfw-detector` (int8 ONNX) on onnxruntime-node, CPU.
 * Scores `sexual` only; the other categories are not scored (absent). A separate entry point so
 * only the worker loads the native addon. Refuses to load a file whose sha256 differs from
 * `MODEL.sha256` (fail closed; there is no "no classifier" fallback).
 */
import { pending } from "./pending.ts";
import type { Classifier } from "./types.ts";

export async function createOnnxClassifier(_opts: { modelPath: string }): Promise<Classifier> {
  return pending("createOnnxClassifier");
}
