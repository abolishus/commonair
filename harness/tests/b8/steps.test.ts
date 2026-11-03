// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The batch 8 extension steps and their wiring (src/b8/steps.ts). */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  B8_EXTENSION_PREREQUISITES,
  B8_EXTENSION_UNITS,
  B8_EXTENSIONS,
  B8_SCENARIO_STEP_PREREQUISITES,
  PENDING_B8_EXTENSIONS,
  UNWIRED_B8_SCENARIOS,
  type B8ExtendedScenario,
  type B8Extension,
  b8ExtensionTitle,
  b8Extensions,
  b8StepsNeeded,
  withB8Steps,
} from "../../src/b8/steps.ts";
import { INTERACT_STEP_NUMBERS } from "../../src/e8/steps.ts";
import { SAFETY_STEP_NUMBERS } from "../../src/safety.ts";
import {
  FEDERATION_STEP_NUMBERS,
  PORTABILITY_STEP_NUMBERS,
  TWITCH_IMPORT_STEP_NUMBERS,
  WATCH_ROOM_STEP_NUMBERS,
} from "../../src/w3/steps.ts";

const SCENARIOS = Object.keys(B8_EXTENSIONS) as B8ExtendedScenario[];
const WIRED = SCENARIOS.filter((s) => !UNWIRED_B8_SCENARIOS.includes(s));
const ALL_EXTENSIONS = Object.values(B8_EXTENSIONS).flat() as B8Extension[];
const scenarioOf = (e: B8Extension): B8ExtendedScenario =>
  SCENARIOS.find((s) => (B8_EXTENSIONS[s] as readonly string[]).includes(e)) as B8ExtendedScenario;
const source = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

/** Scenarios that select their own steps, so an extension may add some (`withB8Steps`). */
const WITH_STEPS: Partial<Record<B8ExtendedScenario, readonly number[]>> = {
  interact: INTERACT_STEP_NUMBERS,
  "watch-room": WATCH_ROOM_STEP_NUMBERS,
  "twitch-import": TWITCH_IMPORT_STEP_NUMBERS,
  federation: FEDERATION_STEP_NUMBERS,
  portability: PORTABILITY_STEP_NUMBERS,
  "trust-safety": SAFETY_STEP_NUMBERS,
};

