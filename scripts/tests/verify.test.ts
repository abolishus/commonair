// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { GROUPS, selectGroups, steps } from "../verify.ts";

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

describe("steps", () => {
  test("every group has a step, so a CI job per group never runs nothing", () => {
    for (const g of GROUPS) expect(steps.some((s) => s.group === g)).toBe(true);
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

  test("compose groups pin podman compose to podman-compose, not the runner's docker-compose plugin", () => {
    for (const job of [ci.jobs.verify, ci.jobs.harness]) expect(job.env.PODMAN_COMPOSE_PROVIDER).toBe("podman-compose");
    const integration = groups.find((g) => g.group === "integration")!;
    expect(integration.pipx).toMatch(/^podman-compose==/);
    expect(ci.jobs.harness.steps.find((s: { uses?: string }) => s.uses?.includes("actions/setup")).with.pipx).toMatch(
      /^podman-compose==/,
    );
  });

  test("integration and harness get the moderation model and the Playwright browsers", () => {
    const integration = groups.find((g) => g.group === "integration")!;
    expect([integration.model, integration.browsers, integration.system]).toEqual(["true", "true", "harness"]);
    const harnessSetup = ci.jobs.harness.steps.find((s: { uses?: string }) => s.uses?.includes("actions/setup"));
    expect([harnessSetup.with.model, harnessSetup.with.browsers, harnessSetup.with.system]).toEqual([
      "true",
      "true",
      "harness",
    ]);
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
