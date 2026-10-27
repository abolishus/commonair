// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLogger } from "@commonair/observability";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { loadHarnessEnv } from "../src/env.ts";
import type { Platform } from "../src/platform.ts";
import {
  DEFAULT_PARAM_NEEDS,
  FULL,
  FULL_REQUIRED,
  Registry,
  SCENARIOS_DIR,
  loadRegistry,
  missingFromFull,
  orderFull,
  validateScenario,
} from "../src/registry.ts";
import {
  formatSkipTable,
  planScenario,
  profilePreflight,
  proprietaryProblems,
  runOne,
  runScenarios,
  skipRows,
} from "../src/runner.ts";
import { type Scenario, defineScenario, excludedNeeds } from "../src/scenario.ts";

const env = loadHarnessEnv({});
const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });
const platform = { probe: async () => null } as unknown as Platform;

const sc = (name: string, extra: Partial<Scenario> = {}): Scenario =>
  defineScenario({ name, description: name, needs: [], run: async () => undefined, ...extra });

const HEALTHY = { ok: true, service: "api", stripe: false, oauth: false, cdn: false, opsTestHooks: true };
const fakeFetch = (body: unknown, ok = true) =>
  (async () => (ok ? Response.json(body) : Promise.reject(new Error("ECONNREFUSED")))) as unknown as typeof fetch;

describe("full composition", () => {
  test("smoke first, e2e-relay last, the rest by name, load-plan out", () => {
    const list = [
      sc("e2e-relay"),
      sc("viewers"),
      sc("load-plan", { inFull: false }),
      sc("backup-restore"),
      sc("smoke"),
      sc("account-deletion"),
    ];
    expect(orderFull(list).map((s) => s.name)).toEqual([
      "smoke",
      "account-deletion",
      "backup-restore",
      "viewers",
      "e2e-relay",
    ]);
  });

  test("full refuses to run while a required scenario is missing or excluded", () => {
    const r = new Registry([sc("smoke"), sc("e2e-relay", { inFull: false })], ["smoke", "e2e-relay", "simulcast"]);
    expect(() => r.resolve([FULL])).toThrow(/missing or excluded \(inFull: false\): e2e-relay, simulcast/);
    // Naming scenarios directly still works.
    expect(r.resolve(["smoke"]).map((s) => s.name)).toEqual(["smoke"]);
    expect(missingFromFull([sc("smoke")], ["smoke"])).toEqual([]);
  });

  test("the required list is every Phase 4 scenario, E1's five included, and never load-plan", () => {
    for (const n of ["simulcast", "overlay-alert", "vod-clips", "data-export", "account-deletion"]) {
      expect(FULL_REQUIRED).toContain(n);
    }
    for (const n of ["e5-coop", "trust-safety", "e2e-relay", "backup-restore", "load-smoke", "e2e-social"]) {
      expect(FULL_REQUIRED).toContain(n);
    }
    for (const n of ["multi-instance", "e7-admin"]) expect(FULL_REQUIRED).toContain(n);
    expect(FULL_REQUIRED).not.toContain("load-plan");
  });

  test("the shipped scenarios: load-plan out of full; e5-coop, trust-safety, e2e-relay in it, relay last", async () => {
    const r = await loadRegistry(SCENARIOS_DIR, []);
    expect(r.get("load-plan")?.inFull).toBe(false);
    expect(r.get("backup-restore")?.needs).toContain("podman");
    const full = r.full.map((s) => s.name);
    expect(full[0]).toBe("smoke");
    expect(full.at(-1)).toBe("e2e-relay");
    expect(full).not.toContain("load-plan");
    // E1's scenarios land in the same merge; until then only the ones on disk are checked.
    const present = FULL_REQUIRED.filter((n) => existsSync(join(SCENARIOS_DIR, `${n}.ts`)));
    expect(missingFromFull(r.all, present)).toEqual([]);
    for (const n of ["e5-coop", "trust-safety", "e2e-relay", "backup-restore"]) expect(full).toContain(n);
  });

  test("e4b-money gets its Stripe variant from the defaults table; paramNeeds are validated", async () => {
    const r = await loadRegistry(SCENARIOS_DIR, []);
    expect(r.get("e4b-money")?.paramNeeds).toEqual(DEFAULT_PARAM_NEEDS["e4b-money"]);
    expect(new Registry([sc("e4b-money")]).get("e4b-money")?.paramNeeds?.[0]?.needs).toEqual(["stripe"]);
    expect(() =>
      validateScenario(
        { ...sc("x"), paramNeeds: [{ param: "p", value: "v", needs: ["teleport"], step: "s" }] },
        "x.ts",
      ),
    ).toThrow(/paramNeeds/);
  });
});

