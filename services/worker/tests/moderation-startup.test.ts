// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ValkeyClient } from "@commonair/service";
import { resolveModeration } from "../src/moderation/runtime.ts";
import { buildModerationOptions } from "../src/moderation/startup.ts";

async function syntheticPublicKey() {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return Buffer.from(raw).toString("base64");
}

describe("worker moderation startup", () => {
  test("composes sealing, worker-only evidence storage and scripted classifier under test hooks", async () => {
    const options = await buildModerationOptions({
      S3_ENDPOINT: "http://127.0.0.1:3900",
      S3_REGION: "garage",
      S3_FORCE_PATH_STYLE: true,
      S3_BUCKET_EVIDENCE: "synthetic-evidence",
      S3_EVIDENCE_ACCESS_KEY_ID: "synthetic-evidence-key",
      S3_EVIDENCE_SECRET_ACCESS_KEY: "synthetic-evidence-secret",
      EVIDENCE_PUBLIC_KEY: await syntheticPublicKey(),
      MODERATION_CLASSIFIER: "scripted",
      MODERATION_CLASSIFIER_MODEL: "",
      MODERATION_SAMPLE_SECONDS: 2,
      MODERATION_TEST_HOOKS: true,
    });
    const runtime = resolveModeration(options, {} as ValkeyClient);

    expect(runtime.classifier.provider).toBe("scripted");
    expect(runtime.sealing.keyId).toMatch(/^[a-f0-9]{32}$/);
    expect(runtime.evidenceStorage).toBeDefined();
    expect(runtime.evidenceBucket).toBe("synthetic-evidence");
    expect(runtime.envSampleSeconds).toBe(2);
    expect(runtime.testHooks).toBe(true);
  });

  test("refuses the scripted classifier without test hooks", async () => {
    await expect(
      buildModerationOptions({
        S3_ENDPOINT: "http://127.0.0.1:3900",
        S3_REGION: "garage",
        S3_FORCE_PATH_STYLE: true,
        S3_BUCKET_EVIDENCE: "synthetic-evidence",
        S3_EVIDENCE_ACCESS_KEY_ID: "synthetic-evidence-key",
        S3_EVIDENCE_SECRET_ACCESS_KEY: "synthetic-evidence-secret",
        EVIDENCE_PUBLIC_KEY: await syntheticPublicKey(),
        MODERATION_CLASSIFIER: "scripted",
        MODERATION_CLASSIFIER_MODEL: "",
        MODERATION_SAMPLE_SECONDS: 2,
        MODERATION_TEST_HOOKS: false,
      }),
    ).rejects.toThrow("scripted moderation classifier requires test hooks");
  });
});
