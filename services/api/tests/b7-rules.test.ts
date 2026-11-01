// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 seams that need two packages at once: `packages/federation` keeps no dependency on
 * contracts, so its date-skew constant is checked against `FEDERATION_RULES` here; and the three
 * jury governance settings are shape-checked when a co-op proposal is drafted.
 */
import { describe, expect, test } from "vite-plus/test";
import { FEDERATION_RULES } from "@commonair/contracts/enums";
import { DEFAULT_GOVERNANCE_SETTINGS } from "@commonair/db";
import { DATE_SKEW_SECONDS } from "@commonair/federation";
import { classifyDraft } from "../src/coop/shared.ts";

const SETTINGS = Object.fromEntries(DEFAULT_GOVERNANCE_SETTINGS.map((s) => [s.key, s.value]));

describe("federation rules", () => {
  test("packages/federation DATE_SKEW_SECONDS is FEDERATION_RULES.dateSkewSeconds", () => {
    expect(DATE_SKEW_SECONDS).toBe(FEDERATION_RULES.dateSkewSeconds);
  });
});

describe("jury governance settings are shape-checked in drafts", () => {
  test.each([
    ["jury.enabled", { enabled: true }, { enabled: "yes" }],
    ["jury.panelSize", { panelSize: 9 }, { panelSize: 2 }],
    ["jury.casesPerPanel", { casesPerPanel: 30 }, { casesPerPanel: 101 }],
  ])("%s", (key, good, bad) => {
    expect(key in SETTINGS).toBe(true);
    expect(classifyDraft([{ key, value: good }], false, SETTINGS).ok).toBe(true);
    expect(classifyDraft([{ key, value: bad }], false, SETTINGS)).toEqual({
      ok: false,
      reason: `The new value of ${key} does not have the setting's shape`,
    });
  });
});
