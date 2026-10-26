// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whole-host measurements for the load test: CPU busy across all cores, memory, load average and
 * per-interface NIC bytes, read from `/proc` on the target (over SSH) or on the generator itself.
 * One read is a "snapshot" of four files; rates come from the delta between two snapshots. The
 * parsers are pure; the only side effect is the injected `read`.
 */
import { readFile } from "node:fs/promises";
import { summarize } from "../metrics.ts";

/** Jiffies of one CPU line of `/proc/stat` (the aggregate `cpu` line or one `cpuN`). */
export interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

/** `/proc/stat`: the aggregate line and every online CPU by name (`cpu0`, `cpu1`, …). */
export interface ProcStat {
  total: CpuTimes | null;
  cpus: Record<string, CpuTimes>;
}

const CPU_FIELDS = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"] as const;

export function parseProcStat(text: string): ProcStat {
  const out: ProcStat = { total: null, cpus: {} };
  for (const line of text.split("\n")) {
    const m = /^(cpu\d*)\s+(.*)$/.exec(line.trim());
    if (!m?.[1] || m[2] === undefined) continue;
    const nums = m[2].trim().split(/\s+/).map(Number);
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) continue;
    // Older kernels print fewer columns; a missing one counts as zero.
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = nums;
    const times: CpuTimes = { user, nice, system, idle, iowait, irq, softirq, steal };
    if (m[1] === "cpu") out.total = times;
    else out.cpus[m[1]] = times;
  }
  return out;
}

/** Guest time is already inside user/nice, so the total is the eight fields above. */
const cpuTotal = (t: CpuTimes) => CPU_FIELDS.reduce((s, f) => s + t[f], 0);

export interface CpuUsage {
  /** Time not idle, not waiting on I/O and not stolen, as a share of all cores (0–100). */
  busyPercent: number;
  /** Time the hypervisor took (should stay near 0 on dedicated vCPUs). */
  stealPercent: number;
  /** CPUs counted in this interval. */
  cpus: number;
}

/**
 * CPU use between two `/proc/stat` reads, summed per CPU over the CPUs online in both. Summing per
 * CPU (not the aggregate line) keeps a CPU going offline from producing a negative delta; a CPU
 * whose counters went backwards (wrap or reset) is left out of the interval. Null when nothing
 * comparable remains.
 */
export function cpuUsage(prev: ProcStat, next: ProcStat): CpuUsage | null {
  let total = 0;
  let idle = 0;
  let steal = 0;
  let cpus = 0;
  for (const [name, b] of Object.entries(next.cpus)) {
    const a = prev.cpus[name];
    if (!a) continue;
    const deltas = CPU_FIELDS.map((f) => b[f] - a[f]);
    if (deltas.some((d) => d < 0)) continue;
    const t = cpuTotal(b) - cpuTotal(a);
    if (t <= 0) continue;
    total += t;
    idle += b.idle - a.idle + (b.iowait - a.iowait);
    steal += b.steal - a.steal;
    cpus++;
  }
  if (total <= 0) return null;
  return {
    busyPercent: (100 * (total - idle - steal)) / total,
    stealPercent: (100 * steal) / total,
    cpus,
  };
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
}

/** `/proc/meminfo` (values in kB). Used = total − available. Null without MemTotal. */
export function parseMeminfo(text: string): MemInfo | null {
  const kv = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (m?.[1] && m[2]) kv.set(m[1], Number(m[2]) * (line.includes("kB") ? 1024 : 1));
  }
  const total = kv.get("MemTotal");
  if (total === undefined) return null;
  // Kernels before 3.14 have no MemAvailable; free + buffers + cached is the old estimate.
  const available =
    kv.get("MemAvailable") ?? (kv.get("MemFree") ?? 0) + (kv.get("Buffers") ?? 0) + (kv.get("Cached") ?? 0);
  return { totalBytes: total, availableBytes: available, usedBytes: Math.max(0, total - available) };
}

export interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
  running: number;
  tasks: number;
}

/** `/proc/loadavg`: `0.52 0.58 0.59 2/987 12345`. */
export function parseLoadavg(text: string): LoadAvg | null {
  const m = /^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\/(\d+)/.exec(text);
  if (!m) return null;
  return {
    load1: Number(m[1]),
    load5: Number(m[2]),
    load15: Number(m[3]),
    running: Number(m[4]),
    tasks: Number(m[5]),
  };
}

export interface NicCounters {
  rxBytes: number;
  txBytes: number;
}

