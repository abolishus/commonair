// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vite-plus/test";
import { createOnnxClassifier, ModelIntegrityError } from "../src/onnx.ts";
import { decodeImage } from "../src/frames.ts";
import { DEFAULT_MODEL_PATH } from "../src/model.ts";

describe("default ONNX classifier", () => {
  test("runs only on a synthetic benign image and refuses an unpinned file", async () => {
    const png = new Uint8Array(
      await Bun.file(new URL("../fixtures/benign-gradient.png", import.meta.url)).arrayBuffer(),
    );
    const frame = await decodeImage(png);
    const classifier = await createOnnxClassifier({ modelPath: DEFAULT_MODEL_PATH });
    const start = performance.now();
    const scores = await classifier.classify({ rgb: frame.rgb, channelId: "synthetic-test" });
    const latency = performance.now() - start;
    expect(Object.keys(scores)).toEqual(["sexual"]);
    expect(scores.sexual).toBeGreaterThanOrEqual(0);
    expect(scores.sexual).toBeLessThanOrEqual(1);
    expect(latency).toBeGreaterThan(0);
    const wrong = `${DEFAULT_MODEL_PATH}.wrong-sha`;
    await Bun.write(wrong, "synthetic wrong digest");
    try {
      await expect(createOnnxClassifier({ modelPath: wrong })).rejects.toBeInstanceOf(ModelIntegrityError);
    } finally {
      await Bun.file(wrong).delete();
    }
  });
});
