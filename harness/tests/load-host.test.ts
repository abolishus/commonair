// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type HostSample,
  HostSampler,
  SNAPSHOT_COMMAND,
  cpuUsage,
  nicRates,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseSnapshot,
  summarizeHost,
} from "../src/load/host.ts";

/** A `cpuN` line: user nice system idle iowait irq softirq steal guest guest_nice. */
const cpuLine = (name: string, t: Partial<Record<"user" | "system" | "idle" | "iowait" | "steal", number>>) =>
  `${name} ${t.user ?? 0} 0 ${t.system ?? 0} ${t.idle ?? 0} ${t.iowait ?? 0} 0 0 ${t.steal ?? 0} 0 0`;

const statText = (...cpus: string[]) =>
  ["cpu  1 2 3 4 5 6 7 8 0 0", ...cpus, "intr 12345 0 0", "ctxt 999", "btime 1700000000", "processes 42"].join("\n");

const NET_DEV_HEADER = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
];
const netLine = (name: string, rx: number, tx: number) =>
  `${name.padStart(6)}: ${rx} 10 0 0 0 0 0 0 ${tx} 20 0 0 0 0 0 0`;
const netDev = (...lines: string[]) => [...NET_DEV_HEADER, ...lines].join("\n");

const MEMINFO = [
  "MemTotal:        8000000 kB",
  "MemFree:         1000000 kB",
  "MemAvailable:    6000000 kB",
  "Buffers:          100000 kB",
  "Cached:          2000000 kB",
  "HugePages_Total:       0",
].join("\n");

function snapshot(o: { cpus: string[]; net: string[]; mem?: string; load?: string }): string {
  return [
    "@@ /proc/stat",
    statText(...o.cpus),
    "@@ /proc/meminfo",
    o.mem ?? MEMINFO,
    "@@ /proc/loadavg",
    o.load ?? "0.52 0.58 0.59 2/987 12345",
    "@@ /proc/net/dev",
    netDev(...o.net),
  ].join("\n");
}

describe("/proc/stat", () => {
  test("parses the aggregate line and every cpuN, skipping other lines", () => {
    const s = parseProcStat(statText(cpuLine("cpu0", { user: 10, idle: 90 }), cpuLine("cpu1", { system: 5 })));
    expect(s.total).toMatchObject({ user: 1, nice: 2, system: 3, idle: 4, iowait: 5, irq: 6, softirq: 7, steal: 8 });
    expect(Object.keys(s.cpus)).toEqual(["cpu0", "cpu1"]);
    expect(s.cpus.cpu0).toMatchObject({ user: 10, idle: 90 });
  });

  test("busy share across all cores; iowait counts as idle, steal is reported apart", () => {
    const a = parseProcStat(statText(cpuLine("cpu0", {}), cpuLine("cpu1", {})));
    const b = parseProcStat(
      statText(
        cpuLine("cpu0", { user: 60, idle: 30, iowait: 10 }),
        cpuLine("cpu1", { system: 20, idle: 70, steal: 10 }),
      ),
    );
    const u = cpuUsage(a, b);
    // 200 jiffies: 80 busy, 110 idle or iowait, 10 stolen.
    expect(u).toEqual({ busyPercent: 40, stealPercent: 5, cpus: 2 });
  });

  test("a CPU going offline leaves the interval with the CPUs online in both reads", () => {
    const a = parseProcStat(statText(cpuLine("cpu0", { user: 100 }), cpuLine("cpu1", { user: 500, idle: 500 })));
    // cpu1 is gone; the aggregate line would drop by its counters and go negative.
    const b = parseProcStat(statText(cpuLine("cpu0", { user: 150, idle: 50 })));
    expect(cpuUsage(a, b)).toEqual({ busyPercent: 50, stealPercent: 0, cpus: 1 });
  });

  test("a CPU coming online is ignored until it has two reads", () => {
    const a = parseProcStat(statText(cpuLine("cpu0", {})));
    const b = parseProcStat(statText(cpuLine("cpu0", { user: 25, idle: 75 }), cpuLine("cpu1", { user: 9_999 })));
    expect(cpuUsage(a, b)).toEqual({ busyPercent: 25, stealPercent: 0, cpus: 1 });
  });

  test("a counter that went backwards (wrap or reset) leaves that CPU out", () => {
    const a = parseProcStat(
      statText(cpuLine("cpu0", { user: 10 }), cpuLine("cpu1", { user: 4_294_967_000, idle: 10 })),
    );
    const b = parseProcStat(
      statText(cpuLine("cpu0", { user: 20, idle: 10 }), cpuLine("cpu1", { user: 200, idle: 20 })),
    );
    expect(cpuUsage(a, b)).toEqual({ busyPercent: 50, stealPercent: 0, cpus: 1 });
  });

  test("nothing comparable is null: every counter wrapped, no time passed, or no CPUs", () => {
    const a = parseProcStat(statText(cpuLine("cpu0", { user: 100 })));
    expect(cpuUsage(a, parseProcStat(statText(cpuLine("cpu0", { user: 5 }))))).toBeNull();
    expect(cpuUsage(a, a)).toBeNull();
    expect(cpuUsage(parseProcStat(""), parseProcStat(""))).toBeNull();
  });
});