describe("no-proprietary: selection and skips", () => {
  const stripeVariant = [{ param: "provider", value: "stripe", needs: ["stripe"] as const, step: "Stripe variant" }];

  test("excluded needs only under no-proprietary", () => {
    expect(excludedNeeds(["api", "stripe", "cdn"], "no-proprietary")).toEqual(["stripe", "cdn"]);
    expect(excludedNeeds(["api", "stripe"], "default")).toEqual([]);
  });

  test("an inactive vendor variant is a skipped step; the scenario runs", () => {
    expect(planScenario({ needs: ["api"], paramNeeds: stripeVariant }, "no-proprietary", {})).toEqual({
      needs: ["api"],
      skip: null,
      skippedSteps: [
        { name: "Stripe variant (--set provider=stripe)", reason: "needs stripe (no-proprietary profile)" },
      ],
    });
    expect(planScenario({ needs: ["api"], paramNeeds: stripeVariant }, "default", {})).toEqual({
      needs: ["api"],
      skip: null,
      skippedSteps: [],
    });
  });

  test("an active vendor variant skips the scenario; under default it adds the need", () => {
    expect(
      planScenario({ needs: ["api"], paramNeeds: stripeVariant }, "no-proprietary", { provider: "stripe" }).skip,
    ).toBe("Stripe variant (--set provider=stripe) needs stripe (no-proprietary profile)");
    expect(planScenario({ needs: ["api"], paramNeeds: stripeVariant }, "default", { provider: "stripe" })).toEqual({
      needs: ["api", "stripe"],
      skip: null,
      skippedSteps: [],
    });
  });

  test("a scenario that needs a vendor adapter is skipped whole", () => {
    expect(planScenario({ needs: ["api", "oauth"] }, "no-proprietary", {}).skip).toBe(
      "needs oauth (no-proprietary profile)",
    );
  });

  test("runOne reports variant and optionalStep skips; the scenario still passes", async () => {
    let values: unknown[] = [];
    const s = defineScenario({
      name: "money",
      description: "money",
      needs: [],
      paramNeeds: stripeVariant,
      async run(ctx) {
        values = [
          await ctx.optionalStep("refund through Stripe", ["stripe"], () => 1),
          await ctx.optionalStep("manual refund", ["api"], () => 2),
        ];
      },
    });
    const r = await runOne(s, platform, { command: "run", profile: "no-proprietary", env, log, platform, runId: "r1" });
    expect(values).toEqual([undefined, 2]);
    expect(r.status).toBe("passed");
    expect(r.steps.map((x) => x.name)).toEqual(["manual refund"]);
    expect(r.skippedSteps).toEqual([
      { name: "Stripe variant (--set provider=stripe)", reason: "needs stripe (no-proprietary profile)" },
      { name: "refund through Stripe", reason: "needs stripe (no-proprietary profile)" },
    ]);
    const plain = await runOne(s, platform, { command: "run", profile: "default", env, log, platform, runId: "r1" });
    expect(values).toEqual([1, 2]);
    expect(plain.skippedSteps).toBeUndefined();
    expect(plain.steps.map((x) => x.name)).toEqual(["refund through Stripe", "manual refund"]);
  });

  test("the skip table lists scenario and step skips with reasons", async () => {
    const results = [
      await runOne(sc("cdn-only", { needs: ["cdn"] }), platform, {
        command: "run",
        profile: "no-proprietary",
        env,
        log,
        platform,
        runId: "r1",
      }),
      await runOne(sc("e4b-money", { paramNeeds: stripeVariant }), platform, {
        command: "run",
        profile: "no-proprietary",
        env,
        log,
        platform,
        runId: "r1",
      }),
    ];
    expect(skipRows(results)).toEqual([
      { scenario: "cdn-only", step: null, reason: "needs cdn (no-proprietary profile)" },
      {
        scenario: "e4b-money",
        step: "Stripe variant (--set provider=stripe)",
        reason: "needs stripe (no-proprietary profile)",
      },
    ]);
    const table = formatSkipTable(results);
    expect(table.split("\n")[0]).toBe("skipped (2):");
    expect(table).toContain("(whole scenario)");
    expect(table).toContain("Stripe variant (--set provider=stripe)");
    expect(formatSkipTable([])).toBe("");
  });
});

describe("no-proprietary: the stack preflight", () => {
  test("healthz booleans: all false passes, true or missing fails closed", () => {
    expect(proprietaryProblems(HEALTHY)).toEqual([]);
    expect(proprietaryProblems({ ...HEALTHY, stripe: true, cdn: true })).toEqual([
      "stripe=true (PAYMENTS_PROVIDER=stripe)",
      "cdn=true (CDN_PROVIDER and CDN_BASE_URL are set)",
    ]);
    expect(proprietaryProblems({ ok: true, stripe: false, cdn: false })).toEqual([
      "/healthz does not report oauth as a boolean",
    ]);
    expect(proprietaryProblems({ ...HEALTHY, oauth: "false" })).toEqual([
      "/healthz does not report oauth as a boolean",
    ]);
    expect(proprietaryProblems(null)).toEqual(["the API /healthz body is not a JSON object"]);
  });

  test("preflight only runs for no-proprietary", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return Response.json(HEALTHY);
    }) as unknown as typeof fetch;
    expect(await profilePreflight("default", "http://api", spy)).toBeNull();
    expect(called).toBe(false);
    expect(await profilePreflight("no-proprietary", "http://api/", spy)).toBeNull();
    expect(called).toBe(true);
    expect(await profilePreflight("no-proprietary", "http://api", fakeFetch({ ...HEALTHY, oauth: true }))).toMatch(
      /oauth=true/,
    );
    expect(await profilePreflight("no-proprietary", "http://api:3001", fakeFetch(null, false))).toMatch(
      /unreachable at http:\/\/api:3001/,
    );
  });

  test("a stack with Stripe fails the run before any scenario starts", async () => {
    let ran = false;
    const s = defineScenario({
      name: "a",
      description: "a",
      needs: [],
      run: async () => {
        ran = true;
      },
    });
    const report = await runScenarios([s], {
      command: "run",
      profile: "no-proprietary",
      env,
      log,
      platform,
      runId: "r1",
      fetch: fakeFetch({ ...HEALTHY, stripe: true }),
    });
    expect(ran).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]).toMatchObject({ name: "no-proprietary preflight", status: "failed" });
    expect(report.scenarios[0]?.error).toMatch(/stripe=true \(PAYMENTS_PROVIDER=stripe\)/);

    const clean = await runScenarios([s], {
      command: "run",
      profile: "no-proprietary",
      env,
      log,
      platform,
      runId: "r2",
      fetch: fakeFetch(HEALTHY),
    });
    expect(ran).toBe(true);
    expect(clean.ok).toBe(true);
  });
});
