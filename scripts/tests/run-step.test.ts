// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type ContainerRow,
  STALE_TEST_MS,
  type TestResource,
  crashLooping,
  foreignContainers,
  HARNESS_OVERRIDES,
  stackFiles,
  stackProfiles,
  staleImageContainers,
  staleTestResources,
} from "../infra.ts";
import { runStep } from "../run-step.ts";

const quiet = { stdio: "ignore" as const, log: () => {} };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runStep", () => {
  test("passes through success and failure exit codes", async () => {
    expect(await runStep(["true"], { timeoutMs: 10_000, ...quiet })).toMatchObject({ ok: true, timedOut: false });
    const r = await runStep(["sh", "-c", "exit 3"], { timeoutMs: 10_000, ...quiet });
    expect(r).toMatchObject({ ok: false, timedOut: false, exitCode: 3 });
  });

  test("a step past its deadline fails as timed out", async () => {
    const r = await runStep(["sleep", "30"], { timeoutMs: 200, killGraceMs: 200, ...quiet });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeLessThan(5_000);
  });

  test("a timeout kills grandchildren, not just the direct child", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/run-step-${crypto.randomUUID()}.pid`;
    // The shell ignores SIGTERM, so only the group-wide SIGKILL after the grace period stops it.
    const script = `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`;
    const r = await runStep(["sh", "-c", script], { timeoutMs: 300, killGraceMs: 200, ...quiet });
    expect(r.timedOut).toBe(true);
    const grandchild = Number(await Bun.file(pidFile).text());
    await Bun.sleep(100);
    expect(alive(grandchild)).toBe(false);
  });

  test("children left behind by a finished step are reaped", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/run-step-${crypto.randomUUID()}.pid`;
    const r = await runStep(["sh", "-c", `sleep 30 & echo $! > ${pidFile}`], { timeoutMs: 10_000, ...quiet });
    expect(r.ok).toBe(true);
    const orphan = Number(await Bun.file(pidFile).text());
    await Bun.sleep(100);
    expect(alive(orphan)).toBe(false);
  });

  test("heartbeat reports a long step", async () => {
    const lines: string[] = [];
    await runStep(["sleep", "0.35"], {
      timeoutMs: 10_000,
      heartbeatMs: 100,
      stdio: "ignore",
      log: (l) => lines.push(l),
    });
    expect(lines.some((l) => l.includes("still running"))).toBe(true);
  });
});

const row = (over: Partial<ContainerRow>): ContainerRow => ({
  name: "commonair_garage_1",
  service: "garage",
  workingDir: "/Users/me/bcon",
  status: "running",
  restarts: 0,
  ...over,
});

describe("foreignContainers", () => {
  test("flags containers created from another checkout", () => {
    const rows = [row({}), row({ service: "valkey", workingDir: "/Users/me/bcon/.claude/worktrees/agent-1" })];
    expect(foreignContainers(rows, "/Users/me/bcon").map((r) => r.service)).toEqual(["valkey"]);
  });

  test("treats /private/tmp and /tmp, and a trailing slash, as the same path", () => {
    expect(foreignContainers([row({ workingDir: "/private/tmp/x" })], "/tmp/x/")).toEqual([]);
  });

  test("ignores containers without a working-dir label", () => {
    expect(foreignContainers([row({ workingDir: "" })], "/Users/me/bcon")).toEqual([]);
  });
});

describe("crashLooping", () => {
  test("flags a service at the restart threshold, not below it", () => {
    expect(crashLooping([row({ restarts: 2 })])).toEqual([]);
    expect(crashLooping([row({ restarts: 3, status: "exited" })])).toHaveLength(1);
  });
});

