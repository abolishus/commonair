// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The CLI as a process: exit codes and reports. Points at dead ports, so no stack is needed. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vite-plus/test";
import type { RunReport } from "../src/report.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "harness-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const deadStack = {
  HARNESS_API_URL: "http://127.0.0.1:9",
  HARNESS_MAILPIT_URL: "http://127.0.0.1:9",
  HARNESS_REPORT_DIR: dir,
  LOG_LEVEL: "fatal",
};

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("harness CLI", () => {
  test("list shows every scenario and full", async () => {
    const { stdout, code } = await cli(["list"]);
    expect(code).toBe(0);
    for (const n of ["full", "smoke", "ingest-rtmp", "ingest-whip", "viewers", "load-smoke"])
      expect(stdout).toContain(n);
    const json = await cli(["list", "--json"]);
    const parsed = JSON.parse(json.stdout) as { name: string; needs: string[] }[];
    expect(parsed.find((s) => s.name === "smoke")?.needs).toEqual(["api", "mail"]);
  }, 30_000);

  test("usage errors exit 2", async () => {
    const { code, stderr } = await cli(["run"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Usage:");
    expect((await cli(["run", "no-such-scenario"], deadStack)).code).toBe(1);
  }, 30_000);

  test("a scenario whose needs are unreachable fails with a report and exit 1", async () => {
    const reportPath = join(dir, "smoke.json");
    const { code, stdout } = await cli(["run", "smoke", "--report", reportPath], deadStack);
    expect(code).toBe(1);
    expect(stdout).toContain("FAIL  smoke");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as RunReport;
    expect(report.ok).toBe(false);
    expect(report.scenarios[0]?.status).toBe("failed");
    expect(report.scenarios[0]?.error).toMatch(/api: API unreachable/);
    expect(readFileSync(join(dir, "smoke.txt"), "utf8")).toContain("FAIL  smoke");
  }, 30_000);

  test("--skip-unavailable turns unmet needs into skips (exit 0)", async () => {
    const { code, stdout } = await cli(["run", "smoke", "--skip-unavailable"], deadStack);
    expect(code).toBe(0);
    expect(stdout).toContain("SKIP  smoke");
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as RunReport;
    expect(latest.summary).toEqual({ passed: 0, failed: 0, skipped: 1 });
  }, 30_000);
});