/**
 * `/proc/net/dev`: receive and transmit bytes per interface (public and VPC traffic are separate
 * interfaces on a droplet). The two header lines and malformed rows are skipped.
 */
export function parseNetDev(text: string): Record<string, NicCounters> {
  const out: Record<string, NicCounters> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    // 8 receive fields, then 8 transmit fields; bytes are the first of each.
    if (!name || fields.length < 16 || fields.some((n) => !Number.isFinite(n))) continue;
    out[name] = { rxBytes: fields[0] ?? 0, txBytes: fields[8] ?? 0 };
  }
  return out;
}

export interface NicRate {
  rxBytesPerSecond: number;
  txBytesPerSecond: number;
}

/**
 * Bytes per second per interface between two reads. An interface missing from either read, or
 * whose counters went backwards (wrap, reset, re-created), is left out of the interval.
 */
export function nicRates(
  prev: Record<string, NicCounters>,
  next: Record<string, NicCounters>,
  seconds: number,
): Record<string, NicRate> {
  const out: Record<string, NicRate> = {};
  if (!(seconds > 0)) return out;
  for (const [name, b] of Object.entries(next)) {
    const a = prev[name];
    if (!a) continue;
    const rx = b.rxBytes - a.rxBytes;
    const tx = b.txBytes - a.txBytes;
    if (rx < 0 || tx < 0) continue;
    out[name] = { rxBytesPerSecond: rx / seconds, txBytesPerSecond: tx / seconds };
  }
  return out;
}

/** The shell command that prints one snapshot; each file follows a `@@ <path>` marker line. */
export const SNAPSHOT_FILES = ["/proc/stat", "/proc/meminfo", "/proc/loadavg", "/proc/net/dev"] as const;
export const SNAPSHOT_COMMAND = `for f in ${SNAPSHOT_FILES.join(" ")}; do echo "@@ $f"; cat "$f"; done`;

export interface HostSnapshot {
  stat: ProcStat;
  mem: MemInfo | null;
  load: LoadAvg | null;
  nic: Record<string, NicCounters>;
}

/** Split the snapshot command's output by marker. Null when `/proc/stat` is missing or empty. */
export function parseSnapshot(text: string): HostSnapshot | null {
  const parts = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) parts.set(current, buf.join("\n"));
  };
  for (const line of text.split("\n")) {
    const m = /^@@ (\S+)$/.exec(line);
    if (m?.[1]) {
      flush();
      current = m[1];
      buf = [];
    } else buf.push(line);
  }
  flush();
  const stat = parseProcStat(parts.get("/proc/stat") ?? "");
  if (Object.keys(stat.cpus).length === 0) return null;
  return {
    stat,
    mem: parseMeminfo(parts.get("/proc/meminfo") ?? ""),
    load: parseLoadavg(parts.get("/proc/loadavg") ?? ""),
    nic: parseNetDev(parts.get("/proc/net/dev") ?? ""),
  };
}

/** One interval between two snapshots. */
export interface HostSample {
  at: number;
  seconds: number;
  cpu: CpuUsage | null;
  mem: MemInfo | null;
  load: LoadAvg | null;
  nic: Record<string, NicRate>;
}

/** Interfaces that never carry the instance's traffic. */
export const IGNORED_INTERFACES = /^(lo|podman\d*|veth|cni|docker|br-|virbr)/;

export interface RateSummary {
  mean: number | null;
  p95: number | null;
  max: number | null;
}

export interface HostSummary {
  /** Intervals measured (one fewer than successful reads). */
  samples: number;
  /** Reads that failed (SSH down, file missing). Any failure makes the summary incomplete. */
  failures: number;
  incomplete: boolean;
  cpus: number | null;
  cpu: RateSummary;
  steal: RateSummary;
  memUsedBytes: RateSummary;
  memTotalBytes: number | null;
  load1: RateSummary;
  /** Per interface, without loopback and container bridges. */
  nic: Record<string, { tx: RateSummary; rx: RateSummary; txBytes: number; rxBytes: number }>;
  /** Sum over those interfaces. */
  nicTotal: { tx: RateSummary; rx: RateSummary; txBytes: number; rxBytes: number };
}

const rate = (values: readonly number[]): RateSummary => {
  const s = summarize(values);
  return { mean: s.mean, p95: s.p95, max: s.max };
};