describe("staleTestResources", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");
  const old = now - STALE_TEST_MS - 1;
  const res = (name: string, createdMs = old, kind: TestResource["kind"] = "container"): TestResource => ({
    kind,
    name,
    createdMs,
  });

  test("selects old throwaway test containers, compose projects, volumes and networks", () => {
    const rows = [
      res("media-int-garage-a00d662b"),
      res("media-int-mtx-e5c3f33f"),
      res("media-int-target-ae031e9f"),
      res("harness-mediamtx-2a9ddb70"),
      res("origin-test-68a93d4a"),
      res("commonair-it-783005c5_postgres_1"),
      res("commonair-it-783005c5-restore"),
      res("commonair-it-783005c5_postgres-data", old, "volume"),
      res("commonair-it-783005c5_default", old, "network"),
    ];
    expect(staleTestResources(rows, now)).toEqual(rows);
  });

  test("keeps anything younger than the cutoff: another checkout may be mid-run", () => {
    expect(staleTestResources([res("media-int-mtx-e5c3f33f", now - STALE_TEST_MS + 1)], now)).toEqual([]);
  });

  test("never touches the dev stack or unrelated containers", () => {
    const rows = [
      res("commonair_postgres_1"),
      res("commonair_postgres-data", old, "volume"),
      res("commonair_default", old, "network"),
      res("commonair-it-783005c5"),
      res("media-int-mtx-notahex1"),
      res("my-media-int-mtx-e5c3f33f"),
      res("podman", old, "network"),
    ];
    expect(staleTestResources(rows, now)).toEqual([]);
  });

  test("an unknown creation time is never stale", () => {
    expect(staleTestResources([res("origin-test-68a93d4a", Number.NaN)], now)).toEqual([]);
  });
});

describe("stackFiles", () => {
  test("the plain stack passes no -f, so compose picks compose.yaml itself", () => {
    expect(stackFiles([])).toEqual([]);
  });

  test("overrides are layered over compose.yaml, by absolute path", () => {
    const args = stackFiles(["harness/compose.trust-safety.yaml"]);
    expect(args.filter((a) => a === "-f")).toHaveLength(2);
    expect(args[1]).toMatch(/\/compose\.yaml$/);
    expect(args[3]).toMatch(/\/harness\/compose\.trust-safety\.yaml$/);
  });

  test("--harness layers every harness override, then any extra file", () => {
    const files = stackFiles(["--harness"]).filter((a) => a !== "-f");
    expect(files).toHaveLength(1 + HARNESS_OVERRIDES.length);
    expect(files.slice(1).map((f) => f.slice(f.indexOf("/harness/") + 1))).toEqual([...HARNESS_OVERRIDES]);
    expect(stackFiles(["harness/compose.e6.yaml", "--harness"]).filter((a) => a === "-f")).toHaveLength(
      2 + HARNESS_OVERRIDES.length,
    );
  });

  test("--multi adds the multi profile, only on top of --harness, and is not a file", () => {
    expect(stackProfiles(["--harness"])).toEqual(["harness"]);
    expect(stackProfiles(["--harness", "--multi"])).toEqual(["harness", "multi"]);
    expect(() => stackProfiles(["--multi"])).toThrow(/needs --harness/);
    expect(stackFiles(["--harness", "--multi"])).toEqual(stackFiles(["--harness"]));
    expect(HARNESS_OVERRIDES).toContain("harness/compose.multi-instance.yaml");
  });

  test("refuses a missing file or an option instead of starting the wrong stack", () => {
    expect(() => stackFiles(["nope.yaml"])).toThrow(/not found/);
    expect(() => stackFiles(["--build"])).toThrow(/unknown option/);
  });
});

describe("staleImageContainers", () => {
  const current = new Map([
    ["localhost/commonair/api:dev", "b8c024aae97d8e2a244d"],
    ["docker.io/dxflrs/garage:v2.4.1", "2711bbf081dcffff"],
  ]);

  test("a container whose tag now points at a newer build is stale", () => {
    const rows = [{ name: "commonair_api_1", imageId: "0123456789ab", image: "localhost/commonair/api:dev" }];
    expect(staleImageContainers(rows, current)).toEqual(rows);
  });

  test("current containers, unknown images and missing ids are left alone", () => {
    const rows = [
      { name: "commonair_api_1", imageId: "b8c024aae97d", image: "localhost/commonair/api:dev" },
      { name: "commonair_garage_1", imageId: "2711bbf081dc", image: "docker.io/dxflrs/garage:v2.4.1" },
      { name: "commonair_web_1", imageId: "aaaaaaaaaaaa", image: "localhost/commonair/web:dev" },
      { name: "commonair_x_1", imageId: "", image: "localhost/commonair/api:dev" },
    ];
    expect(staleImageContainers(rows, current)).toEqual([]);
  });
});
