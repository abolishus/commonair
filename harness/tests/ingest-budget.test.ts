// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  MAX_GLASS_TO_GLASS_MS,
  MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS,
  glassToGlassBudgetMs,
} from "../scenarios/_ingest.ts";

describe("glass-to-glass budgets", () => {
  test("only WHIP into WebKit gets the wider budget", () => {
    expect(glassToGlassBudgetMs("whip", "webkit")).toBe(MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS);
    expect(MAX_GLASS_TO_GLASS_WHIP_WEBKIT_MS).toBe(20_000);
    expect(glassToGlassBudgetMs("whip", "chromium")).toBe(MAX_GLASS_TO_GLASS_MS);
    expect(glassToGlassBudgetMs("rtmp", "webkit")).toBe(MAX_GLASS_TO_GLASS_MS);
    expect(glassToGlassBudgetMs("rtmp", "chromium")).toBe(15_000);
  });
});
