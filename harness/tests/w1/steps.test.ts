// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The W1 scenarios' step selection (src/w1/steps.ts). */
import { describe, expect, test } from "vite-plus/test";
import {
  PENDING_SURGE_STEPS,
  PENDING_TIMELINE_STEPS,
  PENDING_W1_EXTENSIONS,
  SURGE_STEP_NUMBERS,
  SURGE_STEP_PREREQUISITES,
  SURGE_STEPS,
  TIMELINE_STEP_NUMBERS,
  TIMELINE_STEP_PREREQUISITES,
  TIMELINE_STEPS,
  W1_EXTENSIONS,
  allSurgeSteps,
  allTimelineSteps,
  extensionTitle,
  parseSurgeSteps,
  parseTimelineSteps,
  surgeTitle,
  timelineTitle,
  w1Extensions,
  withPrerequisites,
} from "../../src/w1/steps.ts";

describe("step tables", () => {
  test("timeline-sync has four steps and surge-guard seven, as the spec names them", () => {
    expect(TIMELINE_STEP_NUMBERS).toEqual([1, 2, 3, 4]);
    expect(Object.keys(TIMELINE_STEPS).map(Number)).toEqual([1, 2, 3, 4]);
    expect(SURGE_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Object.keys(SURGE_STEPS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(TIMELINE_STEPS[3]).toBe("replay exclusions");
    expect(SURGE_STEPS[6]).toBe("surge trips and reverts");
  });

  test("the extensions are six, in each scenario's order", () => {
    expect(W1_EXTENSIONS).toEqual({
      "e4b-money": ["breakdown", "reconciliation", "fraud-hold"],
      "e2e-social": ["flood", "block"],
      "integrity-basic": ["data-mode"],
    });
  });

  test("pending lists name real steps and extensions", () => {
    for (const s of PENDING_TIMELINE_STEPS) expect(TIMELINE_STEP_NUMBERS).toContain(s);
    for (const s of PENDING_SURGE_STEPS) expect(SURGE_STEP_NUMBERS).toContain(s);
    const all = Object.values(W1_EXTENSIONS).flat() as string[];
    for (const e of PENDING_W1_EXTENSIONS) expect(all).toContain(e);
  });

  test("no W1 step needs another", () => {
    for (const n of TIMELINE_STEP_NUMBERS) expect(TIMELINE_STEP_PREREQUISITES[n]).toEqual([]);
    for (const n of SURGE_STEP_NUMBERS) expect(SURGE_STEP_PREREQUISITES[n]).toEqual([]);
    expect(withPrerequisites([3, 1], TIMELINE_STEP_PREREQUISITES)).toEqual({ steps: [1, 3], added: [] });
  });
});

describe("parsing steps", () => {
  test("all and empty run every step not pending", () => {
    const timeline = TIMELINE_STEP_NUMBERS.filter((n) => !PENDING_TIMELINE_STEPS.includes(n));
    const surge = SURGE_STEP_NUMBERS.filter((n) => !PENDING_SURGE_STEPS.includes(n));
    expect(parseTimelineSteps("all")).toEqual(timeline);
    expect(parseTimelineSteps("")).toEqual(timeline);
    expect(allTimelineSteps()).toEqual(timeline);
    expect(parseSurgeSteps("ALL")).toEqual(surge);
    expect(allSurgeSteps()).toEqual(surge);
  });

  test("a pending step still runs when named", () => {
    expect(parseTimelineSteps("4,1")).toEqual([1, 4]);
    expect(parseSurgeSteps("2-4")).toEqual([2, 3, 4]);
  });

  test("anything else throws so a typo never runs fewer checks", () => {
    expect(() => parseTimelineSteps("5")).toThrow(/not a step/);
    expect(() => parseSurgeSteps("0-3")).toThrow(/bad range/);
    expect(() => parseSurgeSteps("one")).toThrow(/not a step number/);
    expect(() => parseTimelineSteps(",")).toThrow(/no step/);
  });
});

describe("w1Extensions", () => {
  test("default and all run the scenario's extensions that are not pending, in order", () => {
    for (const scenario of Object.keys(W1_EXTENSIONS) as (keyof typeof W1_EXTENSIONS)[]) {
      const want = W1_EXTENSIONS[scenario].filter((e) => !(PENDING_W1_EXTENSIONS as readonly string[]).includes(e));
      expect(w1Extensions(scenario, "")).toEqual(want);
      expect(w1Extensions(scenario, " All ")).toEqual(want);
    }
  });

  test("named extensions run even while pending, in the scenario's order", () => {
    expect(w1Extensions("e4b-money", "fraud-hold, breakdown")).toEqual(["breakdown", "fraud-hold"]);
    expect(w1Extensions("e2e-social", "block")).toEqual(["block"]);
    expect(w1Extensions("integrity-basic", "data-mode")).toEqual(["data-mode"]);
    expect(w1Extensions("e4b-money", "none")).toEqual([]);
  });

  test("another scenario's extension, an unknown name or an empty list throws", () => {
    expect(() => w1Extensions("e4b-money", "flood")).toThrow(/not an extension of e4b-money/);
    expect(() => w1Extensions("e2e-social", "nope")).toThrow(/not an extension/);
    expect(() => w1Extensions("integrity-basic", ",")).toThrow(/no extension/);
  });
});

describe("titles", () => {
  test("number, name and what", () => {
    expect(timelineTitle(4, "run")).toBe("4. retention: run");
    expect(surgeTitle(1, "run")).toBe("1. bots refused: run");
    expect(extensionTitle("fraud-hold", "run")).toBe("w1 fraud-hold: run");
  });
});
