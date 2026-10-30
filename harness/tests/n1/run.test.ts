// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications` step selection (harness/src/n1/run.ts) and the step modules' contract. */
import { describe, expect, test } from "vite-plus/test";
import { step as cooldown } from "../../src/n1/cooldown.ts";
import { decryptPushBody, newHarnessSubscription, verifyVapidAuthorization } from "../../src/n1/ece.ts";
import { step as email } from "../../src/n1/email.ts";
import { step as inapp } from "../../src/n1/inapp.ts";
import { step as inbox } from "../../src/n1/inbox.ts";
import { step as push } from "../../src/n1/push.ts";
import { step as pushWeb } from "../../src/n1/push-web.ts";
import { step as pwa } from "../../src/n1/pwa.ts";
import {
  type N1Step,
  type N1StepNumber,
  N1_STEP_NUMBERS,
  PENDING_N1_STEPS,
  parseN1Steps,
  planN1Steps,
} from "../../src/n1/run.ts";

const MODULES: Record<N1StepNumber, N1Step> = {
  1: inapp,
  2: email,
  3: cooldown,
  4: push,
  5: inbox,
  6: pwa,
  7: pushWeb,
};

const NONE: readonly N1StepNumber[] = [];

describe("parseN1Steps", () => {
  test("all and empty select every step, not explicitly", () => {
    expect(parseN1Steps("all")).toEqual({ steps: [1, 2, 3, 4, 5, 6, 7], explicit: false });
    expect(parseN1Steps("")).toEqual({ steps: [1, 2, 3, 4, 5, 6, 7], explicit: false });
  });
  test("lists and ranges are explicit", () => {
    expect(parseN1Steps("4, 1-2")).toEqual({ steps: [1, 2, 4], explicit: true });
  });
  test("typos throw", () => {
    expect(() => parseN1Steps("8")).toThrow("8 is not a step");
    expect(() => parseN1Steps("x")).toThrow("is not a step number");
    expect(() => parseN1Steps("3-1")).toThrow("bad range");
  });
});

describe("planN1Steps", () => {
  test("nothing pending: all run with via=web", () => {
    expect(planN1Steps(parseN1Steps("all"), MODULES, "web", NONE)).toEqual({
      run: [1, 2, 3, 4, 5, 6, 7],
      skipped: [],
    });
  });

  test("via=api skips the web-only steps (5, 6, 7)", () => {
    const plan = planN1Steps(parseN1Steps("all"), MODULES, "api", NONE);
    expect(plan.run).toEqual([1, 2, 3, 4]);
    expect(plan.skipped).toEqual([
      { step: 5, reason: "web only (via=api)" },
      { step: 6, reason: "web only (via=api)" },
      { step: 7, reason: "web only (via=api)" },
    ]);
  });

  test("a pending step is skipped under all, and so are the steps that need it", () => {
    const plan = planN1Steps(parseN1Steps("all"), MODULES, "web", [1]);
    expect(plan.run).toEqual([4, 6, 7]);
    expect(plan.skipped).toEqual([
      { step: 1, reason: "pending: N1-fanout not merged" },
      { step: 2, reason: "needs step 1" },
      { step: 3, reason: "needs step 1" },
      { step: 5, reason: "needs step 1" },
    ]);
  });

  test("a named step runs even while pending", () => {
    expect(planN1Steps(parseN1Steps("4"), MODULES, "web", [4])).toEqual({ run: [4], skipped: [] });
  });

  test("a step whose needs are not selected is skipped with all of them named", () => {
    expect(planN1Steps(parseN1Steps("7"), MODULES, "web", NONE)).toEqual({
      run: [],
      skipped: [{ step: 7, reason: "needs steps 4, 6" }],
    });
  });

  test("today every step is pending, so all runs nothing", () => {
    expect([...PENDING_N1_STEPS]).toEqual([...N1_STEP_NUMBERS]);
    const plan = planN1Steps(parseN1Steps("all"), MODULES, "web");
    expect(plan.run).toEqual([]);
    expect(plan.skipped).toHaveLength(7);
  });
});

describe("step modules", () => {
  test("owners, needs, web-only and webPush requirements follow the spec", () => {
    const shape = Object.fromEntries(
      N1_STEP_NUMBERS.map((n) => {
        const m = MODULES[n];
        return [n, { owner: m.owner, needs: m.needs, webOnly: m.webOnly ?? false, requires: m.requires ?? [] }];
      }),
    );
    expect(shape).toEqual({
      1: { owner: "N1-fanout", needs: [], webOnly: false, requires: [] },
      2: { owner: "N1-email", needs: [1], webOnly: false, requires: [] },
      3: { owner: "N1-fanout", needs: [1], webOnly: false, requires: [] },
      4: { owner: "N1-push", needs: [], webOnly: false, requires: ["webPush"] },
      5: { owner: "N1-inbox", needs: [1], webOnly: true, requires: [] },
      6: { owner: "N1-pwa", needs: [], webOnly: true, requires: [] },
      7: { owner: "N1-pwa", needs: [4, 6], webOnly: true, requires: ["webPush"] },
    });
  });

  test("a not-merged step rejects with its owner", async () => {
    for (const n of PENDING_N1_STEPS) {
      const m = MODULES[n];
      await expect(m.run({} as never)).rejects.toThrow(`${m.owner} not merged`);
    }
  });

  test("the ece stub keeps its final signatures until N1-push fills it", async () => {
    await expect(newHarnessSubscription("http://h/push/a")).rejects.toThrow("N1-push not merged");
    await expect(decryptPushBody(new Uint8Array(), {} as never)).rejects.toThrow("N1-push not merged");
    await expect(verifyVapidAuthorization("vapid", "http://h/push/a", "k", 0)).rejects.toThrow("N1-push not merged");
  });
});
