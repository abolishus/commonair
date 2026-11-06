// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a run report says: the human summary's metric units, failures and inconclusive reasons,
 * the files `writeReport` leaves, and the scenario context's edges (integer params, assertion
 * details that cannot be serialized, a failing cleanup, run ids).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import { loadHarnessEnv } from "../src/env.ts";
import type { Platform } from "../src/platform.ts";
import { type RunReport, formatHuman, reportStem, runOk, writeReport } from "../src/report.ts";
import { newRunId, runOne, runScenarios } from "../src/runner.ts";
import { AssertionFailure, type ScenarioResult, defineScenario } from "../src/scenario.ts";

const env = loadHarnessEnv({});
const lines: string[] = [];
const log = createLogger({ service: "harness-test", level: "warn", write: (l: string) => void lines.push(l) });
const platform = { probe: async () => null } as unknown as Platform;

const result = (o: Partial<ScenarioResult>): ScenarioResult => ({
  name: "s",
  description: "",
  status: "passed",
  startedAt: "2026-11-06T00:00:00.000Z",
  durationMs: 1_500,
  steps: [],
  assertions: [],
  metrics: {},
  data: {},
  ...o,
});

const report = (scenarios: ScenarioResult[]): RunReport => ({
  runId: "r1",
  command: "run",
  profile: "default",
  startedAt: "2026-11-06T10:20:30.400Z",
  finishedAt: "2026-11-06T10:21:30.400Z",
  durationMs: 60_000,
  host: { platform: "linux", arch: "x64", bun: "1", ffmpeg: null },
  targets: { api: "", web: "", origin: "", rtmp: "", whip: "", player: "web" },
  scenarios,
  summary: {
    passed: scenarios.filter((s) => s.status === "passed").length,
    failed: scenarios.filter((s) => s.status === "failed").length,
    skipped: scenarios.filter((s) => s.status === "skipped").length,
    inconclusive: scenarios.filter((s) => s.status === "inconclusive").length,
  },
  ok: runOk(scenarios),
});

describe("formatHuman", () => {
  test("metrics by unit: durations, bytes in B/KiB/MiB, other units, plain numbers", () => {
    const text = formatHuman(
      report([
        result({
          metrics: {
            small: { value: 512, unit: "bytes" },
            kib: { value: 2_048, unit: "bytes" },
            mib: { value: 3 * 1024 ** 2, unit: "bytes" },
            ratio: { value: 0.12345 },
            count: { value: 7 },
            cpu: { value: 41.5, unit: "%" },
            wait: { value: 2_000, unit: "ms" },
          },
        }),
      ]),
    );
    expect(text).toMatch(/small\s+512 B/);
    expect(text).toMatch(/kib\s+2\.0 KiB/);
    expect(text).toMatch(/mib\s+3\.0 MiB/);
    expect(text).toMatch(/ratio\s+0\.123\n/);
    expect(text).toMatch(/count\s+7\n/);
    expect(text).toMatch(/cpu\s+41\.500 %/);
    expect(text).toContain("OK: 1 passed, 0 failed, 0 skipped");
  });

  test("failed steps and assertions, errors, skips and inconclusive reasons (report-only marked)", () => {
    const text = formatHuman(
      report([
        result({
          status: "failed",
          steps: [
            { name: "ok step", status: "passed", durationMs: 10 },
            { name: "bad step", status: "failed", durationMs: 20, error: "boom" },
          ],
          assertions: [
            { name: "fine", passed: true, hard: true },
            { name: "broken", passed: false, hard: false, details: { got: 1 } },
            { name: "bare", passed: false, hard: true },
          ],
          error: "boom",
        }),
        result({ name: "sk", status: "skipped", skipReason: "needs stripe" }),
        result({ name: "inc", status: "inconclusive", inconclusiveReasons: ["generator CPU"], reportOnly: true }),
        result({ name: "inc2", status: "inconclusive", inconclusiveReasons: ["heartbeats"] }),
      ]),
    );
    expect(text).toContain("✗ bad step");
    expect(text).toContain("— boom");
    expect(text).toContain('✗ broken  {"got":1}');
    expect(text).toMatch(/✗ bare\n/);
    expect(text).toContain("assertions: 1/3 passed");
    expect(text).toContain("error: boom");
    expect(text).toContain("SKIP  sk");
    expect(text).toContain("(needs stripe)");
    expect(text).toContain("inconclusive: generator CPU  (report-only)");
    expect(text).toMatch(/inconclusive: heartbeats\n/);
    expect(text).toContain("FAILED: 0 passed, 1 failed, 1 skipped, 2 inconclusive");
  });
});