/** Summarize a run's intervals. Pure. */
export function summarizeHost(samples: readonly HostSample[], failures = 0): HostSummary {
  const nicNames = new Set<string>();
  for (const s of samples) for (const n of Object.keys(s.nic)) if (!IGNORED_INTERFACES.test(n)) nicNames.add(n);
  const nic: HostSummary["nic"] = {};
  for (const name of [...nicNames].sort()) {
    const rows = samples.flatMap((s) => (s.nic[name] ? [{ r: s.nic[name], sec: s.seconds }] : []));
    nic[name] = {
      tx: rate(rows.map((x) => x.r.txBytesPerSecond)),
      rx: rate(rows.map((x) => x.r.rxBytesPerSecond)),
      txBytes: Math.round(rows.reduce((t, x) => t + x.r.txBytesPerSecond * x.sec, 0)),
      rxBytes: Math.round(rows.reduce((t, x) => t + x.r.rxBytesPerSecond * x.sec, 0)),
    };
  }
  const sumOver = (s: HostSample, k: keyof NicRate) => [...nicNames].reduce((t, n) => t + (s.nic[n]?.[k] ?? 0), 0);
  const nicTotal = {
    tx: rate(samples.map((s) => sumOver(s, "txBytesPerSecond"))),
    rx: rate(samples.map((s) => sumOver(s, "rxBytesPerSecond"))),
    txBytes: Object.values(nic).reduce((t, n) => t + n.txBytes, 0),
    rxBytes: Object.values(nic).reduce((t, n) => t + n.rxBytes, 0),
  };
  const last = <T>(pick: (s: HostSample) => T | null | undefined): T | null => {
    for (let i = samples.length - 1; i >= 0; i--) {
      const v = pick(samples[i] as HostSample);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  return {
    samples: samples.length,
    failures,
    incomplete: failures > 0,
    cpus: last((s) => s.cpu?.cpus),
    cpu: rate(samples.flatMap((s) => (s.cpu ? [s.cpu.busyPercent] : []))),
    steal: rate(samples.flatMap((s) => (s.cpu ? [s.cpu.stealPercent] : []))),
    memUsedBytes: rate(samples.flatMap((s) => (s.mem ? [s.mem.usedBytes] : []))),
    memTotalBytes: last((s) => s.mem?.totalBytes),
    load1: rate(samples.flatMap((s) => (s.load ? [s.load.load1] : []))),
    nic,
    nicTotal,
  };
}

/** Reads one snapshot's text; null (or a throw) is a failed read. */
export type SnapshotReader = () => Promise<string | null>;

/** Read the snapshot files on this machine (the generator). Null where `/proc` does not exist. */
export const localSnapshot: SnapshotReader = async () => {
  try {
    const parts = await Promise.all(SNAPSHOT_FILES.map(async (f) => `@@ ${f}\n${await readFile(f, "utf8")}`));
    return parts.join("\n");
  } catch {
    return null;
  }
};

/**
 * Samples a host every `intervalMs` (5 s, like `CpuSampler`). A failed read never throws: it is
 * counted, the summary is marked incomplete, and the next good read measures against the last
 * good one, so the interval average still holds.
 */
export class HostSampler {
  private samples: HostSample[] = [];
  private prev: { at: number; snap: HostSnapshot } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  failures = 0;

  constructor(
    private readonly read: SnapshotReader,
    private readonly intervalMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** One read; exposed for tests (the timer calls it). */
  async tick(): Promise<void> {
    let text: string | null;
    try {
      text = await this.read();
    } catch {
      text = null;
    }
    const snap = text === null ? null : parseSnapshot(text);
    if (!snap) {
      this.failures++;
      return;
    }
    const at = this.now();
    const prev = this.prev;
    this.prev = { at, snap };
    if (!prev) return;
    const seconds = (at - prev.at) / 1000;
    if (!(seconds > 0)) return;
    this.samples.push({
      at,
      seconds,
      cpu: cpuUsage(prev.snap.stat, snap.stat),
      mem: snap.mem,
      load: snap.load,
      nic: nicRates(prev.snap.nic, snap.nic, seconds),
    });
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      if (this.inflight) return;
      this.inflight = this.tick().finally(() => {
        this.inflight = null;
      });
    };
    run();
    this.timer = setInterval(run, this.intervalMs);
  }

  /** Stop and take one last read, so a short window still has an interval. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const wasRunning = this.timer !== null;
    this.timer = null;
    await this.inflight;
    if (wasRunning) await this.tick();
  }

  summary(): HostSummary {
    return summarizeHost(this.samples, this.failures);
  }
}
