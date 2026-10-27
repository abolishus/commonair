// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 10: VOD exposure (ADR 0009 amendment 1, docs/testing/w0-selectors.md,
 * "Scenarios"). Stub from the W0 contract step; W0-media-exposure owns this file and implements it.
 */
import type { Run } from "./safety-run.ts";

export async function runVodExposureStep(_run: Run): Promise<void> {
  throw new Error("W0-media-exposure not merged");
}
