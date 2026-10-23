// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { FULL_SHARDS } from "../../harness/src/shards.ts";
import { GROUPS, fullScenarioArg, infraUpCmd, selectGroups, shardError, steps } from "../verify.ts";

describe("selectGroups", () => {
  test("every group without --only", () => {
    expect([...selectGroups([])]).toEqual([...GROUPS]);
    expect([...selectGroups(["--quick"])]).toEqual([...GROUPS]);
  });

  test("a comma-separated subset", () => {
    expect([...selectGroups(["--only", "static,relay"])].sort()).toEqual(["relay", "static"]);
    expect([...selectGroups(["--full", "--only", "harness"])]).toEqual(["harness"]);
  });

  test("an unknown or missing group is an error, not an empty gate", () => {
    expect(() => selectGroups(["--only", "statc"])).toThrow(/unknown verify group "statc"/);
    expect(() => selectGroups(["--only"])).toThrow(/needs a group list/);
    expect(() => selectGroups(["--only", ","])).toThrow(/needs a group list/);
  });
});

describe("--shard", () => {
  test("runs one part of full, or all of it without --shard", () => {
    expect(fullScenarioArg(["--full", "--only", "harness", "--shard", "rest"])).toBe("full:rest");
    expect(fullScenarioArg(["--full"])).toBe("full");
    expect(shardError(["--full", "--shard", "relay"])).toBeNull();
    expect(shardError(["--full"])).toBeNull();
  });

  test("a shard without a name or without --full is an error, not a silently skipped step", () => {
    expect(shardError(["--full", "--shard"])).toMatch(/needs a shard name/);
    expect(shardError(["--full", "--shard", "--only"])).toMatch(/needs a shard name/);
    expect(shardError(["--shard", "rest"])).toMatch(/pass --full/);
  });
});

describe("steps", () => {
  test("every group has a step, so a CI job per group never runs nothing", () => {
    for (const g of GROUPS) expect(steps.some((s) => s.group === g)).toBe(true);
  });

  // CI's first full run started the plain stack: account-deletion, vod-clips, trust-safety,
  // e5-coop, data-export, simulcast and e2e-relay all failed on a missing override.
  test("platform up starts the harness stack, with every harness override", () => {
    const up = steps.find((s) => s.name === "platform up");
    expect(up?.group).toBe("harness");
    expect(up?.cmd).toEqual(["bun", "scripts/infra.ts", "stack", "--harness"]);
  });

  // Review of that fix (HIGH): on a fresh volume, infra up's migrate seeded default governance
  // before platform up, and the E5 bootstrap applies only at the first migration (ADR 0020).
  test("infra up layers the harness overrides when harness scenarios follow, else none", () => {
    expect(infraUpCmd(true)).toEqual(["bun", "scripts/infra.ts", "test", "--harness"]);
    expect(infraUpCmd(false)).toEqual(["bun", "scripts/infra.ts", "test"]);
    // This test runs without --full or --scenario: the plain gate starts the plain data services.
    expect(steps.find((s) => s.name === "infra up")?.cmd).toEqual(infraUpCmd(false));
  });
});

