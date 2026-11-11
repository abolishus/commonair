// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `infra/containers/entrypoint.sh` and its test-instance CPU profiler switch
 * (`COMMONAIR_CPU_PROFILE`, docs/operators/capacity.md). The script runs for real under `sh`
 * with a stub `bun` first on PATH that prints its argv, and `/app` swapped for a scratch
 * directory (the only line changed). Unset or empty, the command must be exactly today's.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";

const SCRIPT = new URL("../containers/entrypoint.sh", import.meta.url);
const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
const app = join(root, "app");
const bin = join(root, "bin");
mkdirSync(join(app, "apps/web"), { recursive: true });
mkdirSync(bin);
const source = readFileSync(SCRIPT, "utf8");
const script = join(root, "entrypoint.sh");
writeFileSync(script, source.replace(/^cd \/app$/m, `cd '${app}'`));
// Prints where it ran and each argument on its own line.
writeFileSync(join(bin, "bun"), '#!/bin/sh\npwd\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
chmodSync(join(bin, "bun"), 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(env: Record<string, string>, args: string[] = []) {
  const r = Bun.spawnSync(["sh", script, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = r.stdout.toString().trimEnd().split("\n");
  return { code: r.exitCode, cwd: lines[0], argv: lines.slice(1), stderr: r.stderr.toString() };
}

describe("entrypoint.sh", () => {
  test("only `cd /app` is swapped for the test", () => {
    expect(source.match(/^cd \/app$/gm)).toHaveLength(1);
  });

  test("a service starts exactly as before with the switch unset or empty", () => {
    const expected = ["services/api/src/main.ts", "--flag", "two words"];
    const unset = run({ SERVICE: "api" }, ["--flag", "two words"]);
    expect(unset).toMatchObject({ code: 0, cwd: app, argv: expected, stderr: "" });
    const empty = run({ SERVICE: "api", COMMONAIR_CPU_PROFILE: "" }, ["--flag", "two words"]);
    expect(empty).toMatchObject({ code: 0, cwd: app, argv: expected, stderr: "" });
  });

  test("web and tools ignore the switch", () => {
    const dir = mkdtempSync(join(root, "prof-"));
    expect(run({ SERVICE: "web", COMMONAIR_CPU_PROFILE: dir })).toMatchObject({
      code: 0,
      cwd: join(app, "apps/web"),
      argv: ["run", "start"],
    });
    expect(run({ SERVICE: "tools", COMMONAIR_CPU_PROFILE: dir }, ["bun", "x.ts"])).toMatchObject({
      code: 0,
      argv: ["x.ts"],
    });
  });

  test("with a writable directory the service runs under Bun's CPU profiler", () => {
    const dir = mkdtempSync(join(root, "prof-"));
    const r = run({ SERVICE: "media", COMMONAIR_CPU_PROFILE: dir }, ["--x"]);
    expect(r.code).toBe(0);
    expect(r.argv).toEqual([
      "--cpu-prof",
      "--cpu-prof-md",
      `--cpu-prof-dir=${dir}`,
      "services/media/src/main.ts",
      "--x",
    ]);
    expect(r.stderr).toContain("CPU profiler on for media");
  });

  test("a directory that does not exist refuses to start, loudly", () => {
    const r = run({ SERVICE: "api", COMMONAIR_CPU_PROFILE: join(root, "missing") });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("is not a writable directory");
  });

  test("SERVICE is required", () => {
    expect(run({}).code).not.toBe(0);
  });
});