describe("writeReport", () => {
  test("a stem per run plus latest.json; an explicit JSON path writes no latest", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-report-"));
    try {
      const r = report([result({})]);
      const out = writeReport(r, { dir });
      expect(out.json).toBe(join(dir, `${reportStem(r)}.json`));
      expect(reportStem(r)).toBe("2026-11-06T10-20-30-400Z-run-r1");
      expect(JSON.parse(readFileSync(out.json, "utf8")).runId).toBe("r1");
      expect(readFileSync(out.text, "utf8")).toContain("PASS  s");
      expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).runId).toBe("r1");
      const explicit = writeReport({ ...r, runId: "r2" }, { dir, jsonPath: join(dir, "nested", "mine.JSON") });
      expect(explicit.text).toBe(join(dir, "nested", "mine.txt"));
      expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).runId).toBe("r1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the scenario context's edges", () => {
  const opts = { command: "run", profile: "default" as const, env, log, platform, runId: "r1" };

  test("intParam: a given integer, the fallback, or a failure naming the parameter", async () => {
    const seen: number[] = [];
    const s = defineScenario({
      name: "p",
      description: "",
      needs: [],
      run: async (ctx) => {
        seen.push(ctx.intParam("n", 1), ctx.intParam("missing", 9));
        ctx.intParam("bad", 0);
      },
    });
    const r = await runOne(s, platform, { ...opts, params: { n: "42", bad: "4.5" } });
    expect(seen).toEqual([42, 9]);
    expect(r.status).toBe("failed");
    expect(r.error).toBe("parameter bad must be an integer");
  });

  test("an assertion's details that cannot be serialized still give a message; long ones are cut", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(new AssertionFailure("loop", circular).message).toBe("assertion failed: loop ([object Object])");
    const long = new AssertionFailure("long", { s: "x".repeat(400) }).message;
    expect(long.endsWith("…)")).toBe(true);
    expect(long.length).toBeLessThan(340);
    expect(new AssertionFailure("plain").message).toBe("assertion failed: plain");
  });

  test("a cleanup that throws is logged and the others still run", async () => {
    lines.length = 0;
    const ran: string[] = [];
    const s = defineScenario({
      name: "c",
      description: "",
      needs: [],
      run: async (ctx) => {
        ctx.defer(() => void ran.push("first"));
        ctx.defer(() => {
          throw new Error("cleanup broke");
        });
      },
    });
    const r = await runOne(s, platform, opts);
    expect(r.status).toBe("passed");
    expect(ran).toEqual(["first"]);
    expect(lines.join("\n")).toContain("cleanup broke");
  });

  test("run ids: unique, base-36 time first; a run without one gets one", async () => {
    const a = newRunId();
    expect(a).toMatch(/^[0-9a-z]+[0-9a-f]{6}$/);
    expect(newRunId()).not.toBe(a);
    const s = defineScenario({ name: "n", description: "", needs: [], run: async () => undefined });
    const { runId: _ignored, ...rest } = opts;
    const r = await runScenarios([s], rest);
    expect(r.runId).toMatch(/^[0-9a-z]{12,}$/);
    expect(r.ok).toBe(true);
  });
});

describe("harness env", () => {
  test("HARNESS_BROWSERS is a comma list: trimmed, empties dropped; both engines by default", () => {
    expect(loadHarnessEnv({ HARNESS_BROWSERS: " webkit, ,chromium," }).HARNESS_BROWSERS).toEqual([
      "webkit",
      "chromium",
    ]);
    expect(env.HARNESS_BROWSERS).toEqual(["chromium", "webkit"]);
  });

  test("generator hosts are a comma list: trimmed, empties dropped", async () => {
    const { loadLoadEnv } = await import("../src/env.ts");
    expect(loadLoadEnv({ HARNESS_LOAD_GENERATOR_HOSTS: " a, ,b,," }).HARNESS_LOAD_GENERATOR_HOSTS).toEqual(["a", "b"]);
    expect(loadLoadEnv({}).HARNESS_LOAD_GENERATOR_HOSTS).toEqual([]);
  });
});
