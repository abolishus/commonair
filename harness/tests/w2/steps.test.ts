// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The W2 scenarios' step selection and extension wiring (src/w2/steps.ts). */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { SAFETY_STEP_NUMBERS } from "../../src/safety.ts";
import { FULL_SHARDS } from "../../src/shards.ts";
import { FULL_REQUIRED, loadRegistry, shardOf } from "../../src/registry.ts";
import { TIMELINE_STEP_NUMBERS } from "../../src/w1/steps.ts";
import { CAPTIONS_STEP_RUNNERS } from "../../src/w2/captions/index.ts";
import { DVR_STEP_RUNNERS } from "../../src/w2/dvr/index.ts";
import { REHEARSAL_STEP_RUNNERS } from "../../src/w2/rehearsal/index.ts";
import {
  CAPTIONS_STEP_NUMBERS,
  CAPTIONS_STEPS,
  DVR_STEP_NUMBERS,
  DVR_STEPS,
  PENDING_CAPTIONS_STEPS,
  PENDING_DVR_STEPS,
  PENDING_REHEARSAL_STEPS,
  PENDING_W2_EXTENSIONS,
  REHEARSAL_STEP_NUMBERS,
  REHEARSAL_STEP_PREREQUISITES,
  REHEARSAL_STEPS,
  W2_EXTENSION_PREREQUISITES,
  W2_EXTENSION_UNITS,
  W2_EXTENSIONS,
  W2_SCENARIO_STEP_PREREQUISITES,
  type W2ExtendedScenario,
  type W2Extension,
  allCaptionsSteps,
  allDvrSteps,
  allRehearsalSteps,
  captionsTitle,
  dvrTitle,
  parseCaptionsSteps,
  parseDvrSteps,
  parseRehearsalSteps,
  rehearsalTitle,
  w2ExtensionTitle,
  w2Extensions,
  w2StepsNeeded,
  withPrerequisites,
  withW2Steps,
} from "../../src/w2/steps.ts";

const SCENARIOS = Object.keys(W2_EXTENSIONS) as W2ExtendedScenario[];
const ALL_EXTENSIONS = Object.values(W2_EXTENSIONS).flat() as W2Extension[];
const scenarioOf = (e: W2Extension): W2ExtendedScenario =>
  SCENARIOS.find((s) => (W2_EXTENSIONS[s] as readonly string[]).includes(e)) as W2ExtendedScenario;
const source = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

