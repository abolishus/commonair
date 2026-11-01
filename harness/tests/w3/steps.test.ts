// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The batch 7 scenarios' step selection and extension wiring (src/w3/steps.ts). */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { INTERACT_STEP_NUMBERS } from "../../src/e8/steps.ts";
import { TWITCH_IMPORT_STEP_RUNNERS } from "../../src/n3/index.ts";
import { FEDERATION_STEP_RUNNERS } from "../../src/n4/index.ts";
import { FULL_REQUIRED, loadRegistry, shardOf } from "../../src/registry.ts";
import { SAFETY_STEP_NUMBERS } from "../../src/safety.ts";
import { FULL_SHARDS, PATH_FILTERED_SHARDS } from "../../src/shards.ts";
import { REHEARSAL_STEP_NUMBERS, W2_EXTENSIONS, type W2Extension } from "../../src/w2/steps.ts";
import { PORTABILITY_STEP_RUNNERS } from "../../src/w3/portability/index.ts";
import {
  FEDERATION_STEP_NUMBERS,
  FEDERATION_STEP_PREREQUISITES,
  FEDERATION_STEPS,
  PENDING_FEDERATION_STEPS,
  PENDING_PORTABILITY_STEPS,
  PENDING_TWITCH_IMPORT_STEPS,
  PENDING_W3_EXTENSIONS,
  PENDING_WATCH_ROOM_STEPS,
  PORTABILITY_STEP_NUMBERS,
  PORTABILITY_STEP_PREREQUISITES,
  PORTABILITY_STEPS,
  TWITCH_IMPORT_STEP_NUMBERS,
  TWITCH_IMPORT_STEP_PREREQUISITES,
  TWITCH_IMPORT_STEPS,
  W3_EXTENSION_PREREQUISITES,
  W3_EXTENSION_UNITS,
  W3_EXTENSIONS,
  W3_SCENARIO_STEP_PREREQUISITES,
  W3_W2_PREREQUISITES,
  WATCH_ROOM_STEP_NUMBERS,
  WATCH_ROOM_STEP_PREREQUISITES,
  WATCH_ROOM_STEPS,
  type W3ExtendedScenario,
  type W3Extension,
  allFederationSteps,
  allPortabilitySteps,
  allTwitchImportSteps,
  allWatchRoomSteps,
  federationTitle,
  parseFederationSteps,
  parsePortabilitySteps,
  parseTwitchImportSteps,
  parseWatchRoomSteps,
  portabilityTitle,
  twitchImportTitle,
  w3ExtensionTitle,
  w3Extensions,
  w3StepsNeeded,
  w3W2Missing,
  watchRoomTitle,
  withPrerequisites,
  withW3Steps,
} from "../../src/w3/steps.ts";
import { WATCH_ROOM_STEP_RUNNERS } from "../../src/w3/watch-rooms/index.ts";

const SCENARIOS = Object.keys(W3_EXTENSIONS) as W3ExtendedScenario[];
const ALL_EXTENSIONS = Object.values(W3_EXTENSIONS).flat() as W3Extension[];
const scenarioOf = (e: W3Extension): W3ExtendedScenario =>
  SCENARIOS.find((s) => (W3_EXTENSIONS[s] as readonly string[]).includes(e)) as W3ExtendedScenario;
const source = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const NEW_SCENARIOS = ["watch-room", "portability", "twitch-import", "federation"] as const;

/** The four new scenarios' tables, for the checks every one of them shares. */
const TABLES = [
  {
    name: "watch-room",
    steps: WATCH_ROOM_STEPS,
    numbers: WATCH_ROOM_STEP_NUMBERS,
    pending: PENDING_WATCH_ROOM_STEPS,
    prerequisites: WATCH_ROOM_STEP_PREREQUISITES as Readonly<Record<number, readonly number[]>>,
    runners: WATCH_ROOM_STEP_RUNNERS,
    all: allWatchRoomSteps,
    parse: parseWatchRoomSteps,
  },
  {
    name: "portability",
    steps: PORTABILITY_STEPS,
    numbers: PORTABILITY_STEP_NUMBERS,
    pending: PENDING_PORTABILITY_STEPS,
    prerequisites: PORTABILITY_STEP_PREREQUISITES as Readonly<Record<number, readonly number[]>>,
    runners: PORTABILITY_STEP_RUNNERS,
    all: allPortabilitySteps,
    parse: parsePortabilitySteps,
  },
  {
    name: "twitch-import",
    steps: TWITCH_IMPORT_STEPS,
    numbers: TWITCH_IMPORT_STEP_NUMBERS,
    pending: PENDING_TWITCH_IMPORT_STEPS,
    prerequisites: TWITCH_IMPORT_STEP_PREREQUISITES as Readonly<Record<number, readonly number[]>>,
    runners: TWITCH_IMPORT_STEP_RUNNERS,
    all: allTwitchImportSteps,
    parse: parseTwitchImportSteps,
  },
  {
    name: "federation",
    steps: FEDERATION_STEPS,
    numbers: FEDERATION_STEP_NUMBERS,
    pending: PENDING_FEDERATION_STEPS,
    prerequisites: FEDERATION_STEP_PREREQUISITES as Readonly<Record<number, readonly number[]>>,
    runners: FEDERATION_STEP_RUNNERS,
    all: allFederationSteps,
    parse: parseFederationSteps,
  },
] as const;

