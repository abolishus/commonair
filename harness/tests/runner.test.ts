// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import { loadHarnessEnv } from "../src/env.ts";
import type { Platform } from "../src/platform.ts";
import { evaluateNeeds, runOne, runScenarios } from "../src/runner.ts";
import { type Need, type Scenario, defineScenario } from "../src/scenario.ts";

const env = loadHarnessEnv({});
const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });

function fakePlatform(unmet: Partial<Record<Need, string>> = {}): Platform {
  return { probe: async (n: Need) => unmet[n] ?? null } as unknown as Platform;
}

const opts = (platform: Platform) => ({ command: "run", profile: "default" as const, env, log, platform, runId: "r1" });

describe("needs", () => {
  const probe = async (n: Need) => (n === "chat" ? "chat unreachable" : null);

  test("all met → run", async () => {
    expect(await evaluateNeeds(["api", "mail"], "default", probe)).toEqual({ run: true });
  });

  test("unmet → failed, or skipped with --skip-unavailable", async () => {
    expect(await evaluateNeeds(["api", "chat"], "default", probe)).toEqual({
      run: false,
      status: "failed",
      reason: "unmet needs — chat: chat unreachable",
    });
    expect(await evaluateNeeds(["chat"], "default", probe, true)).toMatchObject({ run: false, status: "skipped" });
  });

  test("no-proprietary profile skips vendor scenarios without probing", async () => {
    let probed = false;
    const verdict = await evaluateNeeds(["api", "stripe"], "no-proprietary", async () => {
      probed = true;
      return null;
    });
    expect(verdict).toEqual({ run: false, status: "skipped", reason: "needs stripe (no-proprietary profile)" });
    expect(probed).toBe(false);
    expect(await evaluateNeeds(["api"], "no-proprietary", async () => null)).toEqual({ run: true });
  });
});

