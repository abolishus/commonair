// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d5-dashboard: the checklist's rules from the facts (`setupStateFromFacts`), without a database. */
import { describe, expect, test } from "vite-plus/test";
import { STREAM_SETUP_STEPS } from "@commonair/contracts/enums";
import { type SetupFacts, setupStateFromFacts } from "../src/studio/setup.ts";

const none: SetupFacts = {
  profile: false,
  streamInfo: false,
  streamKey: false,
  anyBroadcast: false,
  rehearsal: false,
  live: false,
  signupIntent: null,
  twitchImportDone: false,
  audienceMarked: false,
};
const all: SetupFacts = {
  ...none,
  profile: true,
  streamInfo: true,
  streamKey: true,
  anyBroadcast: true,
  live: true,
  audienceMarked: true,
};
const doneOf = (facts: SetupFacts, available = true) =>
  Object.fromEntries(setupStateFromFacts(facts, available).steps.map((s) => [s.step, s.done]));

describe("setupStateFromFacts", () => {
  test("steps come in STREAM_SETUP_STEPS order; only the rehearsal is optional", () => {
    const state = setupStateFromFacts(none, true);
    expect(state.steps.map((s) => s.step)).toEqual([...STREAM_SETUP_STEPS]);
    expect(state.steps.filter((s) => s.optional).map((s) => s.step)).toEqual(["rehearsal"]);
    expect(state.complete).toBe(false);
    expect(state.signupIntent).toBeNull();
  });

  test.each([
    ["profile", "channel_profile"],
    ["streamInfo", "stream_info"],
    ["streamKey", "stream_key"],
    ["anyBroadcast", "encoder_connected"],
    ["rehearsal", "rehearsal"],
    ["live", "first_live"],
    ["audienceMarked", "bring_your_audience"],
  ] as const)("%s marks %s and nothing else", (fact, step) => {
    const done = doneOf({ ...none, [fact]: true });
    // `get_paid` has its own rules (overhaul wave 4, d6-studio), like `import_twitch`.
    const others = STREAM_SETUP_STEPS.filter((s) => s !== step && s !== "import_twitch" && s !== "get_paid");
    expect(Object.fromEntries(others.map((s) => [s, done[s]]))).toEqual(
      Object.fromEntries(others.map((s) => [s, false])),
    );
    expect(done[step]).toBe(true);
  });

  test("import_twitch applies only to an import sign-up the instance can serve", () => {
    expect(doneOf(none).import_twitch).toBeNull();
    expect(doneOf({ ...none, signupIntent: "stream" }).import_twitch).toBeNull();
    expect(doneOf({ ...none, signupIntent: "import" }).import_twitch).toBe(false);
    expect(doneOf({ ...none, signupIntent: "import" }, false).import_twitch).toBeNull();
    // A finished import stays done after the instance switches the import off.
    expect(doneOf({ ...none, signupIntent: "import", twitchImportDone: true }, false).import_twitch).toBe(true);
    // Without the import intent a finished import is not a step.
    expect(doneOf({ ...none, twitchImportDone: true }).import_twitch).toBeNull();
  });

  test("complete waits for every required step, not the rehearsal or a step that does not apply", () => {
    expect(setupStateFromFacts(all, true).complete).toBe(true);
    expect(setupStateFromFacts({ ...all, audienceMarked: false }, true).complete).toBe(false);
    expect(setupStateFromFacts({ ...all, live: false }, true).complete).toBe(false);
    expect(setupStateFromFacts({ ...all, signupIntent: "import" }, true).complete).toBe(false);
    expect(setupStateFromFacts({ ...all, signupIntent: "import" }, false).complete).toBe(true);
    expect(setupStateFromFacts({ ...all, signupIntent: "import", twitchImportDone: true }, true).complete).toBe(true);
  });
});
