// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `developer-platform` step selection (harness/src/e9/run.ts) and the step modules' contract. */
import { describe, expect, test } from "vite-plus/test";
import { step as app } from "../../src/e9/app.ts";
import { step as consent } from "../../src/e9/consent.ts";
import { step as devConsole } from "../../src/e9/console.ts";
import { step as oauth } from "../../src/e9/oauth.ts";
import { type E9Step, type E9StepNumber, E9_STEP_NUMBERS, parseE9Steps, planE9Steps } from "../../src/e9/run.ts";
import { step as sdk } from "../../src/e9/sdk.ts";
import { step as suspend } from "../../src/e9/suspend.ts";
import { step as webhook } from "../../src/e9/webhook.ts";
import { step as websocket } from "../../src/e9/websocket.ts";

const MODULES: Record<E9StepNumber, E9Step> = {
  1: app,
  2: oauth,
  3: consent,
  4: webhook,
  5: websocket,
  6: sdk,
  7: devConsole,
  8: suspend,
};

type Shape = Pick<E9Step, "owner" | "ready" | "needs" | "webOnly">;
const shapes = (over: Partial<Record<E9StepNumber, Partial<Shape>>> = {}): Record<E9StepNumber, Shape> => {
  const out = {} as Record<E9StepNumber, Shape>;
  for (const n of E9_STEP_NUMBERS) {
    const m = MODULES[n];
    out[n] = { owner: m.owner, needs: m.needs, ready: true, ...(m.webOnly ? { webOnly: true } : {}), ...over[n] };
  }
  return out;
};

describe("parseE9Steps", () => {
  test("all, empty, lists and ranges", () => {
    expect(parseE9Steps("all")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseE9Steps("")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseE9Steps("4, 1-2")).toEqual([1, 2, 4]);
  });
  test("typos throw", () => {
    expect(() => parseE9Steps("9")).toThrow("9 is not a step");
    expect(() => parseE9Steps("x")).toThrow("is not a step number");
    expect(() => parseE9Steps("3-1")).toThrow("bad range");
  });
});

describe("planE9Steps", () => {
  test("every step ready: all run with via=web", () => {
    expect(planE9Steps(parseE9Steps("all"), shapes(), "web")).toEqual({
      run: [1, 2, 3, 4, 5, 6, 7, 8],
      skipped: [],
    });
  });

  test("via=api skips the web-only steps (3 and 7)", () => {
    const plan = planE9Steps(parseE9Steps("all"), shapes(), "api");
    expect(plan.run).toEqual([1, 2, 4, 5, 6, 8]);
    expect(plan.skipped.map((s) => s.step)).toEqual([3, 7]);
  });

  test("a pending step is skipped, and so is everything that needs it, transitively", () => {
    const plan = planE9Steps(parseE9Steps("all"), shapes({ 2: { ready: false } }), "web");
    expect(plan.run).toEqual([1, 3]);
    expect(plan.skipped).toEqual([
      { step: 2, reason: "pending: E9-oauth not merged" },
      { step: 4, reason: "needs step 2" },
      { step: 5, reason: "needs step 2" },
      { step: 6, reason: "needs steps 4, 5" },
      { step: 7, reason: "needs step 4" },
      { step: 8, reason: "needs steps 4, 5" },
    ]);
  });

  test("a need that is not selected skips the step (needs are never added)", () => {
    expect(planE9Steps([4], shapes(), "api")).toEqual({ run: [], skipped: [{ step: 4, reason: "needs step 2" }] });
    expect(planE9Steps([1, 2, 4], shapes(), "api").run).toEqual([1, 2, 4]);
  });

  test("the modules as committed: a step runs when it and every step it needs are ready", () => {
    const plan = planE9Steps(parseE9Steps("all"), MODULES, "web");
    const runs = (n: E9StepNumber): boolean =>
      MODULES[n].ready && MODULES[n].needs.every((m) => runs(m as E9StepNumber));
    expect(plan.run).toEqual(E9_STEP_NUMBERS.filter(runs));
  });
});

describe("step modules", () => {
  test("owners and needs are the contract step's table", () => {
    expect(Object.fromEntries(E9_STEP_NUMBERS.map((n) => [n, [MODULES[n].owner, MODULES[n].needs]]))).toEqual({
      1: ["E9-apps", []],
      2: ["E9-oauth", [1]],
      3: ["E9-consent", [1]],
      4: ["E9-subs", [2]],
      5: ["E9-ws", [2]],
      6: ["E9-sdk", [4, 5]],
      7: ["E9-console", [4]],
      8: ["E9-apps", [4, 5]],
    });
    expect(E9_STEP_NUMBERS.filter((n) => MODULES[n].webOnly)).toEqual([3, 7]);
  });

  test("a step that is not ready says which unit has not merged", async () => {
    for (const n of E9_STEP_NUMBERS) {
      const m = MODULES[n];
      if (m.ready) continue;
      await expect(m.run({} as never)).rejects.toThrow(`${m.owner} not merged`);
    }
  });
});