describe("new scenarios' step tables", () => {
  test("the step counts the briefs list, numbered from 1", () => {
    expect(WATCH_ROOM_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(PORTABILITY_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5]);
    expect(TWITCH_IMPORT_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(FEDERATION_STEP_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const t of TABLES) expect(Object.keys(t.steps).map(Number), t.name).toEqual([...t.numbers]);
  });

  test.each(TABLES)("$name: pending names real steps, all runs the rest, and every step has a runner", (t) => {
    for (const s of t.pending) expect(t.numbers).toContain(s);
    const notPending = t.numbers.filter((n) => !(t.pending as readonly number[]).includes(n));
    expect(t.all()).toEqual(notPending);
    expect(t.parse("")).toEqual(notPending);
    expect(t.parse("all")).toEqual(notPending);
    expect(Object.keys(t.runners).map(Number)).toEqual([...t.numbers]);
  });

  test.each(TABLES)("$name: prerequisites are earlier steps of the same scenario", (t) => {
    expect(Object.keys(t.prerequisites).map(Number)).toEqual([...t.numbers]);
    for (const n of t.numbers)
      for (const p of t.prerequisites[n] ?? []) {
        expect(t.numbers, `${n} → ${p}`).toContain(p);
        expect(p, `${n} → ${p}`).toBeLessThan(n);
      }
  });

  test("a pending step runs when named, with its prerequisites", () => {
    expect(parseWatchRoomSteps("2")).toEqual([2]);
    expect(withPrerequisites([2], WATCH_ROOM_STEP_PREREQUISITES)).toEqual({ steps: [1, 2], added: [1] });
    expect(withPrerequisites([4], PORTABILITY_STEP_PREREQUISITES)).toEqual({ steps: [3, 4], added: [3] });
    expect(withPrerequisites([3, 7], TWITCH_IMPORT_STEP_PREREQUISITES).steps).toEqual([2, 3, 7]);
    expect(parseFederationSteps("5-6")).toEqual([5, 6]);
  });

  test("a typo throws instead of running fewer checks", () => {
    expect(() => parseWatchRoomSteps("9")).toThrow(/not a step/);
    expect(() => parsePortabilitySteps("0-3")).toThrow(/bad range/);
    expect(() => parseTwitchImportSteps("ten")).toThrow(/not a step number/);
    expect(() => parseFederationSteps(",")).toThrow(/no step selected/);
  });

  test("titles", () => {
    expect(watchRoomTitle(3, "run")).toBe("3. mixed age bands refused: run");
    expect(portabilityTitle(1, "run")).toBe("1. move link converts: run");
    expect(twitchImportTitle(8, "run")).toBe("8. token revoked: run");
    expect(federationTitle(4, "run")).toBe("4. go-live note delivered: run");
  });
});

describe("extensions", () => {
  test("the six extended scenarios and their steps, in order (batch 7 decision (d))", () => {
    expect(W3_EXTENSIONS).toEqual({
      interact: ["giveaway", "surge-raid", "fair-prediction"],
      "e5-coop": ["jury"],
      "e2e-relay": ["dvr-relay", "dvr-purge", "relay-vtt"],
      "trust-safety": ["sor-resolve"],
      "integrity-basic": ["group-appeal-threshold"],
      rehearsal: ["moderation-samples"],
    });
    expect(new Set(ALL_EXTENSIONS).size).toBe(ALL_EXTENSIONS.length);
  });

  test("every extension names its unit and a module that exists and exports", () => {
    expect(Object.keys(W3_EXTENSION_UNITS).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS) expect(source(`src/w3/${W3_EXTENSION_UNITS[e].file}`), e).toContain("export");
    expect(new Set(ALL_EXTENSIONS.map((e) => W3_EXTENSION_UNITS[e].unit))).toEqual(
      new Set(["W3-giveaways", "W3-surge-raids", "W3-fair-predictions", "W3-jury", "W3-dvr-relay", "B7-followups"]),
    );
  });

  test("pending names real extensions", () => {
    for (const e of PENDING_W3_EXTENSIONS) expect(ALL_EXTENSIONS).toContain(e);
  });

  test("prerequisites stay in the extension's own scenario, and a merged one never needs a pending one", () => {
    expect(Object.keys(W3_EXTENSION_PREREQUISITES).sort()).toEqual([...ALL_EXTENSIONS].sort());
    const pairs = ALL_EXTENSIONS.flatMap((e) => W3_EXTENSION_PREREQUISITES[e].map((p) => [e, p] as const));
    for (const [e, p] of pairs) expect(scenarioOf(p), `${e} → ${p}`).toBe(scenarioOf(e));
    const mergedOnPending = pairs.filter(
      ([e, p]) => !PENDING_W3_EXTENSIONS.includes(e) && PENDING_W3_EXTENSIONS.includes(p),
    );
    expect(mergedOnPending).toEqual([]);
  });

  test("scenario steps an extension needs are real steps of its scenario", () => {
    const steps: Record<W3ExtendedScenario, readonly number[]> = {
      interact: INTERACT_STEP_NUMBERS,
      // e5-coop, e2e-relay and integrity-basic: no step an extension may add.
      "e5-coop": [],
      "e2e-relay": [],
      "trust-safety": SAFETY_STEP_NUMBERS,
      "integrity-basic": [],
      rehearsal: REHEARSAL_STEP_NUMBERS,
    };
    expect(Object.keys(W3_SCENARIO_STEP_PREREQUISITES).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS)
      for (const n of W3_SCENARIO_STEP_PREREQUISITES[e]) expect(steps[scenarioOf(e)], `${e} → ${n}`).toContain(n);
    expect(W3_SCENARIO_STEP_PREREQUISITES["moderation-samples"]).toEqual([1]);
  });

  test("W2 extensions a W3 one needs belong to the same scenario", () => {
    expect(Object.keys(W3_W2_PREREQUISITES).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS) {
      const own = (W2_EXTENSIONS as Readonly<Record<string, readonly W2Extension[]>>)[scenarioOf(e)] ?? [];
      for (const p of W3_W2_PREREQUISITES[e]) expect(own, `${e} → ${p}`).toContain(p);
    }
    expect(W3_W2_PREREQUISITES["group-appeal-threshold"]).toEqual(["group", "signed"]);
  });
});

describe("w3Extensions", () => {
  test("empty and all run every extension not pending", () => {
    for (const s of SCENARIOS) {
      const own = W3_EXTENSIONS[s] as readonly W3Extension[];
      const merged = own.filter((e) => !PENDING_W3_EXTENSIONS.includes(e));
      expect(w3Extensions(s, "").run).toEqual(merged);
      expect(w3Extensions(s, "ALL").run).toEqual(merged);
    }
  });

  test("none runs nothing", () => {
    expect(w3Extensions("interact", "none")).toEqual({ run: [], added: [] });
  });

  test("a named extension runs (pending or not) with its prerequisites, in the scenario's order", () => {
    expect(w3Extensions("e2e-relay", "dvr-purge")).toEqual({ run: ["dvr-relay", "dvr-purge"], added: ["dvr-relay"] });
    expect(w3Extensions("e2e-relay", "relay-vtt,dvr-relay")).toEqual({ run: ["dvr-relay", "relay-vtt"], added: [] });
    expect(w3Extensions("interact", " fair-prediction , giveaway ")).toEqual({
      run: ["giveaway", "fair-prediction"],
      added: [],
    });
    expect(w3Extensions("e5-coop", "jury").run).toEqual(["jury"]);
  });

  test("a name of another scenario, a typo or an empty list throws", () => {
    expect(() => w3Extensions("interact", "jury")).toThrow(/not an extension of interact/);
    expect(() => w3Extensions("rehearsal", "moderation-sample")).toThrow(/not an extension/);
    expect(() => w3Extensions("trust-safety", ",")).toThrow(/no extension selected/);
  });

  test("the scenario steps an extension needs are added to the selection", () => {
    expect(w3StepsNeeded(["moderation-samples"])).toEqual([1]);
    expect(w3StepsNeeded(["giveaway", "sor-resolve"])).toEqual([]);
    expect(withW3Steps([3, 5], ["moderation-samples"])).toEqual({ steps: [1, 3, 5], added: [1] });
    expect(withW3Steps([1], ["moderation-samples"])).toEqual({ steps: [1], added: [] });
    expect(withW3Steps([2], [])).toEqual({ steps: [2], added: [] });
  });

  test("the W2 extensions a W3 one needs, less those already selected", () => {
    expect(w3W2Missing(["group-appeal-threshold"], [])).toEqual(["group", "signed"]);
    expect(w3W2Missing(["group-appeal-threshold"], ["group"])).toEqual(["signed"]);
    expect(w3W2Missing(["group-appeal-threshold"], ["group", "signed", "tamper"])).toEqual([]);
    expect(w3W2Missing([], [])).toEqual([]);
  });

  test("title", () => {
    expect(w3ExtensionTitle("giveaway", "run")).toBe("w3 giveaway: run");
  });
});

describe("wiring", () => {
  // Each extended scenario must run every one of its extensions: a missing map entry would be a
  // type error, a missing call would silently never run them.
  test.each(SCENARIOS)("%s selects its W3 extensions from --set w3= and runs each", (s) => {
    const text = source(`scenarios/${s}.ts`);
    expect(text).toContain(`w3Extensions("${s}", ctx.param("w3", ""))`);
    expect(text).toContain("W3_STEPS[name]");
    expect(text).toContain("w3ExtensionTitle(name");
    expect(text).toContain(`ctx.data("w3.extensions"`);
    for (const e of W3_EXTENSIONS[s]) expect(text).toContain(`${/^[a-z]+$/.test(e) ? e : `"${e}"`}:`);
  });

  test("scenarios whose extensions may need their steps add them", () => {
    expect(source("scenarios/trust-safety.ts")).toContain("withW3Steps(forW2.steps, w3.run)");
    expect(source("scenarios/rehearsal.ts")).toContain("withW3Steps(selected, w3.run)");
    expect(source("scenarios/integrity-basic.ts")).toContain("w3W2Missing(w3.run, w2Asked.run)");
  });

  test("each step module exports the entry point its scenario imports", () => {
    const entry: Record<W3Extension, string> = {
      giveaway: "stepGiveaway",
      "surge-raid": "stepSurgeRaid",
      "fair-prediction": "stepFairPrediction",
      jury: "stepJury",
      "dvr-relay": "stepDvrRelay",
      "dvr-purge": "stepDvrPurge",
      "relay-vtt": "stepRelayVtt",
      "sor-resolve": "sorResolveExtension",
      "group-appeal-threshold": "stepGroupAppealThreshold",
      "moderation-samples": "stepModerationSamples",
    };
    for (const e of ALL_EXTENSIONS) {
      expect(source(`src/w3/${W3_EXTENSION_UNITS[e].file}`), e).toMatch(
        new RegExp(`export (async function|const) ${entry[e]}\\b`),
      );
      expect(source(`scenarios/${scenarioOf(e)}.ts`), e).toContain(entry[e]);
    }
  });

  test("the four new scenarios are in full, required and the w3 shard, which is not path-filtered", async () => {
    const registry = await loadRegistry();
    for (const name of NEW_SCENARIOS) {
      expect(registry.get(name)?.inFull, name).toBe(true);
      expect(FULL_REQUIRED as readonly string[]).toContain(name);
    }
    expect(FULL_SHARDS.w3).toEqual([...NEW_SCENARIOS]);
    expect(shardOf(registry.full, "w3").map((s) => s.name)).toEqual(
      registry.full.map((s) => s.name).filter((n) => (NEW_SCENARIOS as readonly string[]).includes(n)),
    );
    expect(Object.keys(PATH_FILTERED_SHARDS)).not.toContain("w3");
    // The notify shard stays as batch 6 left it (7m48s on 8a562d9a, under the ~12 min cap).
    expect(FULL_SHARDS.notify).toEqual(["notifications", "live-dvr", "rehearsal"]);
    // twitch-import needs the fake Twitch OAuth credentials, so no-proprietary skips it.
    expect(registry.get("twitch-import")?.needs).toContain("oauth");
    // The first registry load imports every scenario module: over 5 s on CI (see cli.test.ts).
  }, 120_000);

  test("a new scenario with every step pending skips instead of failing in full", () => {
    for (const name of NEW_SCENARIOS) {
      const text = source(`scenarios/${name}.ts`);
      expect(text, name).toContain("if (steps.length === 0) {");
      expect(text, name).toContain(`ctx.skipStep("${name}"`);
    }
  });
});