describe("new scenarios' step tables", () => {
  test("captions has eight steps, live-dvr and rehearsal seven, numbered from 1", () => {
    expect(CAPTIONS_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.keys(CAPTIONS_STEPS).map(Number)).toEqual([...CAPTIONS_STEP_NUMBERS]);
    expect(DVR_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Object.keys(DVR_STEPS).map(Number)).toEqual([...DVR_STEP_NUMBERS]);
    expect(REHEARSAL_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Object.keys(REHEARSAL_STEPS).map(Number)).toEqual([...REHEARSAL_STEP_NUMBERS]);
  });

  test("pending lists name real steps; every step is pending until its unit merges", () => {
    for (const s of PENDING_CAPTIONS_STEPS) expect(CAPTIONS_STEP_NUMBERS).toContain(s);
    for (const s of PENDING_DVR_STEPS) expect(DVR_STEP_NUMBERS).toContain(s);
    for (const s of PENDING_REHEARSAL_STEPS) expect(REHEARSAL_STEP_NUMBERS).toContain(s);
  });

  test("every step has a runner in its unit's module", () => {
    expect(Object.keys(CAPTIONS_STEP_RUNNERS).map(Number)).toEqual([...CAPTIONS_STEP_NUMBERS]);
    expect(Object.keys(DVR_STEP_RUNNERS).map(Number)).toEqual([...DVR_STEP_NUMBERS]);
    expect(Object.keys(REHEARSAL_STEP_RUNNERS).map(Number)).toEqual([...REHEARSAL_STEP_NUMBERS]);
  });

  test("all runs every step not pending; a pending step runs when named", () => {
    const notPending = <S extends number>(ns: readonly S[], p: readonly S[]) => ns.filter((n) => !p.includes(n));
    expect(allCaptionsSteps()).toEqual(notPending(CAPTIONS_STEP_NUMBERS, PENDING_CAPTIONS_STEPS));
    expect(parseCaptionsSteps("")).toEqual(allCaptionsSteps());
    expect(allDvrSteps()).toEqual(notPending(DVR_STEP_NUMBERS, PENDING_DVR_STEPS));
    expect(allRehearsalSteps()).toEqual(notPending(REHEARSAL_STEP_NUMBERS, PENDING_REHEARSAL_STEPS));
    expect(parseCaptionsSteps("8,2")).toEqual([2, 8]);
    expect(parseDvrSteps("2-4")).toEqual([2, 3, 4]);
    expect(parseRehearsalSteps("all")).toEqual(allRehearsalSteps());
  });

  test("a typo throws instead of running fewer checks", () => {
    expect(() => parseCaptionsSteps("9")).toThrow(/not a step/);
    expect(() => parseDvrSteps("0-3")).toThrow(/bad range/);
    expect(() => parseRehearsalSteps("one")).toThrow(/not a step number/);
  });

  test("rehearsal checks add step 1, which arms and publishes", () => {
    for (const n of REHEARSAL_STEP_NUMBERS.filter((n) => n !== 1)) expect(REHEARSAL_STEP_PREREQUISITES[n]).toEqual([1]);
    expect(withPrerequisites([4, 6], REHEARSAL_STEP_PREREQUISITES)).toEqual({ steps: [1, 4, 6], added: [1] });
  });

  test("titles", () => {
    expect(captionsTitle(3, "run")).toBe("3. cue timing: run");
    expect(dvrTitle(7, "run")).toBe("7. vods off means no dvr: run");
    expect(rehearsalTitle(1, "run")).toBe("1. arm and publish: run");
  });
});

describe("extensions", () => {
  test("the four extended scenarios and their steps, in order", () => {
    expect(W2_EXTENSIONS).toEqual({
      "e4b-money": ["split-release", "split-clawback", "split-won-chargeback", "split-new-payee"],
      "integrity-basic": ["group", "signed", "tamper", "group-appeal"],
      "trust-safety": ["enforcement"],
      "timeline-sync": ["replay-panel"],
    });
    expect(new Set(ALL_EXTENSIONS).size).toBe(ALL_EXTENSIONS.length);
  });

  test("every extension names its unit and a module that exists", () => {
    expect(Object.keys(W2_EXTENSION_UNITS).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS) expect(source(`src/w2/${W2_EXTENSION_UNITS[e].file}`)).toContain("export");
  });

  test("pending names real extensions", () => {
    for (const e of PENDING_W2_EXTENSIONS) expect(ALL_EXTENSIONS).toContain(e);
  });

  test("prerequisites stay in the extension's own scenario, and a merged one never needs a pending one", () => {
    expect(Object.keys(W2_EXTENSION_PREREQUISITES).sort()).toEqual([...ALL_EXTENSIONS].sort());
    const pairs = ALL_EXTENSIONS.flatMap((e) => W2_EXTENSION_PREREQUISITES[e].map((p) => [e, p] as const));
    for (const [e, p] of pairs) expect(scenarioOf(p), `${e} → ${p}`).toBe(scenarioOf(e));
    const mergedOnPending = pairs.filter(
      ([e, p]) => !PENDING_W2_EXTENSIONS.includes(e) && PENDING_W2_EXTENSIONS.includes(p),
    );
    expect(mergedOnPending).toEqual([]);
  });

  test("scenario steps an extension needs are real steps of its scenario", () => {
    const steps: Record<W2ExtendedScenario, readonly number[]> = {
      "e4b-money": [],
      "integrity-basic": [],
      "trust-safety": SAFETY_STEP_NUMBERS,
      "timeline-sync": TIMELINE_STEP_NUMBERS,
    };
    for (const e of ALL_EXTENSIONS)
      for (const n of W2_SCENARIO_STEP_PREREQUISITES[e]) expect(steps[scenarioOf(e)], `${e} → ${n}`).toContain(n);
    expect(W2_SCENARIO_STEP_PREREQUISITES.enforcement).toEqual([4, 5]);
    expect(W2_SCENARIO_STEP_PREREQUISITES["replay-panel"]).toEqual([1, 3]);
  });
});

