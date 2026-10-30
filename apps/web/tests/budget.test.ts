// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The data-mode budget controller (ADR 0018; the budget table in the W1 contract step §8.3). */
import { describe, expect, it } from "vite-plus/test";
import { DATA_MODE, dataModeCeilingBps } from "@commonair/contracts/enums";
import {
  AUDIO_PRESET,
  DATA_MODE_STORAGE_KEY,
  DEFAULT_PRESET,
  DERIVED_AUDIO_BPS,
  capIndex,
  ceilingOf,
  clampBudget,
  connectionHints,
  estimateMbPerHour,
  isPreset,
  mbPerHourOf,
  nominalLevels,
  planBudget,
  readDataModeChoice,
  saveDataModeChoice,
  suggestedPreset,
  type LevelInfo,
} from "../src/player/budget.ts";

/** The ladder in code (services/media transcode/ladder.ts) as hls.js lists it: ascending bitrate. */
const LADDER: LevelInfo[] = [
  { bitrate: 96_000, audioOnly: true },
  { bitrate: 1_296_000, audioOnly: false },
  { bitrate: 3_128_000, audioOnly: false },
  { bitrate: 6_160_000, audioOnly: false },
];
/** hls.js drops audio-only levels when video ones exist: the ladder as it plays. */
const VIDEO_ONLY: LevelInfo[] = LADDER.filter((l) => !l.audioOnly);

describe("ceilings (contract step §8.3)", () => {
  it("each preset's ceiling", () => {
    expect(DATA_MODE.presetsMbPerHour).toEqual([50, 800, 1900]);
    expect(ceilingOf({ on: true, mbPerHour: 50 })).toBe(96_618);
    expect(ceilingOf({ on: true, mbPerHour: 800 })).toBe(1_545_894);
    expect(ceilingOf({ on: true, mbPerHour: 1900 })).toBe(3_671_498);
  });

  it("off has no ceiling, whatever the budget", () => {
    expect(ceilingOf({ on: false, mbPerHour: 50 })).toBeNull();
    expect(ceilingOf(null)).toBeNull();
  });

  it("custom budgets are clamped to the bounds, which stay inside the claim's range", () => {
    expect(clampBudget(DATA_MODE.minMbPerHour - 5)).toBe(DATA_MODE.minMbPerHour);
    expect(clampBudget(DATA_MODE.maxMbPerHour + 5)).toBe(DATA_MODE.maxMbPerHour);
    expect(clampBudget(123.6)).toBe(124);
    expect(clampBudget(Number.NaN)).toBeNull();
    expect(clampBudget(Number.POSITIVE_INFINITY)).toBeNull();
    const low = ceilingOf({ on: true, mbPerHour: 1 });
    const high = ceilingOf({ on: true, mbPerHour: 1e9 });
    expect(low).toBe(dataModeCeilingBps(DATA_MODE.minMbPerHour));
    expect(high).toBe(dataModeCeilingBps(DATA_MODE.maxMbPerHour));
    expect(low).toBeGreaterThanOrEqual(DATA_MODE.minCeilingBps);
    expect(high).toBeLessThanOrEqual(DATA_MODE.maxCeilingBps);
    expect(ceilingOf({ on: true, mbPerHour: Number.NaN })).toBeNull();
  });

  it("presets are recognised; anything else is custom", () => {
    expect(isPreset(50)).toBe(true);
    expect(isPreset(1900)).toBe(true);
    expect(isPreset(51)).toBe(false);
  });
});

describe("capIndex", () => {
  it("the highest level under the ceiling", () => {
    expect(capIndex(LADDER, dataModeCeilingBps(800))).toBe(1);
    expect(capIndex(LADDER, dataModeCeilingBps(1900))).toBe(2);
    expect(capIndex(LADDER, 6_160_000)).toBe(3);
    expect(capIndex(LADDER, 6_159_999)).toBe(2);
    expect(capIndex(VIDEO_ONLY, dataModeCeilingBps(800))).toBe(0);
  });

  it("the audio-only level when nothing fits; the lowest when there is none", () => {
    const derived: LevelInfo[] = [
      { bitrate: 192_000, audioOnly: true },
      { bitrate: 2_100_000, audioOnly: false },
    ];
    expect(capIndex(derived, dataModeCeilingBps(50))).toBe(0);
    expect(capIndex(VIDEO_ONLY, dataModeCeilingBps(50))).toBe(0);
    const unsorted: LevelInfo[] = [
      { bitrate: 3_000_000, audioOnly: false },
      { bitrate: 1_300_000, audioOnly: false },
    ];
    expect(capIndex(unsorted, 100_000)).toBe(1);
  });

  it("no cap when off or without levels", () => {
    expect(capIndex(LADDER, null)).toBe(-1);
    expect(capIndex([], 96_618)).toBe(-1);
  });
});

