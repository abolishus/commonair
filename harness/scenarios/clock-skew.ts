// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ADR 0012 (media clock): cross-rendition skew p95 < 100 ms and live-to-VOD skew p95 < 250 ms
 * (metrics `crossRenditionSkewP95Ms`, `liveToVodSkewP95Ms`; data `baseline` with
 * `--set assert=false`; docs/testing/w0-selectors.md). Stub from the W0 contract step: W0-clock
 * owns this file and implements it; the orchestrator adds it to `FULL_REQUIRED` and a shard once
 * it has merged.
 */
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "clock-skew",
  description: "cross-rendition skew < 100 ms and live-to-VOD < 250 ms (ADR 0012)",
  needs: ["api", "mail", "media", "origin", "ffmpeg", "whip"],
  inFull: false,
  timeoutMs: 15 * 60_000,
  run() {
    throw new Error("clock-skew: not built yet (W0-clock)");
  },
});