describe("/proc/meminfo and /proc/loadavg", () => {
  test("used = total − available, in bytes", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 8_000_000 * 1024,
      availableBytes: 6_000_000 * 1024,
      usedBytes: 2_000_000 * 1024,
    });
  });

  test("without MemAvailable (old kernels): free + buffers + cached", () => {
    const old = MEMINFO.split("\n")
      .filter((l) => !l.startsWith("MemAvailable"))
      .join("\n");
    expect(parseMeminfo(old)?.availableBytes).toBe(3_100_000 * 1024);
  });

  test("no MemTotal is null", () => {
    expect(parseMeminfo("MemFree: 10 kB")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });

  test("load averages and task counts", () => {
    expect(parseLoadavg("0.52 0.58 0.59 2/987 12345\n")).toEqual({
      load1: 0.52,
      load5: 0.58,
      load15: 0.59,
      running: 2,
      tasks: 987,
    });
    expect(parseLoadavg("garbage")).toBeNull();
  });
});

describe("/proc/net/dev", () => {
  test("several interfaces, the header skipped, public and VPC apart", () => {
    const n = parseNetDev(netDev(netLine("lo", 500, 500), netLine("eth0", 1_000, 2_000), netLine("eth1", 30, 40)));
    expect(n).toEqual({
      lo: { rxBytes: 500, txBytes: 500 },
      eth0: { rxBytes: 1_000, txBytes: 2_000 },
      eth1: { rxBytes: 30, txBytes: 40 },
    });
  });

  test("an IPv6-only interface and one with zero traffic are read like any other", () => {
    const n = parseNetDev(netDev(netLine("ip6tnl0", 0, 0), netLine("sit0", 0, 0), netLine("eth0", 7, 9)));
    expect(n.ip6tnl0).toEqual({ rxBytes: 0, txBytes: 0 });
    expect(n.sit0).toEqual({ rxBytes: 0, txBytes: 0 });
    expect(n.eth0).toEqual({ rxBytes: 7, txBytes: 9 });
  });

  test("a counter running into the colon (no space) still parses; short rows are skipped", () => {
    const n = parseNetDev(netDev("  eth0:123456789 1 0 0 0 0 0 0 987654321 1 0 0 0 0 0 0", "  bad: 1 2 3"));
    expect(n).toEqual({ eth0: { rxBytes: 123_456_789, txBytes: 987_654_321 } });
  });

  test("rates per interface; a counter that went backwards or a missing interface is left out", () => {
    const a = {
      eth0: { rxBytes: 0, txBytes: 1_000 },
      eth1: { rxBytes: 500, txBytes: 500 },
      old: { rxBytes: 1, txBytes: 1 },
    };
    const b = {
      eth0: { rxBytes: 5_000, txBytes: 11_000 },
      eth1: { rxBytes: 10, txBytes: 600 },
      fresh: { rxBytes: 9, txBytes: 9 },
    };
    expect(nicRates(a, b, 5)).toEqual({ eth0: { rxBytesPerSecond: 1_000, txBytesPerSecond: 2_000 } });
    expect(nicRates(a, b, 0)).toEqual({});
  });

  test("zero traffic is a zero rate, not a missing one", () => {
    const z = { eth1: { rxBytes: 42, txBytes: 42 } };
    expect(nicRates(z, z, 5)).toEqual({ eth1: { rxBytesPerSecond: 0, txBytesPerSecond: 0 } });
  });
});

describe("snapshots", () => {
  test("the command prints a marker before each file", () => {
    expect(SNAPSHOT_COMMAND).toContain('echo "@@ $f"');
    for (const f of ["/proc/stat", "/proc/meminfo", "/proc/loadavg", "/proc/net/dev"])
      expect(SNAPSHOT_COMMAND).toContain(f);
  });

  test("splits into the four parsed files", () => {
    const s = parseSnapshot(snapshot({ cpus: [cpuLine("cpu0", { user: 1 })], net: [netLine("eth0", 1, 2)] }));
    expect(s?.stat.cpus.cpu0?.user).toBe(1);
    expect(s?.mem?.totalBytes).toBe(8_000_000 * 1024);
    expect(s?.load?.load1).toBe(0.52);
    expect(s?.nic.eth0).toEqual({ rxBytes: 1, txBytes: 2 });
  });

  test("no CPU lines (truncated output, an error message) is null", () => {
    expect(parseSnapshot("")).toBeNull();
    expect(parseSnapshot("ssh: connect to host 10.0.0.5 port 22: Connection refused")).toBeNull();
    expect(parseSnapshot("@@ /proc/stat\n@@ /proc/meminfo\nMemTotal: 1 kB")).toBeNull();
  });
});