describe("planBudget", () => {
  it("estimates MB an hour as bitrate × 0.45 × the overhead factor", () => {
    expect(mbPerHourOf(1_000_000)).toBeCloseTo(450);
    expect(estimateMbPerHour(96_000)).toBeCloseTo(43.2 * DATA_MODE.overheadFactor);
    const plan = planBudget(800, LADDER);
    expect(plan).toMatchObject({ ceiling: 1_545_894, capIndex: 1, overBudget: false });
    expect(plan.estimateMbPerHour).toBeCloseTo(583.2 * DATA_MODE.overheadFactor);
  });

  it("the Audio preset on the ladder: the audio rung, within budget (≈ 50 MB/h)", () => {
    const plan = planBudget(50, LADDER);
    expect(plan.level).toEqual({ bitrate: 96_000, audioOnly: true });
    expect(plan.overBudget).toBe(false);
    expect(plan.estimateMbPerHour).toBeLessThanOrEqual(50);
  });

  it("the audio floor over budget: a source-only channel's derived variant, or a tiny custom budget", () => {
    const derived = nominalLevels(["source"]);
    const audio = planBudget(50, derived);
    expect(audio.level).toEqual({ bitrate: DERIVED_AUDIO_BPS, audioOnly: true });
    expect(audio.overBudget).toBe(true);
    expect(planBudget(20, LADDER).overBudget).toBe(true);
  });

  it("no levels yet: no estimate and not over budget", () => {
    expect(planBudget(50, [])).toMatchObject({ capIndex: -1, level: null, estimateMbPerHour: null, overBudget: false });
  });

  it("an unreadable budget plans the default preset", () => {
    expect(planBudget(Number.NaN, LADDER).ceiling).toBe(dataModeCeilingBps(DEFAULT_PRESET));
  });
});

describe("nominalLevels (native HLS)", () => {
  it("the ladder's rungs for the advertised renditions, ascending; the source is unknown", () => {
    expect(nominalLevels(["source", "720p", "480p", "audio"])).toEqual([
      { bitrate: 96_000, audioOnly: true },
      { bitrate: 1_296_000, audioOnly: false },
      { bitrate: 3_128_000, audioOnly: false },
    ]);
  });

  it("without an audio rendition, the origin's derived audio-only variant", () => {
    expect(nominalLevels(["source"])).toEqual([{ bitrate: DERIVED_AUDIO_BPS, audioOnly: true }]);
    expect(nominalLevels([])).toEqual([{ bitrate: DERIVED_AUDIO_BPS, audioOnly: true }]);
  });
});

describe("suggestions", () => {
  it("Save-Data or a slow connection suggests the Audio preset", () => {
    expect(suggestedPreset({ saveData: true })).toBe(AUDIO_PRESET);
    for (const effectiveType of ["slow-2g", "2g", "3g"]) expect(suggestedPreset({ effectiveType })).toBe(AUDIO_PRESET);
  });

  it("a fast connection, or no information, suggests nothing", () => {
    expect(suggestedPreset({ effectiveType: "4g", saveData: false })).toBeNull();
    expect(suggestedPreset({})).toBeNull();
    expect(suggestedPreset(null)).toBeNull();
  });

  it("reads navigator.connection where it exists", () => {
    expect(connectionHints({ connection: { saveData: true, effectiveType: "4g" } } as unknown as Navigator)).toEqual({
      saveData: true,
      effectiveType: "4g",
    });
    expect(connectionHints({} as Navigator)).toBeNull();
  });
});

/** An in-memory Storage. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("the saved choice", () => {
  it("nothing saved: off, on the default preset, or the Audio preset when suggested", () => {
    expect(readDataModeChoice(memory())).toEqual({
      choice: { on: false, mbPerHour: DEFAULT_PRESET },
      saved: false,
      suggested: null,
    });
    expect(readDataModeChoice(memory(), { saveData: true })).toEqual({
      choice: { on: false, mbPerHour: AUDIO_PRESET },
      saved: false,
      suggested: AUDIO_PRESET,
    });
  });

  it("round-trips, and the viewer's saved choice wins over a suggestion", () => {
    const s = memory();
    expect(saveDataModeChoice(s, { on: true, mbPerHour: 1900 })).toBe(true);
    expect(JSON.parse(s.data.get(DATA_MODE_STORAGE_KEY) ?? "")).toEqual({ on: true, mbPerHour: 1900 });
    expect(readDataModeChoice(s, { saveData: true })).toMatchObject({
      choice: { on: true, mbPerHour: 1900 },
      saved: true,
    });
    saveDataModeChoice(s, { on: false, mbPerHour: 50 });
    expect(readDataModeChoice(s).choice).toEqual({ on: false, mbPerHour: 50 });
  });

  it("a saved custom budget is clamped; corrupt or partial values fall back", () => {
    expect(readDataModeChoice(memory({ [DATA_MODE_STORAGE_KEY]: '{"on":true,"mbPerHour":99999}' })).choice).toEqual({
      on: true,
      mbPerHour: DATA_MODE.maxMbPerHour,
    });
    for (const raw of ["{", "null", '{"on":"yes","mbPerHour":50}', '{"on":true}', '{"on":true,"mbPerHour":"50"}'])
      expect(readDataModeChoice(memory({ [DATA_MODE_STORAGE_KEY]: raw })).saved).toBe(false);
  });

  it("storage that throws (private mode, blocked site data) is survived", () => {
    expect(readDataModeChoice(throwing, { effectiveType: "2g" })).toEqual({
      choice: { on: false, mbPerHour: AUDIO_PRESET },
      saved: false,
      suggested: AUDIO_PRESET,
    });
    expect(saveDataModeChoice(throwing, { on: true, mbPerHour: 50 })).toBe(false);
    expect(readDataModeChoice(null).saved).toBe(false);
    expect(saveDataModeChoice(null, { on: true, mbPerHour: 50 })).toBe(false);
    expect(saveDataModeChoice(memory(), { on: true, mbPerHour: Number.NaN })).toBe(false);
  });
});
