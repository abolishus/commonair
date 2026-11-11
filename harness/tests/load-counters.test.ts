// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Container counters for `load-cost`: the `podman stats` and cgroup parsers, the remote reader's
 * resolve-then-read and its fallback, and the sampler's deltas (restarts, missing containers,
 * failed reads). No real podman or SSH: the runner is a fake.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  ContainerCounterSampler,
  type CounterRead,
  RESOLVE_CONTAINERS_COMMAND,
  cgroupSampleCommand,
  parseCgroupSample,
  parseContainerHandles,
  parseGoDurationUsec,
  parseHumanBytes,
  parsePodmanCounters,
  remoteCounterReader,
  summarizeCounters,
} from "../src/load/counters.ts";
import type { CommandRunner } from "../src/load/ssh.ts";

const NET_DEV = (rx: number, tx: number) =>
  [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0",
    `  eth0: ${rx} 1 0 0 0 0 0 0 ${tx} 1 0 0 0 0 0 0`,
  ].join("\n");

describe("parsers", () => {
  test("Go durations", () => {
    expect(parseGoDurationUsec("0s")).toBe(0);
    expect(parseGoDurationUsec("0")).toBe(0);
    expect(parseGoDurationUsec("37.71ms")).toBeCloseTo(37_710);
    expect(parseGoDurationUsec("1h2m3.5s")).toBe(3_723_500_000);
    expect(parseGoDurationUsec("850µs")).toBe(850);
    expect(parseGoDurationUsec("120ns")).toBeCloseTo(0.12);
    expect(parseGoDurationUsec("2m")).toBe(120e6);
    expect(parseGoDurationUsec("")).toBeNull();
    expect(parseGoDurationUsec("12 seconds")).toBeNull();
    expect(parseGoDurationUsec("1x")).toBeNull();
  });

  test("human sizes, decimal and binary", () => {
    expect(parseHumanBytes("796B")).toBe(796);
    expect(parseHumanBytes(" 1.236kB ")).toBe(1236);
    expect(parseHumanBytes("12.3GB")).toBeCloseTo(12.3e9);
    expect(parseHumanBytes("2MiB")).toBe(2 * 1024 ** 2);
    expect(parseHumanBytes("5")).toBe(5);
    expect(parseHumanBytes("lots")).toBeNull();
  });

  test("podman stats JSON: cpu_time and net_io (rx / tx) by prefix", () => {
    const json = JSON.stringify([
      { name: "commonair-api", cpu_time: "1m0s", cpu_percent: "3.0%", net_io: "1.5MB / 2kB" },
      { name: "commonair-worker", CPUNano: 2_000_000, NetIO: "0B / 0B" },
      { name: "other", cpu_time: "1s" },
      { name: "commonair-odd", cpu_time: "?", net_io: "x" },
    ]);
    expect(parsePodmanCounters(json, "commonair")).toEqual({
      "commonair-api": { cpuUsec: 60e6, rxBytes: 1.5e6, txBytes: 2000 },
      "commonair-worker": { cpuUsec: 2000, rxBytes: 0, txBytes: 0 },
      "commonair-odd": { cpuUsec: null, rxBytes: null, txBytes: null },
    });
    expect(parsePodmanCounters("{}", "commonair")).toEqual({});
    expect(() => parsePodmanCounters("not json", "commonair")).toThrow(SyntaxError);
  });

  test("container handles: prefix, running only, crun's `container` child read at the parent", () => {
    const text = [
      "commonair-api 4242 /user.slice/app.slice/commonair-api.service/libpod-payload-abc",
      "commonair-media 5151 /user.slice/libpod-def.scope/container",
      "commonair-stopped 0 ",
      "commonair-nocg 77 ",
      "unrelated 1 /x",
      "",
    ].join("\n");
    expect(parseContainerHandles(text, "commonair")).toEqual([
      { name: "commonair-api", pid: 4242, cgroup: "/user.slice/app.slice/commonair-api.service/libpod-payload-abc" },
      { name: "commonair-media", pid: 5151, cgroup: "/user.slice/libpod-def.scope" },
      { name: "commonair-nocg", pid: 77, cgroup: null },
    ]);
  });

  test("the cgroup sample command reads cpu.stat and net/dev, quoted", () => {
    const cmd = cgroupSampleCommand([
      { name: "commonair-api", pid: 42, cgroup: "/a b/c" },
      { name: "commonair-x", pid: 7, cgroup: null },
    ]);
    expect(cmd).toBe(
      "echo '@@ commonair-api'; cat '/sys/fs/cgroup/a b/c/cpu.stat' 2>/dev/null; cat /proc/42/net/dev 2>/dev/null; " +
        "echo '@@ commonair-x'; cat /proc/7/net/dev 2>/dev/null",
    );
  });

  test("a cgroup sample: usage_usec, and net bytes without loopback", () => {
    const text = [
      "@@ commonair-api",
      "usage_usec 1500000",
      "user_usec 1000000",
      NET_DEV(100, 200),
      "@@ commonair-gone",
      "@@ commonair-cpuonly",
      "usage_usec 5",
    ].join("\n");
    expect(parseCgroupSample(text)).toEqual({
      "commonair-api": { cpuUsec: 1_500_000, rxBytes: 100, txBytes: 200 },
      "commonair-gone": { cpuUsec: null, rxBytes: null, txBytes: null },
      "commonair-cpuonly": { cpuUsec: 5, rxBytes: null, txBytes: null },
    });
  });
});

