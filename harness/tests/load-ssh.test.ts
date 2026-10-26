// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { HostSampler } from "../src/load/host.ts";
import {
  type CommandRunner,
  REMOTE_PODMAN_STATS,
  remotePodmanStats,
  remoteSnapshot,
  shellQuote,
  sshArgv,
} from "../src/load/ssh.ts";
import { CpuSampler } from "../src/metrics.ts";

const PODMAN_JSON = JSON.stringify([
  { name: "commonair-postgres", cpu_percent: "35.5%", mem_usage: "512MB / 8GB" },
  { name: "commonair-origin", cpu_percent: "120.25%", mem_usage: "100MB / 8GB" },
  { name: "someone-else", cpu_percent: "99%", mem_usage: "1MB / 8GB" },
]);

const SNAP = (user: number) =>
  [
    "@@ /proc/stat",
    `cpu  ${user} 0 0 0 0 0 0 0 0 0`,
    `cpu0 ${user} 0 0 0 0 0 0 0 0 0`,
    "@@ /proc/meminfo",
    "MemTotal: 1000 kB",
    "MemAvailable: 500 kB",
    "@@ /proc/loadavg",
    "1.00 1.00 1.00 1/100 1",
    "@@ /proc/net/dev",
    "eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
  ].join("\n");

/** A runner that records calls and answers from a script of results (or throws). */
function scripted(results: (CommandResultOrError | ((cmd: string) => CommandResultOrError))[]) {
  const calls: { dest: string; command: string }[] = [];
  const run: CommandRunner = async (dest, command) => {
    calls.push({ dest, command });
    const next = results.shift();
    const r = typeof next === "function" ? next(command) : next;
    if (!r) throw new Error("script exhausted");
    if (r instanceof Error) throw r;
    return r;
  };
  return { run, calls };
}
type CommandResultOrError = { code: number; stdout: string } | Error;

describe("ssh argv and quoting", () => {
  test("batch mode, one control connection per destination, the command last", () => {
    const argv = sshArgv("commonair@10.110.0.5", "podman ps");
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("ControlMaster=auto");
    expect(argv.find((a) => a.startsWith("ControlPath="))).toMatch(/%C$/);
    expect(argv.slice(-2)).toEqual(["commonair@10.110.0.5", "podman ps"]);
  });

  test("single quotes survive", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("")).toBe("''");
  });
});

describe("remote podman stats", () => {
  test("runs podman stats on the target and keeps the instance's containers", async () => {
    const { run, calls } = scripted([{ code: 0, stdout: PODMAN_JSON }]);
    const rows = await remotePodmanStats(run, "commonair@target")("commonair");
    expect(calls).toEqual([{ dest: "commonair@target", command: REMOTE_PODMAN_STATS }]);
    expect(rows?.map((r) => [r.name, r.cpuPercent])).toEqual([
      ["commonair-postgres", 35.5],
      ["commonair-origin", 120.25],
    ]);
  });

  test("a non-zero exit, a throw or unparseable output is null, never a throw", async () => {
    const { run } = scripted([{ code: 255, stdout: "" }, new Error("spawn ssh ENOENT"), { code: 0, stdout: "{oops" }]);
    const sample = remotePodmanStats(run, "t");
    expect(await sample("commonair")).toBeNull();
    expect(await sample("commonair")).toBeNull();
    expect(await sample("commonair")).toBeNull();
  });

  test("CpuSampler over SSH: a runner failing halfway keeps the earlier samples and marks it unavailable", async () => {
    const { run } = scripted([{ code: 0, stdout: PODMAN_JSON }, { code: 0, stdout: PODMAN_JSON }, new Error("reset")]);
    const sampler = new CpuSampler("commonair", 10, remotePodmanStats(run, "t"));
    sampler.start();
    await Bun.sleep(80);
    await sampler.stop();
    const s = sampler.summary();
    expect(s["commonair-postgres"]?.samples).toBe(2);
    expect(s["commonair-origin"]?.meanCpuPercent).toBe(120.25);
    expect(sampler.available).toBe(false);
  });
});

describe("remote /proc snapshot", () => {
  test("runs the snapshot command through sh on the destination", async () => {
    const { run, calls } = scripted([{ code: 0, stdout: SNAP(10) }]);
    expect(await remoteSnapshot(run, "root@10.110.0.9")()).toBe(SNAP(10));
    expect(calls[0]?.dest).toBe("root@10.110.0.9");
    expect(calls[0]?.command).toMatch(/^sh -c '.*\/proc\/net\/dev/s);
  });

  test("HostSampler over SSH: a runner failing halfway marks the summary incomplete, no throw", async () => {
    const { run } = scripted([
      { code: 0, stdout: SNAP(0) },
      { code: 0, stdout: SNAP(50) },
      { code: 255, stdout: "" },
      new Error("Connection timed out"),
    ]);
    let now = 0;
    const s = new HostSampler(remoteSnapshot(run, "t"), 5_000, () => (now += 5_000));
    for (let i = 0; i < 4; i++) await s.tick();
    const sum = s.summary();
    expect(sum.samples).toBe(1);
    expect(sum.failures).toBe(2);
    expect(sum.incomplete).toBe(true);
    expect(sum.cpu.mean).toBe(100);
  });
});