describe("summaries", () => {
  const sample = (at: number, busy: number, eth0Tx: number, eth1Tx: number): HostSample => ({
    at,
    seconds: 5,
    cpu: { busyPercent: busy, stealPercent: 0, cpus: 4 },
    mem: { totalBytes: 100, availableBytes: 40, usedBytes: 60 },
    load: { load1: busy / 25, load5: 0, load15: 0, running: 1, tasks: 1 },
    nic: {
      lo: { rxBytesPerSecond: 1e9, txBytesPerSecond: 1e9 },
      podman0: { rxBytesPerSecond: 1e9, txBytesPerSecond: 1e9 },
      eth0: { rxBytesPerSecond: 0, txBytesPerSecond: eth0Tx },
      eth1: { rxBytesPerSecond: 10, txBytesPerSecond: eth1Tx },
    },
  });

  test("mean, p95 and max per measure; loopback and container bridges left out of the NIC total", () => {
    const s = summarizeHost([sample(5_000, 20, 1_000, 100), sample(10_000, 60, 3_000, 300)]);
    expect(s.samples).toBe(2);
    expect(s.incomplete).toBe(false);
    expect(s.cpus).toBe(4);
    expect(s.cpu).toEqual({ mean: 40, p95: 60, max: 60 });
    expect(s.memTotalBytes).toBe(100);
    expect(Object.keys(s.nic)).toEqual(["eth0", "eth1"]);
    expect(s.nic.eth0?.tx).toEqual({ mean: 2_000, p95: 3_000, max: 3_000 });
    expect(s.nic.eth0?.txBytes).toBe(20_000);
    expect(s.nicTotal.tx.mean).toBe(2_200);
    expect(s.nicTotal.txBytes).toBe(22_000);
    expect(s.nicTotal.rxBytes).toBe(100);
  });

  test("no samples: nulls, not zeros; failures mark it incomplete", () => {
    const s = summarizeHost([], 3);
    expect(s).toMatchObject({ samples: 0, failures: 3, incomplete: true, cpus: null, memTotalBytes: null });
    expect(s.cpu).toEqual({ mean: null, p95: null, max: null });
    expect(s.nicTotal.txBytes).toBe(0);
  });
});

describe("HostSampler", () => {
  const snap = (user: number, idle: number, tx: number) =>
    snapshot({ cpus: [cpuLine("cpu0", { user, idle })], net: [netLine("eth0", 0, tx)] });

  test("one interval per pair of good reads, timed by the clock", async () => {
    const reads = [snap(0, 0, 0), snap(50, 50, 5_000), snap(150, 50, 15_000)];
    let now = 0;
    const s = new HostSampler(
      async () => reads.shift() ?? null,
      5_000,
      () => (now += 5_000),
    );
    await s.tick();
    await s.tick();
    await s.tick();
    const sum = s.summary();
    expect(sum.samples).toBe(2);
    expect(sum.cpu.max).toBe(100);
    expect(sum.cpu.mean).toBe(75);
    expect(sum.nic.eth0?.tx.mean).toBe(1_500);
    expect(sum.incomplete).toBe(false);
  });

  test("a read that fails or throws is counted; the next good read measures from the last good one", async () => {
    const reads: (() => Promise<string | null>)[] = [
      async () => snap(0, 0, 0),
      async () => null,
      async () => {
        throw new Error("ssh: Connection reset");
      },
      async () => "not a snapshot",
      async () => snap(40, 60, 20_000),
    ];
    let now = 0;
    const s = new HostSampler(
      () => (reads.shift() as () => Promise<string | null>)(),
      5_000,
      () => (now += 5_000),
    );
    for (let i = 0; i < 5; i++) await s.tick();
    const sum = s.summary();
    expect(sum.failures).toBe(3);
    expect(sum.incomplete).toBe(true);
    expect(sum.samples).toBe(1);
    expect(sum.cpu.mean).toBe(40);
    // The fake clock only ticks on good reads: the two good ones are 5 s apart.
    expect(sum.nic.eth0?.tx.mean).toBe(4_000);
  });

  test("start/stop takes a last read so a short window has an interval", async () => {
    const reads = [snap(0, 0, 0), snap(10, 10, 100)];
    let now = 0;
    const s = new HostSampler(
      async () => reads.shift() ?? null,
      60_000,
      () => (now += 1_000),
    );
    s.start();
    await s.stop();
    expect(s.summary().samples).toBe(1);
    await s.stop();
    expect(s.summary().failures).toBe(0);
  });
});
