// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, onTestFailed, test } from "vite-plus/test";
import { createOnnxClassifier } from "../src/onnx.ts";
import { decodeImage } from "../src/frames.ts";
import { DEFAULT_MODEL_PATH } from "../src/model.ts";

/**
 * Why 30 s and not vitest's 5 s default: this test reads and hashes the 88 MB pinned model, builds
 * an onnxruntime session with full graph optimization and runs one inference, all CPU-bound, while
 * frames.int.test.ts encodes H.264 in the same run and other workspaces' integration tests share
 * the runner. That takes about 0.5 s on a quiet machine and 1.3 s to 5.2 s in CI (27 integration
 * jobs on main, 2026-11-03 to 2026-11-07; the 5.2 s one in run 42281796378), tracking how slow the
 * ffmpeg test was in the same job. Under the 5 s default it timed out in runs 41252522144 and
 * 41257928817 (5050 and 5074 ms). The test checks that the model loads and scores, not how fast,
 * so the bound only has to be far above that spread.
 */
const BOUND_MS = 30_000;

describe("default ONNX classifier", () => {
  test(
    "runs only on a synthetic benign image",
    async () => {
      // If the bound is ever hit, say which phase was running and how long each one took.
      const phases: { phase: string; ms: number }[] = [];
      let current = "decode";
      let mark = performance.now();
      const done = (next: string) => {
        const now = performance.now();
        phases.push({ phase: current, ms: Math.round(now - mark) });
        current = next;
        mark = now;
      };
      onTestFailed(() => {
        const running = `${current} (running for ${Math.round(performance.now() - mark)} ms)`;
        console.error(`onnx.int: phases ${JSON.stringify(phases)}; when the failure was reported: ${running}`);
      });

      const png = new Uint8Array(
        await Bun.file(new URL("../fixtures/benign-gradient.png", import.meta.url)).arrayBuffer(),
      );
      const frame = await decodeImage(png);
      done("load (read, sha256, session)");
      const classifier = await createOnnxClassifier({ modelPath: DEFAULT_MODEL_PATH });
      done("classify");
      const scores = await classifier.classify({ rgb: frame.rgb, channelId: "synthetic-test" });
      done("checks");
      expect(Object.keys(scores)).toEqual(["sexual"]);
      expect(scores.sexual).toBeGreaterThanOrEqual(0);
      expect(scores.sexual).toBeLessThanOrEqual(1);

      // A second call reuses the session and goes through the serializing queue.
      const [a, b] = await Promise.all([
        classifier.classify({ rgb: frame.rgb, channelId: "synthetic-test" }),
        classifier.classify({ rgb: frame.rgb, channelId: "synthetic-test" }),
      ]);
      expect(a.sexual).toBeCloseTo(scores.sexual ?? Number.NaN, 5);
      expect(b.sexual).toBeCloseTo(scores.sexual ?? Number.NaN, 5);

      // Bad input is refused without poisoning the queue for the next call.
      expect(() => classifier.classify({ rgb: new Uint8Array(3), channelId: "synthetic-test" })).toThrow(RangeError);
      const after = await classifier.classify({ rgb: frame.rgb, channelId: "synthetic-test" });
      expect(after.sexual).toBeCloseTo(scores.sexual ?? Number.NaN, 5);
    },
    BOUND_MS,
  );
});