describe("extensions", () => {
  test("the extended scenarios and their steps, in order (contract step §4.3)", () => {
    expect(B8_EXTENSIONS).toEqual({
      "e4b-money": [
        "gift-window",
        "auto-refund",
        "refund-unknown",
        "connect-transfer",
        "transfer-reversed",
        "receipt-email",
      ],
      "e5-coop": ["share-stripe", "patronage-payout"],
      interact: ["grace-bet-web", "giveaway-verify-mine", "raid-restart-keeps-raid"],
      "watch-room": ["edge-sync"],
      "twitch-import": ["field-choices", "channel-panels-banner", "import-expiry"],
      federation: ["actor-disabled-event"],
      portability: ["incoming-cleanup"],
      "data-export": ["giveaway-section"],
      "trust-safety": ["sor-staff-action", "lapsed-ban-signin"],
      "relay-dvr": ["relay-dvr-switch"],
    });
    expect(new Set(ALL_EXTENSIONS).size).toBe(ALL_EXTENSIONS.length);
  });

  test("every extension names its unit and a module under src/b8/ that exists and exports", () => {
    expect(Object.keys(B8_EXTENSION_UNITS).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS) expect(source(`src/b8/${B8_EXTENSION_UNITS[e].file}`), e).toContain("export");
    expect(new Set(ALL_EXTENSIONS.map((e) => B8_EXTENSION_UNITS[e].unit))).toEqual(
      new Set(["M1-gifts-refunds", "M1-connect", "M1-coop-money", "B8-server", "B8-web", "B8-player"]),
    );
  });

  test("each unit writes one module, and each module is one unit's (path ownership)", () => {
    const files = new Map<string, string>();
    for (const e of ALL_EXTENSIONS) {
      const { unit, file } = B8_EXTENSION_UNITS[e];
      expect(files.get(unit) ?? file, `${e}: ${unit}`).toBe(file);
      files.set(unit, file);
    }
    expect(Object.fromEntries(files)).toEqual({
      "M1-gifts-refunds": "money-refunds.ts",
      "M1-connect": "money-connect.ts",
      "M1-coop-money": "coop-money.ts",
      "B8-server": "server.ts",
      "B8-web": "web.ts",
      "B8-player": "player.ts",
    });
  });

  test("the briefs' assignments", () => {
    const unitOf = (e: B8Extension) => B8_EXTENSION_UNITS[e].unit;
    for (const e of ["gift-window", "auto-refund", "refund-unknown", "receipt-email"] as const)
      expect(unitOf(e)).toBe("M1-gifts-refunds");
    for (const e of ["connect-transfer", "transfer-reversed"] as const) expect(unitOf(e)).toBe("M1-connect");
    for (const e of ["share-stripe", "patronage-payout"] as const) expect(unitOf(e)).toBe("M1-coop-money");
    for (const e of ["grace-bet-web", "giveaway-verify-mine", "channel-panels-banner"] as const)
      expect(unitOf(e)).toBe("B8-web");
    for (const e of ["edge-sync", "relay-dvr-switch"] as const) expect(unitOf(e)).toBe("B8-player");
    for (const e of [
      "raid-restart-keeps-raid",
      "field-choices",
      "import-expiry",
      "actor-disabled-event",
      "incoming-cleanup",
      "giveaway-section",
      "sor-staff-action",
      "lapsed-ban-signin",
    ] as const)
      expect(unitOf(e)).toBe("B8-server");
  });

  test("pending names real extensions once each, and every one is pending at the contract step", () => {
    for (const e of PENDING_B8_EXTENSIONS) expect(ALL_EXTENSIONS).toContain(e);
    expect(new Set(PENDING_B8_EXTENSIONS).size).toBe(PENDING_B8_EXTENSIONS.length);
    // The orchestrator lifts a unit's extensions at its merge; until then nothing runs by default.
    const merged = ALL_EXTENSIONS.filter((e) => !PENDING_B8_EXTENSIONS.includes(e));
    for (const e of merged) expect(UNWIRED_B8_SCENARIOS, e).not.toContain(scenarioOf(e));
  });

  test("an unwired scenario's extensions stay pending (relay-dvr waits for B8-harness)", () => {
    expect(UNWIRED_B8_SCENARIOS).toEqual(["relay-dvr"]);
    for (const s of UNWIRED_B8_SCENARIOS)
      for (const e of B8_EXTENSIONS[s] as readonly B8Extension[]) expect(PENDING_B8_EXTENSIONS, e).toContain(e);
  });

  test("prerequisites stay in the extension's own scenario, and a merged one never needs a pending one", () => {
    expect(Object.keys(B8_EXTENSION_PREREQUISITES).sort()).toEqual([...ALL_EXTENSIONS].sort());
    const pairs = ALL_EXTENSIONS.flatMap((e) => B8_EXTENSION_PREREQUISITES[e].map((p) => [e, p] as const));
    for (const [e, p] of pairs) expect(scenarioOf(p), `${e} → ${p}`).toBe(scenarioOf(e));
    const mergedOnPending = pairs.filter(
      ([e, p]) => !PENDING_B8_EXTENSIONS.includes(e) && PENDING_B8_EXTENSIONS.includes(p),
    );
    expect(mergedOnPending).toEqual([]);
    expect(B8_EXTENSION_PREREQUISITES["transfer-reversed"]).toEqual(["connect-transfer"]);
  });

  test("scenario steps an extension needs are real steps of a scenario that selects steps", () => {
    expect(Object.keys(B8_SCENARIO_STEP_PREREQUISITES).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS) {
      const steps = WITH_STEPS[scenarioOf(e)] ?? [];
      for (const n of B8_SCENARIO_STEP_PREREQUISITES[e]) expect(steps, `${e} → ${n}`).toContain(n);
    }
    expect(B8_SCENARIO_STEP_PREREQUISITES["import-expiry"]).toEqual([3]);
    expect(B8_SCENARIO_STEP_PREREQUISITES["channel-panels-banner"]).toEqual([3, 7]);
    expect(B8_SCENARIO_STEP_PREREQUISITES["actor-disabled-event"]).toEqual([3]);
  });
});

describe("b8Extensions", () => {
  test("empty and all run every extension not pending (none, at the contract step)", () => {
    for (const s of SCENARIOS) {
      const own = B8_EXTENSIONS[s] as readonly B8Extension[];
      const merged = own.filter((e) => !PENDING_B8_EXTENSIONS.includes(e));
      expect(b8Extensions(s, "").run).toEqual(merged);
      expect(b8Extensions(s, "ALL").run).toEqual(merged);
      expect(b8Extensions(s, "").run).toEqual([]);
    }
  });

  test("none runs nothing", () => {
    expect(b8Extensions("e4b-money", "none")).toEqual({ run: [], added: [] });
  });

  test("a named extension runs (pending or not) with its prerequisites, in the scenario's order", () => {
    expect(b8Extensions("e4b-money", "transfer-reversed")).toEqual({
      run: ["connect-transfer", "transfer-reversed"],
      added: ["connect-transfer"],
    });
    expect(b8Extensions("e4b-money", " receipt-email , gift-window ")).toEqual({
      run: ["gift-window", "receipt-email"],
      added: [],
    });
    expect(b8Extensions("interact", "giveaway-verify-mine,grace-bet-web").run).toEqual([
      "grace-bet-web",
      "giveaway-verify-mine",
    ]);
    expect(b8Extensions("relay-dvr", "relay-dvr-switch").run).toEqual(["relay-dvr-switch"]);
  });

  test("a name of another scenario, a typo or an empty list throws", () => {
    expect(() => b8Extensions("interact", "edge-sync")).toThrow(/not an extension of interact/);
    expect(() => b8Extensions("e5-coop", "share-strip")).toThrow(/not an extension/);
    expect(() => b8Extensions("trust-safety", ",")).toThrow(/no extension selected/);
  });

  test("the scenario steps an extension needs are added to the selection", () => {
    expect(b8StepsNeeded(["import-expiry", "channel-panels-banner"])).toEqual([3, 7]);
    expect(b8StepsNeeded(["gift-window", "sor-staff-action"])).toEqual([]);
    expect(withB8Steps([1, 2], ["import-expiry"])).toEqual({ steps: [1, 2, 3], added: [3] });
    expect(withB8Steps([3], ["import-expiry"])).toEqual({ steps: [3], added: [] });
    expect(withB8Steps([2], [])).toEqual({ steps: [2], added: [] });
  });

  test("title", () => {
    expect(b8ExtensionTitle("gift-window", "run")).toBe("b8 gift-window: run");
  });
});

