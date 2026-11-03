// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  FIRST_HEARTBEAT_WAIT_MS,
  INGEST_VIEWER_TIMING,
  MAX_GLASS_TO_GLASS_MS,
  MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS,
  glassToGlassBudgetMs,
} from "../scenarios/_ingest.ts";
import { HUMAN_TIMING, nextHeartbeatDelay } from "../src/fingerprint.ts";

describe("glass-to-glass budgets", () => {
  test("only WHIP into WebKit gets the wider budget", () => {
    expect(glassToGlassBudgetMs("whip", "webkit")).toBe(MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS);
    expect(MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS).toBe(20_000);
    expect(glassToGlassBudgetMs("whip", "chromium")).toBe(MAX_GLASS_TO_GLASS_MS);
    expect(glassToGlassBudgetMs("rtmp", "webkit")).toBe(MAX_GLASS_TO_GLASS_MS);
    expect(glassToGlassBudgetMs("rtmp", "chromium")).toBe(15_000);
  });
});

describe("ingest viewers' first heartbeat", () => {
  // The wait starts after TTFF and latency sampling, so this is a bound, not the expected case.
  test("steady timing always beats inside the wait", () => {
    for (const r of [0, 0.5, 0.999999]) {
      expect(nextHeartbeatDelay(10_000, INGEST_VIEWER_TIMING, () => r)).toBeLessThan(FIRST_HEARTBEAT_WAIT_MS);
    }
  });

  test("human timing can miss it (CI runs 41490048809, 41721879712): a late first beat", () => {
    const draws = [0.5, 0, 0.9];
    let i = 0;
    expect(nextHeartbeatDelay(10_000, HUMAN_TIMING, () => draws[i++] ?? 0)).toBeGreaterThan(FIRST_HEARTBEAT_WAIT_MS);
  });
});
