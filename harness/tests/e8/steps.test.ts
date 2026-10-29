// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E8 scenarios' step selection. */
import { describe, expect, test } from "vite-plus/test";
import {
  BOT_STEP_NUMBERS,
  BOT_STEP_PREREQUISITES,
  BOT_STEPS,
  INTERACT_STEP_NUMBERS,
  INTERACT_STEP_PREREQUISITES,
  INTERACT_STEPS,
  PENDING_BOT_STEPS,
  PENDING_INTERACT_STEPS,
  allSteps,
  botTitle,
  interactTitle,
  parseBotSteps,
  parseInteractSteps,
  parseSteps,
  withPrerequisites,
} from "../../src/e8/steps.ts";

const N = [1, 2, 3, 4, 5, 6] as const;

describe("step tables", () => {
  test("six steps each, numbered 1-6, as the spec names them", () => {
    expect(INTERACT_STEP_NUMBERS).toEqual([...N]);
    expect(BOT_STEP_NUMBERS).toEqual([...N]);
    expect(Object.keys(INTERACT_STEPS).map(Number)).toEqual([...N]);
    expect(Object.keys(BOT_STEPS).map(Number)).toEqual([...N]);
    expect(INTERACT_STEPS[3]).toBe("raid");
    expect(BOT_STEPS[4]).toBe("viewbots earn nothing");
  });

  test("pending lists name real steps", () => {
    for (const s of PENDING_INTERACT_STEPS) expect(INTERACT_STEP_NUMBERS).toContain(s);
    for (const s of PENDING_BOT_STEPS) expect(BOT_STEP_NUMBERS).toContain(s);
  });

  test("titles", () => {
    expect(interactTitle(1, "votes counted")).toBe("1. poll: votes counted");
    expect(botTitle(5, "queued")).toBe("5. song requests: queued");
  });
});

describe("parseSteps", () => {
  test("all and empty run every step not pending", () => {
    expect(parseInteractSteps("all")).toEqual(allSteps(INTERACT_STEP_NUMBERS, PENDING_INTERACT_STEPS));
    expect(parseBotSteps("")).toEqual(allSteps(BOT_STEP_NUMBERS, PENDING_BOT_STEPS));
    expect(parseSteps("ALL", N, [2, 4])).toEqual([1, 3, 5, 6]);
    expect(parseSteps("all", N, [...N])).toEqual([]);
  });

  test("lists and ranges, sorted and unique; a pending step can be named explicitly", () => {
    expect(parseSteps(" 5 , 1,5,2 ", N, [...N])).toEqual([1, 2, 5]);
    expect(parseSteps("2-4,6", N, [])).toEqual([2, 3, 4, 6]);
    expect(parseInteractSteps("3")).toEqual([3]);
  });

  test("refuses anything else", () => {
    expect(() => parseSteps("7", N, [])).toThrow(/not a step \(1-6\)/);
    expect(() => parseSteps("0-2", N, [])).toThrow(/bad range/);
    expect(() => parseSteps("4-2", N, [])).toThrow(/bad range/);
    expect(() => parseSteps("one", N, [])).toThrow(/not a step number/);
    expect(() => parseSteps(",", N, [])).toThrow(/no step selected/);
  });
});

describe("withPrerequisites", () => {
  test("no E8 step needs another", () => {
    expect(withPrerequisites([3], INTERACT_STEP_PREREQUISITES)).toEqual({ steps: [3], added: [] });
    expect(withPrerequisites([...N], BOT_STEP_PREREQUISITES)).toEqual({ steps: [...N], added: [] });
  });

  test("adds what a step needs", () => {
    const pre = { 1: [], 2: [1], 3: [1, 2] } as const;
    expect(withPrerequisites([3], pre)).toEqual({ steps: [1, 2, 3], added: [1, 2] });
  });
});