describe("wiring", () => {
  const entry: Record<B8Extension, string> = {
    "gift-window": "stepGiftWindow",
    "auto-refund": "stepAutoRefund",
    "refund-unknown": "stepRefundUnknown",
    "receipt-email": "stepReceiptEmail",
    "connect-transfer": "stepConnectTransfer",
    "transfer-reversed": "stepTransferReversed",
    "share-stripe": "stepShareStripe",
    "patronage-payout": "stepPatronagePayout",
    "grace-bet-web": "stepGraceBetWeb",
    "giveaway-verify-mine": "stepGiveawayVerifyMine",
    "channel-panels-banner": "stepChannelPanelsBanner",
    "raid-restart-keeps-raid": "stepRaidRestartKeepsRaid",
    "field-choices": "stepFieldChoices",
    "import-expiry": "stepImportExpiry",
    "actor-disabled-event": "stepActorDisabledEvent",
    "incoming-cleanup": "stepIncomingCleanup",
    "giveaway-section": "stepGiveawaySection",
    "sor-staff-action": "sorStaffActionExtension",
    "lapsed-ban-signin": "lapsedBanSigninExtension",
    "edge-sync": "stepEdgeSync",
    "relay-dvr-switch": "stepRelayDvrSwitch",
  };

  // Each wired scenario must run every one of its extensions: a missing map entry would be a type
  // error, a missing call would silently never run them.
  test.each(WIRED)("%s selects its B8 extensions from --set b8= and runs each", (s) => {
    const text = source(`scenarios/${s}.ts`);
    expect(text).toContain(`b8Extensions("${s}", ctx.param("b8", ""))`);
    expect(text).toContain("B8_STEPS[name]");
    expect(text).toContain("b8ExtensionTitle(name");
    expect(text).toContain(`ctx.data("b8.extensions"`);
    for (const e of B8_EXTENSIONS[s]) expect(text).toContain(`${/^[a-z]+$/.test(e) ? e : `"${e}"`}:`);
  });

  test.each(WIRED.filter((s) => WITH_STEPS[s] !== undefined))("%s adds the steps its extensions need", (s) => {
    expect(source(`scenarios/${s}.ts`)).toMatch(/withB8Steps\((selected|forW3\.steps), b8\.run\)/);
  });

  test("a scenario that skips with no step selected still runs a named extension", () => {
    for (const s of ["interact", "watch-room", "twitch-import", "federation", "portability"])
      expect(source(`scenarios/${s}.ts`), s).toMatch(/steps\.length === 0 [^)]*&& b8\.run\.length === 0\)/);
  });

  test("each step module exports the entry point its scenario imports", () => {
    expect(Object.keys(entry).sort()).toEqual([...ALL_EXTENSIONS].sort());
    for (const e of ALL_EXTENSIONS)
      expect(source(`src/b8/${B8_EXTENSION_UNITS[e].file}`), e).toMatch(
        new RegExp(`export (async function|const) ${entry[e]}\\b`),
      );
    for (const e of ALL_EXTENSIONS.filter((x) => WIRED.includes(scenarioOf(x))))
      expect(source(`scenarios/${scenarioOf(e)}.ts`), e).toContain(entry[e]);
  });

  test("every stub still fails loudly when named before its unit merges", () => {
    // A module whose extensions are all pending is still the contract step's stub; the
    // orchestrator lifts them from pending once the unit fills it.
    const units = new Map(ALL_EXTENSIONS.map((e) => [B8_EXTENSION_UNITS[e].file, B8_EXTENSION_UNITS[e].unit]));
    const stubs = [...units.keys()].filter((file) =>
      ALL_EXTENSIONS.filter((e) => B8_EXTENSION_UNITS[e].file === file).every((e) => PENDING_B8_EXTENSIONS.includes(e)),
    );
    const silent = stubs.filter((file) => !source(`src/b8/${file}`).includes(`${units.get(file)} not merged`));
    expect(silent).toEqual([]);
  });

  test("the relay-dvr scenario is B8-harness's: unwired until it exists", () => {
    const exists = existsSync(new URL("../../scenarios/relay-dvr.ts", import.meta.url));
    expect(exists || UNWIRED_B8_SCENARIOS.includes("relay-dvr")).toBe(true);
  });
});