describe("remoteCounterReader", () => {
  test("resolves once, then reads cgroups over the runner", async () => {
    const commands: string[] = [];
    let reads = 0;
    const run: CommandRunner = async (_dest, command) => {
      commands.push(command);
      if (command.includes("podman ps")) return { code: 0, stdout: "commonair-api 42 /cg/api\n" };
      reads++;
      return { code: 0, stdout: `@@ commonair-api\nusage_usec ${reads * 1000}\n${NET_DEV(reads, reads)}` };
    };
    const r = await remoteCounterReader(run, "ops@t", "commonair");
    expect(r.source).toBe("cgroup");
    expect(r.containers).toEqual(["commonair-api"]);
    expect(await r.read()).toEqual({ "commonair-api": { cpuUsec: 1000, rxBytes: 1, txBytes: 1 } });
    expect(await r.read()).toEqual({ "commonair-api": { cpuUsec: 2000, rxBytes: 2, txBytes: 2 } });
    expect(commands.filter((c) => c.includes("podman ps"))).toHaveLength(1);
    expect(commands[0]).toContain(RESOLVE_CONTAINERS_COMMAND.slice(0, 20));
  });

  test("falls back to podman stats when no cgroup resolves; a failing read is null", async () => {
    let fail = false;
    const run: CommandRunner = async (_dest, command) => {
      if (command.includes("podman ps")) return { code: 0, stdout: "commonair-api 42 \n" };
      if (fail) return { code: 125, stdout: "" };
      return { code: 0, stdout: JSON.stringify([{ name: "commonair-api", cpu_time: "2s", net_io: "1kB / 2kB" }]) };
    };
    const r = await remoteCounterReader(run, "ops@t", "commonair");
    expect(r.source).toBe("podman");
    expect(await r.read()).toEqual({ "commonair-api": { cpuUsec: 2e6, rxBytes: 1000, txBytes: 2000 } });
    fail = true;
    expect(await r.read()).toBeNull();
  });

  test("an unreachable target falls back too (and reads nothing)", async () => {
    const run: CommandRunner = async () => {
      throw new Error("ssh: no route");
    };
    const r = await remoteCounterReader(run, "ops@t", "commonair");
    expect(r.source).toBe("podman");
    expect(await r.read()).toBeNull();
  });
});

describe("ContainerCounterSampler", () => {
  /** A sampler over scripted reads with a clock that moves 5 s per read. */
  function sampler(reads: (CounterRead | null | "throw")[]) {
    let i = 0;
    let t = 0;
    return new ContainerCounterSampler(
      async () => {
        const r = reads[i++] ?? null;
        if (r === "throw") throw new Error("boom");
        return r;
      },
      5_000,
      () => (t += 5_000),
    );
  }
  const c = (cpuSeconds: number, rx = 0, tx = 0) => ({ cpuUsec: cpuSeconds * 1e6, rxBytes: rx, txBytes: tx });

  test("cores are CPU seconds per wall second; rates per second; p50/p95 per interval", async () => {
    const s = sampler([{ a: c(0) }, { a: c(5, 500, 50) }, { a: c(15, 1000, 100) }]);
    for (let k = 0; k < 3; k++) await s.tick();
    const u = s.summary().containers.a;
    // 15 CPU-seconds over 10 s; intervals of 1 and 2 cores.
    expect(u?.cores).toBe(1.5);
    expect(u?.coresP50).toBe(1);
    expect(u?.coresP95).toBe(2);
    expect(u?.rxBytesPerSecond).toBe(100);
    expect(u?.txBytesPerSecond).toBe(10);
    expect(u?.intervals).toBe(2);
    expect(s.summary().incomplete).toBe(false);
  });

  test("a restart (counters backwards) is left out and counted; a failed read is counted", async () => {
    const s = sampler([{ a: c(10) }, "throw", { a: c(20) }, { a: c(1) }, { a: c(6) }]);
    for (let k = 0; k < 5; k++) await s.tick();
    const sum = s.summary();
    expect(sum.failures).toBe(1);
    expect(sum.incomplete).toBe(true);
    expect(sum.containers.a?.restarts).toBe(1);
    // The failed read is skipped: 10→20, then 1→6 (the restart in between is left out).
    expect(sum.containers.a?.intervals).toBe(2);
    expect(sum.containers.a?.cores).toBeCloseTo(15 / 10);
  });

  test("a container missing from a read is counted and measured across the gap", async () => {
    const s = sampler([{ a: c(0), b: c(0) }, { a: c(5) }, { a: c(10), b: c(30) }]);
    for (let k = 0; k < 3; k++) await s.tick();
    const sum = s.summary();
    expect(sum.containers.b?.missing).toBe(1);
    expect(sum.containers.b?.cores).toBe(3);
    expect(sum.containers.a?.missing).toBe(0);
  });

  test("a null counter stays null (no CPU), the others still count", async () => {
    const s = sampler([
      { a: { cpuUsec: null, rxBytes: 0, txBytes: 0 } },
      { a: { cpuUsec: null, rxBytes: 50, txBytes: 0 } },
    ]);
    await s.tick();
    await s.tick();
    expect(s.summary().containers.a).toMatchObject({ cores: null, coresP95: null, rxBytesPerSecond: 10 });
  });

  test("start/stop takes a last read; one read alone measures nothing", async () => {
    const one = sampler([{ a: c(1) }]);
    await one.tick();
    expect(one.summary().containers).toEqual({});
    const s = new ContainerCounterSampler(async () => ({ a: c(Date.now() / 1000) }), 10_000);
    s.start();
    await Bun.sleep(30);
    await s.stop();
    expect(s.summary().reads).toBe(2);
    expect(s.summary().containers.a?.intervals).toBe(1);
  });

  test("summarizeCounters with nothing", () => {
    expect(summarizeCounters({}, {}, {}, 0, 0)).toEqual({ reads: 0, failures: 0, incomplete: false, containers: {} });
  });
});