describe("w2Extensions", () => {
  test("empty and all run every extension not pending, with what they need", () => {
    for (const s of SCENARIOS) {
      const own = W2_EXTENSIONS[s] as readonly W2Extension[];
      const merged = own.filter((e) => !PENDING_W2_EXTENSIONS.includes(e));
      expect(w2Extensions(s, "").run).toEqual(merged);
      expect(w2Extensions(s, "ALL").run).toEqual(merged);
    }
  });

  test("none runs nothing", () => {
    expect(w2Extensions("integrity-basic", "none")).toEqual({ run: [], added: [] });
  });

  test("a named extension runs (pending or not) with its prerequisites, in the scenario's order", () => {
    expect(w2Extensions("integrity-basic", "tamper")).toEqual({
      run: ["group", "signed", "tamper"],
      added: ["group", "signed"],
    });
    expect(w2Extensions("integrity-basic", "group-appeal")).toEqual({
      run: ["group", "signed", "group-appeal"],
      added: ["group", "signed"],
    });
    expect(w2Extensions("integrity-basic", " group , group ")).toEqual({ run: ["group"], added: [] });
    expect(w2Extensions("e4b-money", "split-new-payee,split-release")).toEqual({
      run: ["split-release", "split-new-payee"],
      added: [],
    });
    expect(w2Extensions("timeline-sync", "replay-panel").run).toEqual(["replay-panel"]);
  });

  test("a name of another scenario, a typo or an empty list throws", () => {
    expect(() => w2Extensions("e4b-money", "group")).toThrow(/not an extension of e4b-money/);
    expect(() => w2Extensions("trust-safety", "enforcment")).toThrow(/not an extension/);
    expect(() => w2Extensions("trust-safety", ",")).toThrow(/no extension selected/);
  });

  test("the scenario steps an extension needs are added to the selection", () => {
    expect(w2StepsNeeded(["enforcement"])).toEqual([4, 5]);
    expect(w2StepsNeeded([])).toEqual([]);
    expect(withW2Steps([1, 4], ["enforcement"])).toEqual({ steps: [1, 4, 5], added: [5] });
    expect(withW2Steps([2], ["replay-panel"])).toEqual({ steps: [1, 2, 3], added: [1, 3] });
    expect(withW2Steps([2], [])).toEqual({ steps: [2], added: [] });
  });

  test("title", () => {
    expect(w2ExtensionTitle("group-appeal", "run")).toBe("w2 group-appeal: run");
  });
});

describe("wiring", () => {
  // Each extended scenario must run every one of its extensions: a missing map entry would be a
  // type error, a missing call would silently never run them.
  test.each(SCENARIOS)("%s selects its W2 extensions from --set w2= and runs each", (s) => {
    const text = source(`scenarios/${s}.ts`);
    expect(text).toContain(`w2Extensions("${s}", ctx.param("w2", ""))`);
    expect(text).toContain("W2_STEPS[name]");
    expect(text).toContain("w2ExtensionTitle(name");
    for (const e of W2_EXTENSIONS[s]) expect(text).toContain(`${/^[a-z]+$/.test(e) ? e : `"${e}"`}:`);
  });

  test("scenarios whose extensions need their steps add them", () => {
    for (const s of ["trust-safety", "timeline-sync"])
      expect(source(`scenarios/${s}.ts`)).toContain("withW2Steps(selected, w2.run)");
  });

  test("captions, live-dvr and rehearsal are in full, required, and in their shards", async () => {
    const registry = await loadRegistry();
    for (const name of ["captions", "live-dvr", "rehearsal"]) {
      expect(registry.get(name)?.inFull, name).toBe(true);
      expect(FULL_REQUIRED as readonly string[]).toContain(name);
    }
    expect(shardOf(registry.full, "captions").map((s) => s.name)).toEqual(["captions"]);
    expect(FULL_SHARDS.notify).toEqual(["notifications", "live-dvr", "rehearsal"]);
    // The first registry load imports every scenario module: over 5 s on CI (see cli.test.ts).
  }, 120_000);
});
