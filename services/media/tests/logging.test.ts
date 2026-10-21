// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { captureLogger } from "./helpers/moderation.ts";
import { errorCategory } from "../src/moderation/logging.ts";

describe("media log error categories", () => {
  test("captured logs keep only fixed error classes, never exception messages or object keys", () => {
    const { logger, lines } = captureLogger();
    const objectKey = "vods/private-vod/segment-secret.m4s";
    const err = new Error(`PUT ${objectKey} failed at https://storage.invalid/private?token=secret`);
    logger.warn("segment upload failed", { error: errorCategory(err) });

    const serialized = lines.join("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ error: "Error" });
    expect(serialized).not.toContain(err.message);
    expect(serialized).not.toContain(objectKey);
    expect(serialized).not.toContain("storage.invalid");
    expect(serialized).not.toContain("secret");
  });
});
