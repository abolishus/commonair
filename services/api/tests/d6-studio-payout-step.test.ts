// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d6-studio: the "Get paid" checklist step's rule, without a database (overhaul wave 4, J2-h). */
import { describe, expect, test } from "vite-plus/test";
import { getPaidDone, payoutsAvailable } from "../src/studio/payout-step.ts";
import { type SetupFacts, setupStateFromFacts } from "../src/studio/setup.ts";

const live: SetupFacts = {
  profile: true,
  streamInfo: true,
  streamKey: true,
  anyBroadcast: true,
  rehearsal: false,
  live: true,
  signupIntent: null,
  twitchImportDone: false,
  audienceMarked: true,
  payoutReady: false,
  payoutMarked: false,
};
const getPaid = (facts: SetupFacts, payouts = true) =>
  setupStateFromFacts(facts, true, payouts).steps.find((s) => s.step === "get_paid");

describe("getPaidDone", () => {
  test("does not apply before the first live stream or without payouts", () => {
    expect(getPaidDone({ live: false, payoutReady: true, payoutMarked: true }, true)).toBeNull();
    expect(getPaidDone({ live: true, payoutReady: true, payoutMarked: true }, false)).toBeNull();
  });

  test("after the first stream: open until the account is ready or the owner marks it", () => {
    expect(getPaidDone({ live: true, payoutReady: false, payoutMarked: false }, true)).toBe(false);
    expect(getPaidDone({ live: true, payoutReady: true, payoutMarked: false }, true)).toBe(true);
    expect(getPaidDone({ live: true, payoutReady: false, payoutMarked: true }, true)).toBe(true);
  });

  test("both adapters pay out, as instance.info says", () => {
    expect(payoutsAvailable()).toBe(true);
  });
});

describe("the step in setupStateFromFacts", () => {
  test("optional, and never blocks complete", () => {
    expect(getPaid(live)).toEqual({ step: "get_paid", done: false, optional: true });
    expect(setupStateFromFacts(live, true).complete).toBe(true);
  });

  test("the instance default is payouts on; off or before going live hides the step", () => {
    expect(setupStateFromFacts(live, true).steps.find((s) => s.step === "get_paid")?.done).toBe(false);
    expect(getPaid(live, false)?.done).toBeNull();
    expect(getPaid({ ...live, live: false })?.done).toBeNull();
    expect(getPaid({ ...live, payoutReady: true })?.done).toBe(true);
    expect(getPaid({ ...live, payoutMarked: true })?.done).toBe(true);
  });
});
