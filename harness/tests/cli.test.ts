// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { UsageError, parseArgs } from "../src/args.ts";
import {
  FULL,
  FULL_SHARDS,
  type FullShard,
  Registry,
  RegistryError,
  loadRegistry,
  validateScenario,
} from "../src/registry.ts";
import { type RunReport, formatHuman, reportStem, summarizeResults, writeReport } from "../src/report.ts";
import { type Scenario, type ScenarioResult, defineScenario } from "../src/scenario.ts";

const noop = async () => undefined;
const sc = (name: string, extra: Partial<Scenario> = {}): Scenario =>
  defineScenario({ name, description: `${name} scenario`, needs: ["api"], run: noop, ...extra });

describe("argument parsing", () => {
  test("run with scenarios, profile, report and params", () => {
    const cmd = parseArgs([
      "run",
      "smoke",
      "viewers",
      "--profile",
      "no-proprietary",
      "--report",
      "out.json",
      "--set",
      "viewers=20",
      "--set=x=y",
    ]);
    expect(cmd).toEqual({
      kind: "run",
      scenarios: ["smoke", "viewers"],
      skipUnavailable: false,
      profile: "no-proprietary",
      report: "out.json",
      player: undefined,
      params: { viewers: "20", x: "y" },
    });
  });

  test("--no-proprietary alias, --player and --skip-unavailable", () => {
    const cmd = parseArgs(["run", "full", "--no-proprietary", "--player=web", "--skip-unavailable"]);
    expect(cmd.kind === "run" && cmd.profile).toBe("no-proprietary");
    expect(cmd.kind === "run" && cmd.player).toBe("web");
    expect(cmd.kind === "run" && cmd.skipUnavailable).toBe(true);
  });

  test("load with durations", () => {
    expect(parseArgs(["load", "--streamers", "3", "--viewers", "200", "--duration", "2m"])).toMatchObject({
      kind: "load",
      streamers: 3,
      viewers: 200,
      durationMs: 120_000,
      protocol: "rtmp",
      browserViewers: undefined,
    });
    expect(parseArgs(["load", "--duration", "90s", "--browser-viewers", "4", "--protocol", "whip"])).toMatchObject({
      durationMs: 90_000,
      browserViewers: 4,
      protocol: "whip",
      streamers: 1,
      viewers: 10,
    });
  });

  test("list and help", () => {
    expect(parseArgs(["list", "--json"])).toEqual({ kind: "list", json: true });
    expect(parseArgs([])).toEqual({ kind: "help" });
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
  });

  test.each([
    [["run"], /at least one scenario/],
    [["run", "smoke", "--profile", "cloud"], /--profile/],
    [["run", "smoke", "--report"], /needs a value/],
    [["run", "smoke", "--set", "novalue"], /key=value/],
    [["run", "smoke", "--streamers", "2"], /unknown option/],
    [["load", "--streamers", "0"], /at least 1/],
    [["load", "--viewers", "-3"], /non-negative/],
    [["load", "--duration", "soon"], /invalid duration/],
    [["load", "--protocol", "srt"], /rtmp or whip/],
    [["load", "extra"], /unexpected argument/],
    [["frobnicate"], /unknown command/],
    [["run", "smoke", "--player", "vlc"], /--player/],
  ])("%j is a usage error", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("scenario registry", () => {
  test("validates shape and file name", () => {
    expect(validateScenario(sc("smoke"), "smoke.ts").name).toBe("smoke");
    expect(() => validateScenario(sc("smoke"), "other.ts")).toThrow(/file name/);
    expect(() => validateScenario(null, "x.ts")).toThrow(RegistryError);
    expect(() => validateScenario({ ...sc("x"), description: "" }, "x.ts")).toThrow(/description/);
    expect(() => validateScenario({ ...sc("x"), needs: ["teleport"] }, "x.ts")).toThrow(/needs/);
    expect(() => validateScenario({ ...sc("x"), run: 1 }, "x.ts")).toThrow(/run/);
    expect(() => validateScenario(sc(FULL), `${FULL}.ts`)).toThrow(/reserved/);
  });

  test("full expands to every included scenario, smoke first, deduped", () => {
    const r = new Registry([sc("viewers"), sc("smoke"), sc("load-huge", { inFull: false }), sc("chat")]);
    expect(r.full.map((s) => s.name)).toEqual(["smoke", "chat", "viewers"]);
    expect(r.resolve(["viewers", FULL]).map((s) => s.name)).toEqual(["viewers", "smoke", "chat"]);
    expect(r.resolve(["load-huge"]).map((s) => s.name)).toEqual(["load-huge"]);
    expect(() => r.resolve(["nope", "smoke"])).toThrow(/unknown scenario\(s\): nope/);
    expect(() => r.resolve([])).toThrow(/no scenario/);
    expect(() => new Registry([sc("a"), sc("a")])).toThrow(/duplicate/);
  });

  test("loads the shipped scenarios and skips helper modules", async () => {
    const r = await loadRegistry();
    const names = r.all.map((s) => s.name);
    for (const n of ["smoke", "ingest-rtmp", "ingest-whip", "viewers", "load-smoke"]) expect(names).toContain(n);
    expect(names).not.toContain("_ingest");
    expect(r.get("ingest-whip")?.needs).toContain("whip");
  });

  test("e2e-social is registered, in full, and needs the web app, IRC and a browser", async () => {
    const r = await loadRegistry();
    const social = r.get("e2e-social");
    expect(social).toBeDefined();
    for (const n of ["api", "web", "chat", "irc", "media", "ffmpeg", "browser"] as const)
      expect(social?.needs).toContain(n);
    expect(r.full.map((s) => s.name)).toContain("e2e-social");
  });

  // CI runs `full` as one job per shard: together they must be exactly `full`, each once.
  test("the full shards partition full, in its order, and each is non-empty", async () => {
    const r = await loadRegistry();
    const full = r.full.map((s) => s.name);
    const parts = (Object.keys(FULL_SHARDS) as FullShard[]).map((sh) =>
      r.resolve([`${FULL}:${sh}`]).map((s) => s.name),
    );
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
    expect(parts.flat().sort()).toEqual([...full].sort());
    expect(new Set(parts.flat()).size).toBe(full.length);
    for (const p of parts) expect(p).toEqual(full.filter((n) => p.includes(n)));
    expect(r.resolve([`${FULL}:rest`])[0]?.name).toBe("smoke");
  });

  test("a new scenario lands in the rest shard; unknown shards and stray names are refused", () => {
    const named = Object.values(FULL_SHARDS).flatMap((n) => n ?? []);
    const r = new Registry([sc("smoke"), sc("brand-new"), ...named.map((n) => sc(n))]);
    expect(r.resolve([`${FULL}:rest`]).map((s) => s.name)).toEqual(["smoke", "brand-new"]);
    expect(() => r.resolve([`${FULL}:nope`])).toThrow(/unknown full shard\(s\): nope/);
    // A shard scenario left out of full (inFull: false) would run nowhere: refuse.
    const left = new Registry([sc("smoke"), ...named.map((n) => sc(n, { inFull: n !== "e5-coop" }))]);
    expect(() => left.resolve([`${FULL}:rest`])).toThrow(/not in full: e5-coop/);
  });

  test("discovers scenarios dropped into a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-reg-"));
    try {
      const scenarioModule = new URL("../src/scenario.ts", import.meta.url).href;
      writeFileSync(
        join(dir, "extra.ts"),
        `import { defineScenario } from ${JSON.stringify(scenarioModule)};\nexport default defineScenario({ name: "extra", description: "d", needs: [], run: async () => {} });\n`,
      );
      writeFileSync(join(dir, "_helper.ts"), "export const x = 1;\n");
      const r = await loadRegistry(dir);
      expect(r.all.map((s) => s.name)).toEqual(["extra"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reports", () => {
  const result = (
    name: string,
    status: ScenarioResult["status"],
    extra: Partial<ScenarioResult> = {},
  ): ScenarioResult => ({
    name,
    description: name,
    status,
    startedAt: "2026-10-18T12:00:00.000Z",
    durationMs: 1234,
    steps: [],
    assertions: [],
    metrics: {},
    data: {},
    ...extra,
  });
  const scenarios = [
    result("smoke", "passed", {
      steps: [{ name: "sign up", status: "passed", durationMs: 800 }],
      assertions: [{ name: "me matches", passed: true, hard: true }],
      metrics: {
        signup: { value: 812, unit: "ms" },
        "egress.origin": { value: 3 * 1024 * 1024, unit: "bytes" },
        ratio: { value: 0.0125 },
      },
    }),
    result("viewers", "failed", {
      steps: [{ name: "converge", status: "failed", durationMs: 120_000, error: "timed out" }],
      assertions: [{ name: "count converges", passed: false, hard: true, details: { seen: 9 } }],
      error: "assertion failed: count converges",
    }),
    result("tip", "skipped", { skipReason: "needs stripe (no-proprietary profile)" }),
  ];
  const report: RunReport = {
    runId: "abc123",
    command: "run",
    profile: "no-proprietary",
    startedAt: "2026-10-18T12:00:00.000Z",
    finishedAt: "2026-10-18T12:03:00.000Z",
    durationMs: 180_000,
    host: { platform: "darwin", arch: "arm64", bun: "1.4.3", ffmpeg: "9.0.1" },
    targets: { api: "http://localhost:3001" },
    scenarios,
    summary: summarizeResults(scenarios),
    ok: false,
  };

  test("summary counts", () => {
    expect(report.summary).toEqual({ passed: 1, failed: 1, skipped: 1 });
  });

  test("human format lists outcomes, failures, metrics and skips", () => {
    const text = formatHuman(report);
    expect(text).toContain("PASS  smoke");
    expect(text).toContain("FAIL  viewers");
    expect(text).toContain("SKIP  tip");
    expect(text).toContain("needs stripe");
    expect(text).toContain("✗ count converges");
    expect(text).toContain('{"seen":9}');
    expect(text).toContain("signup");
    expect(text).toContain("3.0 MiB");
    expect(text).toContain("0.013");
    expect(text).toContain("assertions: 1/1 passed");
    expect(text).toContain("FAILED: 1 passed, 1 failed, 1 skipped");
  });

  test("writes JSON, text and latest.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-report-"));
    try {
      const paths = writeReport(report, { dir });
      expect(paths.json).toBe(join(dir, `${reportStem(report)}.json`));
      expect(JSON.parse(readFileSync(paths.json, "utf8"))).toEqual(report);
      expect(readFileSync(paths.text, "utf8")).toContain("FAIL  viewers");
      expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).runId).toBe("abc123");
      const custom = writeReport(report, { dir, jsonPath: join(dir, "nested", "mine.json") });
      expect(custom.text).toBe(join(dir, "nested", "mine.txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("report stems are filesystem-safe", () => {
    expect(reportStem(report)).toBe("2026-10-18T12-00-00-000Z-run-abc123");
  });
});
