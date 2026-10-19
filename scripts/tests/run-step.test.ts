// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { type ContainerRow, crashLooping, foreignContainers } from "../infra.ts";
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
