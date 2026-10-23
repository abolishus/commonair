// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * scripts/selfhost/cgroup-reset.sh under a real `sh`, against a fake cgroup tree (its first
 * argument). A fake tree cannot show the kernel's side (rmdir of a cgroup that still
 * holds files, what a subtree_control write does), so plain empty directories stand in for empty
 * sub-cgroups and the test reads back what the script wrote. The real thing was reproduced on a
 * systemd 257 host: see PROGRESS.md (session twelve, the worker restart fix).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { shellcheck, shellcheckAvailable } from "./support/shellcheck.ts";

const SCRIPT = new URL("../selfhost/cgroup-reset.sh", import.meta.url).pathname;
const UNIT = "user.slice/user-1000.slice/user@1000.service/app.slice/commonair-worker.service";

function tree(opts: { self?: string; subtree?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "commonair-cgroup-reset-"));
  mkdirSync(join(root, "proc/self"), { recursive: true });
  writeFileSync(join(root, "proc/self/cgroup"), `0::/${opts.self ?? `${UNIT}/.control`}\n`);
  const unit = join(root, "sys/fs/cgroup", UNIT);
  mkdirSync(join(unit, ".control"), { recursive: true });
  writeFileSync(join(unit, "cgroup.subtree_control"), `${opts.subtree ?? "cpu memory pids"}\n`);
  return {
    root,
    unit,
    run() {
      const started = performance.now();
      const r = Bun.spawnSync(["sh", SCRIPT, root], { env: { PATH: process.env.PATH! } });
      return {
        code: r.exitCode,
        err: r.stderr.toString(),
        seconds: (performance.now() - started) / 1000,
        subtree: readFileSync(join(unit, "cgroup.subtree_control"), "utf8"),
      };
    },
  };
}

/** A sub-cgroup with a cgroup.events file (so it stays: a fake directory with a file in it). */
function child(unit: string, name: string, populated: 0 | 1) {
  mkdirSync(join(unit, name), { recursive: true });
  writeFileSync(join(unit, name, "cgroup.events"), `populated ${populated}\nfrozen 0\n`);
}

describe("cgroup-reset.sh", () => {
  test("disables every controller Podman enabled for the unit's children", () => {
    const t = tree();
    child(t.unit, "runtime", 0);
    const r = t.run();
    expect(r.code).toBe(0);
    expect(r.subtree).toBe("-cpu -memory -pids\n");
  });

  test("removes empty sub-cgroups deepest first, and keeps .control (it runs from there)", () => {
    const t = tree();
    mkdirSync(join(t.unit, "runtime"));
    mkdirSync(join(t.unit, "libpod-payload-abc/nested"), { recursive: true });
    expect(t.run().code).toBe(0);
    expect(existsSync(join(t.unit, "runtime"))).toBe(false);
    expect(existsSync(join(t.unit, "libpod-payload-abc"))).toBe(false);
    expect(existsSync(join(t.unit, ".control"))).toBe(true);
  });

  test("waits for a sub-cgroup that is still emptying (conmon's clean-up on its way out)", () => {
    const t = tree();
    child(t.unit, "runtime", 1);
    // Empties after about half a second.
    Bun.spawn(["sh", "-c", `sleep 0.5; printf 'populated 0\\n' > '${join(t.unit, "runtime/cgroup.events")}'`]);
    const r = t.run();
    expect(r.code).toBe(0);
    expect(r.seconds).toBeGreaterThanOrEqual(0.4);
    expect(r.seconds).toBeLessThan(5);
    expect(r.subtree).toBe("-cpu -memory -pids\n");
  });

  test("gives up after about 10 s and leaves a still-running container's cgroup alone", () => {
    const t = tree();
    child(t.unit, "libpod-payload-abc", 1);
    const r = t.run();
    expect(r.code).toBe(0);
    expect(r.err).toContain("libpod-payload-abc is still busy after 10 s");
    expect(r.subtree).toBe("cpu memory pids\n");
    expect(r.seconds).toBeGreaterThanOrEqual(9);
    expect(r.seconds).toBeLessThan(20);
  }, 30_000);

  test("leaves a unit with nothing enabled alone", () => {
    const t = tree({ subtree: "" });
    const r = t.run();
    expect(r.code).toBe(0);
    expect(r.subtree).toBe("\n");
  });

  test("does nothing outside a .control cgroup (not a delegated unit's ExecStopPost=)", () => {
    const t = tree({ self: UNIT });
    const r = t.run();
    expect(r.code).toBe(0);
    expect(r.err).toContain("not in a user service's .control cgroup");
    expect(r.subtree).toBe("cpu memory pids\n");
  });

  test.each([
    ["the root's", ".control"],
    ["a slice's", "user.slice/.control"],
    ["a system unit's", "system.slice/foo.service/.control"],
  ])("does nothing from %s .control (only a user manager's service)", (_, self) => {
    const t = tree({ self });
    mkdirSync(join(t.root, "sys/fs/cgroup", self), { recursive: true });
    writeFileSync(join(t.root, "sys/fs/cgroup", self, "../cgroup.subtree_control"), "cpu memory pids\n");
    const r = Bun.spawnSync(["sh", SCRIPT, t.root], { env: { PATH: process.env.PATH! } });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain("not in a user service's .control cgroup");
    expect(readFileSync(join(t.root, "sys/fs/cgroup", self, "../cgroup.subtree_control"), "utf8")).toBe(
      "cpu memory pids\n",
    );
  });

  test("does nothing when the unit's cgroup is not writable", () => {
    const t = tree();
    chmodSync(join(t.unit, "cgroup.subtree_control"), 0o444);
    const r = t.run();
    expect(r.code).toBe(0);
    expect(r.err).toContain("cannot write");
    expect(r.subtree).toBe("cpu memory pids\n");
  });
});

describe("shellcheck", () => {
  // Skips only on a developer machine with neither; in CI the test runs and fails instead.
  test.skipIf(!shellcheckAvailable && process.env.CI !== "true")(
    "cgroup-reset.sh is clean (POSIX sh)",
    () => {
      const r = shellcheck(SCRIPT);
      expect(r.code, r.out).toBe(0);
    },
    300_000,
  );
});
