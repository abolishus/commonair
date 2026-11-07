// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The parts of the ONNX classifier that need no model weights: preprocessing, softmax, the
 * provider version, and the integrity refusals (which must fail before any session is built).
 * The session itself runs in onnx.int.test.ts against the pinned model.
 */
import { afterAll, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODERATION_CONSTANTS } from "../src/constants.ts";
import { MODEL } from "../src/model.ts";
import { createOnnxClassifier, ModelIntegrityError, onnxProviderVersion, preprocess, softmax } from "../src/onnx.ts";

const SIZE = MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE;
const PLANE = SIZE * SIZE;
const dir = await mkdtemp(join(tmpdir(), "moderation-onnx-"));
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe("preprocess", () => {
  test("HWC RGB bytes become NCHW planes normalized to [-1, 1]", () => {
    const rgb = new Uint8Array(PLANE * 3);
    // Pixel 0: (0, 255, 51); the last pixel: (255, 0, 102).
    rgb.set([0, 255, 51], 0);
    rgb.set([255, 0, 102], (PLANE - 1) * 3);
    const out = preprocess(rgb);
    expect(out).toHaveLength(3 * PLANE);
    expect(out[0]).toBe(-1);
    expect(out[PLANE]).toBe(1);
    expect(out[2 * PLANE]).toBeCloseTo(-0.6, 6);
    expect(out[PLANE - 1]).toBe(1);
    expect(out[2 * PLANE - 1]).toBe(-1);
    expect(out[3 * PLANE - 1]).toBeCloseTo(-0.2, 6);
    // Every other pixel is black: -1 in each plane.
    expect(out[1]).toBe(-1);
    expect(out[PLANE + 1]).toBe(-1);
  });

  test("a mid-grey byte maps to just above zero, not a float rounding of 0.5", () => {
    const out = preprocess(new Uint8Array(PLANE * 3).fill(128));
    expect(out[0]).toBeCloseTo((128 / 255 - 0.5) / 0.5, 6);
    expect(out[0]).toBeGreaterThan(0);
  });

  test("refuses input that is not exactly SIZE×SIZE RGB", () => {
    expect(() => preprocess(new Uint8Array(0))).toThrow(RangeError);
    expect(() => preprocess(new Uint8Array(PLANE * 3 - 1))).toThrow(RangeError);
    expect(() => preprocess(new Uint8Array(PLANE * 3 + 1))).toThrow(RangeError);
    expect(() => preprocess(new Uint8Array(PLANE * 4))).toThrow(RangeError);
  });
});

describe("softmax", () => {
  test("equal logits give equal probabilities", () => {
    expect(softmax([3, 3])).toEqual([0.5, 0.5]);
  });

  test("sums to one and orders like the logits", () => {
    const logits = new Float32Array([0.2, 1.7]);
    const p = softmax(logits);
    expect((p[0] ?? 0) + (p[1] ?? 0)).toBeCloseTo(1, 12);
    expect(p[1]).toBeGreaterThan(p[0] ?? 1);
    // The logits are float32, so compare with their float32 difference, not 1.5 exactly.
    expect(p[1]).toBeCloseTo(1 / (1 + Math.exp(-((logits[1] ?? 0) - (logits[0] ?? 0)))), 12);
  });

  test("stays finite for logits whose plain exp overflows", () => {
    const p = softmax([1000, 1001]);
    expect(p.every(Number.isFinite)).toBe(true);
    expect(p[1]).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    const q = softmax([-1000, -1000]);
    expect(q).toEqual([0.5, 0.5]);
  });
});

describe("integrity refusals", () => {
  test("the provider version names the pinned revision and digest", () => {
    expect(onnxProviderVersion()).toBe(`${MODEL.revision.slice(0, 8)}:${(MODEL.sha256 ?? "").slice(0, 12)}`);
    expect(onnxProviderVersion()).toMatch(/^[0-9a-f]{8}:[0-9a-f]{12}$/);
  });

  test("a missing model file is refused", async () => {
    const err = await createOnnxClassifier({ modelPath: join(dir, "absent.onnx") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelIntegrityError);
    expect((err as Error).message).toMatch(/missing/);
  });

  test("a file whose sha256 is not the pinned digest is refused before a session is built", async () => {
    const wrong = join(dir, "wrong-sha.onnx");
    // Not a valid ONNX graph either: reaching the session would throw onnxruntime's own error.
    await Bun.write(wrong, "synthetic wrong digest");
    const err = await createOnnxClassifier({ modelPath: wrong }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelIntegrityError);
    expect((err as Error).message).toMatch(/sha256/);
  });

  test("an empty file is refused by digest", async () => {
    const empty = join(dir, "empty.onnx");
    await Bun.write(empty, "");
    await expect(createOnnxClassifier({ modelPath: empty })).rejects.toBeInstanceOf(ModelIntegrityError);
  });
});
