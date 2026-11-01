// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CAPTIONS_MODEL } from "../../packages/captions/src/model.ts";
import { MODEL } from "../../packages/moderation/src/model.ts";
import { checkDigest, modelTarget, parseModelArgs, type ModelTarget } from "../fetch-model.ts";

const SHA = "a".repeat(64);

describe("fetch-model", () => {
  test("the default model is still the classifier, unchanged", () => {
    expect(parseModelArgs([])).toEqual({ name: "moderation", out: undefined, force: false });
    const t = modelTarget("moderation");
    expect(t.sha256).toBe(MODEL.sha256);
    expect(t.digestRequired).toBe(false);
    expect(t.url).toContain(MODEL.revision);
  });

  test("--model captions selects the pinned whisper weights", () => {
    expect(parseModelArgs(["--model", "captions", "--force", "--out", "/tmp/x"])).toEqual({
      name: "captions",
      out: "/tmp/x",
      force: true,
    });
    const t = modelTarget("captions");
    expect(t.sha256).toBe(CAPTIONS_MODEL.sha256);
    expect(t.digestRequired).toBe(true);
    expect(t.url).toContain(`${CAPTIONS_MODEL.revision}/ggml-base-q5_1.bin`);
    expect(t.defaultPath.endsWith(".cache/models/whisper-ggml-base-q5_1.bin")).toBe(true);
    expect(() => parseModelArgs(["--model", "other"])).toThrow(/unknown --model/);
  });

  test("captions: a null digest and a mismatch are refused", () => {
    const pinned = modelTarget("captions");
    const unpinned: ModelTarget = { ...pinned, sha256: null };
    expect(checkDigest(unpinned, SHA)).toEqual({ ok: false, reason: expect.stringMatching(/no pinned sha256/) });
    expect(checkDigest(pinned, SHA)).toEqual({ ok: false, reason: expect.stringMatching(/mismatch/) });
    expect(checkDigest(pinned, CAPTIONS_MODEL.sha256 ?? "")).toEqual({ ok: true });
  });

  test("moderation keeps its null-digest tolerance (a warning) and refuses a mismatch", () => {
    const pinned = modelTarget("moderation");
    const unpinned: ModelTarget = { ...pinned, sha256: null };
    expect(checkDigest(unpinned, SHA)).toEqual({ ok: true, warning: expect.stringMatching(/no pinned digest yet/) });
    expect(checkDigest(pinned, SHA).ok).toBe(false);
    expect(checkDigest(pinned, MODEL.sha256 ?? "")).toEqual({ ok: true });
  });
});
