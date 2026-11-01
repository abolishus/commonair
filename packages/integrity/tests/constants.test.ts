// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXCLUSION_CATEGORIES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import {
  ALLOWED_ON_APPEAL,
  AUDIENCE_SETTLE_SECONDS,
  categoryOfReason,
  DEFAULT_FINALIZE_SECONDS,
  exclusionCategoryOf,
  FETCH_UNJUDGED,
  INSUFFICIENT_HEARTBEATS,
  MEDIA_UNCONFIRMED,
  RULESET_VERSION,
  SESSION_SIGNALS,
  SIGNAL_CATEGORIES,
} from "../src/index.ts";

describe("integrity constants (ADR 0014 decision 3)", () => {
  test("settle outlasts the finalize window; the ruleset version is a positive integer", () => {
    expect(DEFAULT_FINALIZE_SECONDS).toBe(3600);
    expect(AUDIENCE_SETTLE_SECONDS).toBeGreaterThan(DEFAULT_FINALIZE_SECONDS);
    expect(Number.isInteger(RULESET_VERSION) && RULESET_VERSION > 0).toBe(true);
  });
});

describe("signal categories (decision (k))", () => {
  test("every session signal has a category from EXCLUSION_CATEGORIES", () => {
    expect(Object.keys(SIGNAL_CATEGORIES).sort()).toEqual([...SESSION_SIGNALS].sort());
    for (const c of Object.values(SIGNAL_CATEGORIES)) expect(EXCLUSION_CATEGORIES).toContain(c);
  });

  test("non-signal reasons have no category", () => {
    for (const r of [INSUFFICIENT_HEARTBEATS, MEDIA_UNCONFIRMED, ALLOWED_ON_APPEAL, FETCH_UNJUDGED, "toString"])
      expect(categoryOfReason(r)).toBeNull();
  });

  test("a session's category is its first signal reason's; none known is other", () => {
    expect(exclusionCategoryOf(["datacenter_ip", "headless"])).toBe("datacenter");
    expect(exclusionCategoryOf([FETCH_UNJUDGED, "headless", "datacenter_ip"])).toBe("automation");
    expect(exclusionCategoryOf(["account_concurrency"])).toBe("concurrency");
    expect(exclusionCategoryOf([])).toBe("other");
    expect(exclusionCategoryOf([INSUFFICIENT_HEARTBEATS, "retired_code"])).toBe("other");
  });
});