describe("running a scenario", () => {
  test("records steps, checks, metrics and runs cleanups in reverse", async () => {
    const order: string[] = [];
    const s = defineScenario({
      name: "demo",
      description: "demo",
      needs: ["api"],
      async run(ctx) {
        ctx.defer(() => order.push("first"));
        ctx.defer(async () => order.push("second"));
        const v = await ctx.step("compute", () => 41 + 1);
        ctx.assert("is 42", v === 42);
        ctx.check("soft ok", true);
        ctx.metric("latency", 12.5, "ms");
        ctx.metric("ignored", null);
        ctx.metric("nan", Number.NaN);
        ctx.data("extra", { a: 1 });
        expect(ctx.intParam("n", 3)).toBe(3);
        expect(ctx.param("p", "d")).toBe("d");
      },
    });
    const r = await runOne(s, fakePlatform(), opts(fakePlatform()));
    expect(r.status).toBe("passed");
    expect(r.steps).toEqual([{ name: "compute", status: "passed", durationMs: expect.any(Number) }]);
    expect(r.assertions.map((a) => [a.name, a.passed, a.hard])).toEqual([
      ["is 42", true, true],
      ["soft ok", true, false],
    ]);
    expect(r.metrics).toEqual({ latency: { value: 12.5, unit: "ms" } });
    expect(r.data).toEqual({ extra: { a: 1 } });
    expect(order).toEqual(["second", "first"]);
  });

  test("a failed soft check fails the scenario but lets it finish", async () => {
    let reachedEnd = false;
    const s = defineScenario({
      name: "soft",
      description: "soft",
      needs: [],
      async run(ctx) {
        ctx.check("nope", false, { why: "test" });
        reachedEnd = true;
      },
    });
    const r = await runOne(s, fakePlatform(), opts(fakePlatform()));
    expect(r.status).toBe("failed");
    expect(reachedEnd).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test("a failed hard assertion stops the scenario; cleanups still run", async () => {
    let cleaned = false;
    let after = false;
    const s = defineScenario({
      name: "hard",
      description: "hard",
      needs: [],
      async run(ctx) {
        ctx.defer(() => {
          cleaned = true;
        });
        ctx.assert("must hold", false, { got: 1 });
        after = true;
      },
    });
    const r = await runOne(s, fakePlatform(), opts(fakePlatform()));
    expect(r.status).toBe("failed");
    expect(r.error).toBe('assertion failed: must hold ({"got":1})');
    expect(after).toBe(false);
    expect(cleaned).toBe(true);
  });

  test("a failing step is recorded with its error", async () => {
    const s = defineScenario({
      name: "boom",
      description: "boom",
      needs: [],
      async run(ctx) {
        await ctx.step("explode", async () => {
          throw new Error("kaboom");
        });
      },
    });
    const r = await runOne(s, fakePlatform(), opts(fakePlatform()));
    expect(r.steps[0]).toMatchObject({ name: "explode", status: "failed", error: "kaboom" });
    expect(r.error).toBe("kaboom");
  });

  test("timeouts abort the scenario's signal", async () => {
    let aborted = false;
    const s = defineScenario({
      name: "slow",
      description: "slow",
      needs: [],
      timeoutMs: 100,
      async run(ctx) {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await Bun.sleep(1_000);
      },
    });
    const r = await runOne(s, fakePlatform(), opts(fakePlatform()));
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/timed out after 100 ms/);
    expect(aborted).toBe(true);
  });

  test("unmet needs fail without running", async () => {
    let ran = false;
    const s: Scenario = defineScenario({
      name: "needy",
      description: "needy",
      needs: ["irc"],
      run: async () => {
        ran = true;
      },
    });
    const p = fakePlatform({ irc: "IRC gateway unreachable" });
    const r = await runOne(s, p, opts(p));
    expect(ran).toBe(false);
    expect(r).toMatchObject({ status: "failed", error: "unmet needs — irc: IRC gateway unreachable" });
  });

  test("a run report aggregates results; ok only when nothing failed", async () => {
    const pass = defineScenario({ name: "a", description: "a", needs: [], run: async () => undefined });
    const fail = defineScenario({
      name: "b",
      description: "b",
      needs: [],
      run: async () => Promise.reject(new Error("x")),
    });
    const p = fakePlatform();
    const good = await runScenarios([pass], opts(p));
    expect(good.ok).toBe(true);
    expect(good.summary).toEqual({ passed: 1, failed: 0, skipped: 0 });
    const bad = await runScenarios([pass, fail], opts(p));
    expect(bad.ok).toBe(false);
    expect(bad.scenarios.map((s) => s.status)).toEqual(["passed", "failed"]);
    expect(bad.targets.api).toBe(env.HARNESS_API_URL);
  });

  test("an aborted run stops before later scenarios", async () => {
    const controller = new AbortController();
    const first = defineScenario({
      name: "first",
      description: "first",
      needs: [],
      run: async () => {
        controller.abort(new Error("stop"));
      },
    });
    const second = defineScenario({ name: "second", description: "second", needs: [], run: async () => undefined });
    const p = fakePlatform();
    const report = await runScenarios([first, second], { ...opts(p), signal: controller.signal });
    expect(report.scenarios.map((s) => s.name)).toEqual(["first"]);
  });
});

describe("env", () => {
  test("defaults match the compose stack", () => {
    expect(env.HARNESS_API_URL).toBe("http://localhost:3001");
    expect(env.HARNESS_RTMP_URL).toBe("rtmp://localhost:1935");
    expect(env.HARNESS_WHIP_URL).toBe("http://localhost:8889");
    expect(env.HARNESS_MAILPIT_URL).toBe("http://localhost:8025");
    expect(env.HARNESS_BROWSERS).toEqual(["chromium", "webkit"]);
    expect(env.HARNESS_PLAYER).toBe("harness");
    expect(env.HARNESS_HEADFUL).toBe(false);
  });

  test("overrides and validation", () => {
    expect(loadHarnessEnv({ HARNESS_API_URL: "http://api:9", HARNESS_HEADFUL: "1" })).toMatchObject({
      HARNESS_API_URL: "http://api:9",
      HARNESS_HEADFUL: true,
    });
    expect(() => loadHarnessEnv({ HARNESS_API_URL: "not a url" })).toThrow(/HARNESS_API_URL/);
    expect(() => loadHarnessEnv({ HARNESS_PLAYER: "vlc" })).toThrow(/HARNESS_PLAYER/);
  });
});