// CI runs each group as its own job; these pin what the groups need from it, the fixes that
// first got the gate green on CI (podman-compose, the moderation model, the browsers).
describe("CI verify jobs", () => {
  const ROOT = new URL("../../", import.meta.url).pathname;
  // oxlint-disable-next-line typescript/no-explicit-any -- parsed YAML, narrowed by the assertions
  const yaml = (p: string): any => Bun.YAML.parse(readFileSync(join(ROOT, p), "utf8"));
  const ci = yaml(".github/workflows/ci.yml");
  const setup = yaml(".github/actions/setup/action.yml");
  const groups = ci.jobs.verify.strategy.matrix.include as Record<string, string>[];
  const runOf = (job: { steps: { run?: string }[] }) => job.steps.map((s) => s.run ?? "").join("\n");

  test("one matrix job per group but harness, which runs on its own off pull requests", () => {
    expect(new Set(groups.map((g) => g.group))).toEqual(new Set(GROUPS.filter((g) => g !== "harness")));
    expect(runOf(ci.jobs.verify)).toContain('bun scripts/verify.ts --only "$GROUP"');
    expect(runOf(ci.jobs.harness)).toContain("bun scripts/verify.ts --full --only harness");
    expect(ci.jobs["ci-ok"].needs).toEqual(expect.arrayContaining(["verify", "harness"]));
  });

  // `full` runs as one job per shard; a shard missing here would silently never run on CI.
  test("one harness job per full shard, each running its own shard of the full scenario", () => {
    expect(ci.jobs.harness.strategy.matrix.shard).toEqual(Object.keys(FULL_SHARDS));
    expect(ci.jobs.harness.strategy["fail-fast"]).toBe(false);
    expect(runOf(ci.jobs.harness)).toContain('bun scripts/verify.ts --full --only harness --shard "$SHARD"');
    const verify = ci.jobs.harness.steps.find((s: { name?: string }) => s.name === "Verify");
    expect(verify.env.SHARD).toBe("${{ matrix.shard }}");
  });

  // Only the release (release.yml through release-dry-run) may push packages.
  test("no CI job but the release dry run can write packages", () => {
    const writers = Object.entries(ci.jobs as Record<string, { permissions?: Record<string, string> }>)
      .filter(([, job]) => job.permissions?.packages === "write")
      .map(([name]) => name);
    expect(writers).toEqual(["release-dry-run"]);
  });

  test("a harness shard's step outlasts verify's own limits, so verify stops a hang and reports it", () => {
    const step = ci.jobs.harness.steps.find((s: { name?: string }) => s.name === "Verify");
    // platform up + browsers + the full scenario (this test passes no --scenario).
    const own = steps.filter((s) => s.group === "harness").reduce((m, s) => m + s.timeoutMin, 0);
    expect(step["timeout-minutes"]).toBeGreaterThanOrEqual(own);
    expect(ci.jobs.harness["timeout-minutes"]).toBeGreaterThan(step["timeout-minutes"]);
  });

  // A dispatch on a branch is how a harness fix is proven before main; it ran nothing before.
  test("harness runs on main, nightly and a manual dispatch, never on a pull request", () => {
    expect(ci.jobs.harness.if).toBe(
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || " +
        "(github.event_name == 'push' && github.ref == 'refs/heads/main')",
    );
  });

  test("compose groups pin podman compose to podman-compose, not the runner's docker-compose plugin", () => {
    for (const job of [ci.jobs.verify, ci.jobs.harness]) expect(job.env.PODMAN_COMPOSE_PROVIDER).toBe("podman-compose");
    const integration = groups.find((g) => g.group === "integration")!;
    expect(integration.pipx).toMatch(/^podman-compose==/);
    expect(ci.jobs.harness.steps.find((s: { uses?: string }) => s.uses?.includes("actions/setup")).with.pipx).toMatch(
      /^podman-compose==/,
    );
  });

  test("integration and harness get the model, the browsers, their libraries and ffmpeg", () => {
    const integration = groups.find((g) => g.group === "integration")!;
    const harnessSetup = ci.jobs.harness.steps.find((s: { uses?: string }) => s.uses?.includes("actions/setup")).with;
    for (const w of [integration, harnessSetup])
      expect([w.model, w.browsers, w["playwright-deps"], w.ffmpeg]).toEqual(["true", "true", "true", "true"]);
  });

  test("unit gets ffmpeg (the harness unit tests run it); static and relay touch neither apt nor ffmpeg", () => {
    const by = (g: string) => groups.find((x) => x.group === g)!;
    expect(by("unit").ffmpeg).toBe("true");
    for (const g of ["static", "relay"]) expect([by(g).ffmpeg, by(g)["playwright-deps"]]).toEqual(["false", "false"]);
  });

  test("ffmpeg is one pinned build, checked by the hash its cache is keyed on", () => {
    const steps = setup.runs.steps as { name?: string; env?: Record<string, string>; with?: Record<string, string> }[];
    const install = steps.find((s) => s.name === "ffmpeg")!.env!;
    expect(install.URL).toMatch(/^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-[\d-]+\//);
    expect(install.SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(steps.find((s) => s.name === "ffmpeg cache")!.with!.key).toContain(install.SHA256);
  });

  test("the setup action installs what those inputs ask for, gated only on the input", () => {
    const steps = setup.runs.steps as { name?: string; if?: string; run?: string }[];
    const byRun = (r: string) => steps.find((s) => s.run?.trim() === r);
    expect(byRun("bun scripts/fetch-model.ts")?.if).toBe("inputs.model == 'true'");
    expect(byRun("bun run --filter @commonair/harness browsers")?.if).toBe("inputs.browsers == 'true'");
    expect(steps.find((s) => s.name === "Playwright browsers cache")?.if).toBe("inputs.browsers == 'true'");
    expect(steps.find((s) => s.name === "Moderation model cache")?.if).toBe("inputs.model == 'true'");
  });
});
