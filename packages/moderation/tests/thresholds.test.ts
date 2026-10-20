// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { MODERATION_CONSTANTS } from "../src/constants.ts";
import {
  DEFAULT_THRESHOLDS,
  effectiveSampleSeconds,
  parseThresholds,
  tierFor,
  validThresholds,
} from "../src/thresholds.ts";

const seed = {
  t1: { sexual: 0.97, graphic_violence: 0.9, weapons: 0.95, self_harm: 0.9 },
  t2: { sexual: 0.8 },
  sampleSeconds: 10,
};
const withT1 = (k: string, v: unknown) => ({ ...seed, t1: { ...seed.t1, [k]: v } });

describe("thresholds", () => {
  test("the governance seed is valid and equals the defaults", () => {
    expect(validThresholds(seed)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds(seed).valid).toBe(true);
  });

  test("boundaries are inclusive and match the database ranges", () => {
    expect(validThresholds(withT1("sexual", 0.85))).not.toBeNull();
    expect(validThresholds(withT1("sexual", 0.995))).not.toBeNull();
    expect(validThresholds(withT1("sexual", 0.849))).toBeNull();
    expect(validThresholds(withT1("sexual", 0.996))).toBeNull();
    expect(validThresholds(withT1("weapons", 0.5))).not.toBeNull();
    expect(validThresholds(withT1("weapons", 0.49))).toBeNull();
    expect(validThresholds({ ...seed, t2: { sexual: 0.5 } })).not.toBeNull();
    expect(validThresholds({ ...seed, t2: { sexual: 0.951 } })).toBeNull();
    expect(validThresholds({ ...seed, sampleSeconds: 5 })).not.toBeNull();
    expect(validThresholds({ ...seed, sampleSeconds: 60 })).not.toBeNull();
    expect(validThresholds({ ...seed, sampleSeconds: 4 })).toBeNull();
    expect(validThresholds({ ...seed, sampleSeconds: 10.5 })).toBeNull();
  });

  test("t2.sexual must be strictly below t1.sexual", () => {
    const t = { ...seed, t1: { ...seed.t1, sexual: 0.9 }, t2: { sexual: 0.9 } };
    expect(validThresholds(t)).toBeNull();
    expect(validThresholds({ ...t, t2: { sexual: 0.89 } })).not.toBeNull();
  });

  test("anything missing or mistyped falls back to the defaults (fail closed)", () => {
    for (const bad of [
      null,
      undefined,
      "x",
      {},
      { t1: seed.t1, t2: seed.t2 },
      withT1("self_harm", undefined),
      withT1("sexual", "0.9"),
      withT1("sexual", Number.NaN),
      withT1("sexual", Infinity),
      { ...seed, t2: null },
    ]) {
      expect(parseThresholds(bad)).toEqual({ thresholds: DEFAULT_THRESHOLDS, valid: false });
    }
  });

  test("the effective interval is the smaller of env and setting", () => {
    expect(effectiveSampleSeconds(2, DEFAULT_THRESHOLDS)).toBe(2);
    expect(effectiveSampleSeconds(60, DEFAULT_THRESHOLDS)).toBe(10);
  });
});

describe("tierFor", () => {
  const T = DEFAULT_THRESHOLDS;
  test("unscored categories never fire, and an empty result is T3", () => {
    expect(tierFor({}, T, { mature: false })).toEqual({ tier: null });
    expect(tierFor({ weapons: 0.2 }, T, { mature: false })).toEqual({ tier: null });
  });
  test("T1 at or above the threshold, mature or not", () => {
    expect(tierFor({ sexual: 0.97 }, T, { mature: false })).toEqual({ tier: "t1", category: "sexual", score: 0.97 });
    expect(tierFor({ sexual: 0.99 }, T, { mature: true })).toMatchObject({ tier: "t1" });
    expect(tierFor({ sexual: 0.9699 }, T, { mature: false })).toMatchObject({ tier: "t2" });
  });
  test("T2 only on a channel not labelled mature", () => {
    expect(tierFor({ sexual: 0.8 }, T, { mature: false })).toEqual({ tier: "t2", category: "sexual", score: 0.8 });
    expect(tierFor({ sexual: 0.85 }, T, { mature: true })).toEqual({ tier: null });
    expect(tierFor({ sexual: 0.7999 }, T, { mature: false })).toEqual({ tier: null });
  });
  test("T1 beats T2, and the category furthest above its threshold wins", () => {
    expect(tierFor({ sexual: 0.85, weapons: 0.96 }, T, { mature: false })).toMatchObject({
      tier: "t1",
      category: "weapons",
    });
    expect(tierFor({ sexual: 0.995, graphic_violence: 0.91 }, T, { mature: false })).toMatchObject({
      category: "sexual",
    });
    expect(tierFor({ sexual: Number.NaN }, T, { mature: false })).toEqual({ tier: null });
  });
  test("legal floors are code constants", () => {
    expect(MODERATION_CONSTANTS).toMatchObject({
      PDQ_MATCH_DISTANCE: 31,
      PDQ_MIN_QUALITY: 50,
      NCII_ESCALATE_FIRST_HOURS: 24,
      NCII_ESCALATE_SECOND_HOURS: 36,
      NCII_DEADLINE_HOURS: 48,
      FRAME_TTL_SECONDS: 60,
    });
  });
});
