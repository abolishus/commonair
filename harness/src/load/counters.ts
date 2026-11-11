// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-container CPU time and network bytes as cumulative counters, for `load-cost`. Cores come
 * from the delta of CPU time between two reads, never from a percentage: a one-shot `podman stats
 * --no-stream` has no previous sample to compare with, and Podman then measures against the
 * container's start, so its `cpu_percent` can be a lifetime average rather than the window's
 * (it equals `avg_cpu` in that output). The counter delta is right either way.
 *
 * Two readers produce the same counters:
 * - **cgroup** (a Linux target over SSH): `cpu.stat` `usage_usec` of each container's cgroup and
 *   `/proc/<pid>/net/dev` of its network namespace. Exact, and costs a few `cat`s per read. The
 *   container list, PIDs and cgroup paths are resolved once per cell.
 * - **podman** (the local stack, or a fallback): `cpu_time` and `net_io` from `podman stats
 *   --no-stream --format json`. `net_io` is printed to three significant digits, so its byte
 *   rates are approximate.
 *
 * Parsers and the summary are pure; the reads are injected.
 */
import { summarize } from "../metrics.ts";
import { parseNetDev } from "./host.ts";
import { type CommandRunner, shellQuote } from "./ssh.ts";

/** One container's cumulative counters at one read. Null = that counter could not be read. */
export interface ContainerCounters {
  cpuUsec: number | null;
  rxBytes: number | null;
  txBytes: number | null;
}

export type CounterRead = Record<string, ContainerCounters>;

/** Reads every container's counters; null (or a throw) is a failed read. */
export type CounterReader = () => Promise<CounterRead | null>;

const DURATION_UNITS: Record<string, number> = {
  h: 3_600e6,
  m: 60e6,
  s: 1e6,
  ms: 1e3,
  us: 1,
  µs: 1,
  μs: 1,
  ns: 1e-3,
};

/** A Go `time.Duration` string (`1h2m3.5s`, `37.71ms`, `850µs`, `0s`) in microseconds. Null if malformed. */
export function parseGoDurationUsec(text: string): number | null {
  const s = text.trim();
  if (s === "" || s === "0") return s === "0" ? 0 : null;
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|μs|ns)/gy;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * (DURATION_UNITS[m[2] ?? ""] ?? Number.NaN);
    consumed += m[0].length;
  }
  return consumed === s.length && Number.isFinite(total) ? total : null;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** A human size as Podman prints it (`796B`, `1.236kB`, `12.3GB`) in bytes. Null if malformed. */
export function parseHumanBytes(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKMGT]i?B|B)?\s*$/.exec(text);
  if (!m?.[1]) return null;
  const scale = m[2] ? SIZE_UNITS[m[2]] : 1;
  return scale === undefined ? null : Number(m[1]) * scale;
}

/**
 * `podman stats --no-stream --format json`: `cpu_time` (a Go duration) and `net_io` (`rx / tx`)
 * per container, filtered by name prefix. Rows without a name are skipped. Throws on bad JSON.
 */
export function parsePodmanCounters(json: string, prefix: string): CounterRead {
  const data = JSON.parse(json) as unknown;
  const out: CounterRead = {};
  if (!Array.isArray(data)) return out;
  for (const row of data as Record<string, unknown>[]) {
    const name = typeof row.name === "string" ? row.name : typeof row.Name === "string" ? row.Name : null;
    if (!name?.startsWith(prefix)) continue;
    let cpuUsec: number | null = null;
    if (typeof row.cpu_time === "string") cpuUsec = parseGoDurationUsec(row.cpu_time);
    else if (typeof row.CPUNano === "number") cpuUsec = row.CPUNano / 1000;
    let rxBytes: number | null = null;
    let txBytes: number | null = null;
    const net = typeof row.net_io === "string" ? row.net_io : typeof row.NetIO === "string" ? row.NetIO : null;
    if (net) {
      const [rx, tx] = net.split("/");
      rxBytes = rx === undefined ? null : parseHumanBytes(rx);
      txBytes = tx === undefined ? null : parseHumanBytes(tx);
    }
    out[name] = { cpuUsec, rxBytes, txBytes };
  }
  return out;
}

/** One container as the cgroup reader addresses it. */
export interface ContainerHandle {
  name: string;
  pid: number;
  /** cgroup v2 path (`/user.slice/…/libpod-payload-<id>`), or null when it could not be read. */
  cgroup: string | null;
}

/** Lists running containers with their PID and cgroup v2 path, one line each. */
export const RESOLVE_CONTAINERS_COMMAND =
  "podman ps --format '{{.Names}} {{.Pid}}' | while read -r n p; do " +
  'printf \'%s %s %s\\n\' "$n" "$p" "$(sed -n \'s/^0:://p\' /proc/"$p"/cgroup 2>/dev/null)"; done';

/**
 * The resolve command's output: `<name> <pid> <cgroup>` per line, filtered by prefix. A PID of 0
 * (not running) is skipped. crun puts the container's init in a `container` child of the
 * payload cgroup; the parent is read instead, since cgroup v2 counts children in the parent.
 */
export function parseContainerHandles(text: string, prefix: string): ContainerHandle[] {
  const out: ContainerHandle[] = [];
  for (const line of text.split("\n")) {
    const [name, pidText, cgroup] = line.trim().split(/\s+/, 3);
    if (!name?.startsWith(prefix) || pidText === undefined) continue;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const path = cgroup?.startsWith("/") ? cgroup.replace(/\/container$/, "") : null;
    out.push({ name, pid, cgroup: path === "" ? "/" : path });
  }
  return out;
}

/** The command that prints every handle's counters, each after a `@@ <name>` marker. Pure. */
export function cgroupSampleCommand(handles: readonly ContainerHandle[]): string {
  return handles
    .map((h) => {
      const parts = [`echo ${shellQuote(`@@ ${h.name}`)}`];
      if (h.cgroup)
        parts.push(`cat ${shellQuote(`/sys/fs/cgroup${h.cgroup === "/" ? "" : h.cgroup}/cpu.stat`)} 2>/dev/null`);
      parts.push(`cat /proc/${h.pid}/net/dev 2>/dev/null`);
      return parts.join("; ");
    })
    .join("; ");
}

/** Interfaces inside a container's namespace that are not its traffic. */
const LOOPBACK = /^lo$/;

/** Parse the sample command's output. A container whose section is missing is absent. Pure. */
export function parseCgroupSample(text: string): CounterRead {
  const out: CounterRead = {};
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    const m = /^@@ (\S+)$/.exec(line);
    if (m?.[1]) {
      current = [];
      sections.set(m[1], current);
    } else current?.push(line);
  }
  for (const [name, lines] of sections) {
    const usage = lines.map((l) => /^usage_usec\s+(\d+)\s*$/.exec(l.trim())).find((m) => m !== null);
    const nic = Object.entries(parseNetDev(lines.join("\n"))).filter(([iface]) => !LOOPBACK.test(iface));
    out[name] = {
      cpuUsec: usage?.[1] ? Number(usage[1]) : null,
      rxBytes: nic.length ? nic.reduce((s, [, n]) => s + n.rxBytes, 0) : null,
      txBytes: nic.length ? nic.reduce((s, [, n]) => s + n.txBytes, 0) : null,
    };
  }
  return out;
}

/** `podman stats` as a counter reader, through any runner (a local shell or SSH). */
export function podmanCounterReader(
  run: () => Promise<{ code: number; stdout: string }>,
  prefix: string,
): CounterReader {
  return async () => {
    try {
      const r = await run();
      return r.code === 0 ? parsePodmanCounters(r.stdout, prefix) : null;
    } catch {
      return null;
    }
  };
}

export const REMOTE_PODMAN_STATS_JSON = "podman stats --no-stream --format json";

/**
 * The target's counters over SSH: resolve the containers once, then read their cgroups. Falls
 * back to `podman stats` when nothing could be resolved (no cgroup v2, a different runtime).
 */
export async function remoteCounterReader(
  run: CommandRunner,
  dest: string,
  prefix: string,
): Promise<{ read: CounterReader; source: "cgroup" | "podman"; containers: string[] }> {
  let handles: ContainerHandle[] = [];
  try {
    const r = await run(dest, `sh -c ${shellQuote(RESOLVE_CONTAINERS_COMMAND)}`);
    if (r.code === 0) handles = parseContainerHandles(r.stdout, prefix);
  } catch {
    handles = [];
  }
  if (handles.every((h) => h.cgroup === null)) {
    return {
      read: podmanCounterReader(() => run(dest, REMOTE_PODMAN_STATS_JSON), prefix),
      source: "podman",
      containers: handles.map((h) => h.name),
    };
  }
  const command = `sh -c ${shellQuote(cgroupSampleCommand(handles))}`;
  return {
    read: async () => {
      try {
        const r = await run(dest, command);
        return r.code === 0 ? parseCgroupSample(r.stdout) : null;
      } catch {
        return null;
      }
    },
    source: "cgroup",
    containers: handles.map((h) => h.name),
  };
}

/** `podman stats` on this machine (the local stack). */
export function localCounterReader(prefix: string): CounterReader {
  return podmanCounterReader(async () => {
    const proc = Bun.spawn(["podman", "stats", "--no-stream", "--format", "json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  }, prefix);
}

/** One container over a window. Rates are per second; cores = CPU seconds per second. */
export interface ContainerUsage {
  /** CPU time over wall time across the good intervals. Null without two good reads. */
  cores: number | null;
  /** Per-interval cores. */
  coresP50: number | null;
  coresP95: number | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
  /** Intervals measured. */
  intervals: number;
  /** Intervals whose counters went backwards (the container restarted); left out. */
  restarts: number;
  /** Reads where this container was absent. */
  missing: number;
}

export interface CounterSummary {
  /** Successful reads. */
  reads: number;
  /** Failed reads (SSH down, podman error). Any failure makes the summary incomplete. */
  failures: number;
  incomplete: boolean;
  containers: Record<string, ContainerUsage>;
}

interface Interval {
  seconds: number;
  cpuUsec: number | null;
  rx: number | null;
  tx: number | null;
}

const delta = (a: number | null, b: number | null): number | null | "back" =>
  a === null || b === null ? null : b < a ? "back" : b - a;

/** Summarize intervals per container. Pure. */
export function summarizeCounters(
  intervals: Readonly<Record<string, readonly Interval[]>>,
  restarts: Readonly<Record<string, number>>,
  missing: Readonly<Record<string, number>>,
  reads: number,
  failures: number,
): CounterSummary {
  const containers: Record<string, ContainerUsage> = {};
  const names = new Set([...Object.keys(intervals), ...Object.keys(missing), ...Object.keys(restarts)]);
  for (const name of [...names].sort()) {
    const list = intervals[name] ?? [];
    const rate = (pick: (i: Interval) => number | null, scale = 1): number | null => {
      const rows = list.filter((i) => pick(i) !== null);
      const secs = rows.reduce((s, i) => s + i.seconds, 0);
      return secs > 0 ? rows.reduce((s, i) => s + (pick(i) as number), 0) / scale / secs : null;
    };
    const perInterval = summarize(list.flatMap((i) => (i.cpuUsec === null ? [] : [i.cpuUsec / 1e6 / i.seconds])));
    containers[name] = {
      cores: rate((i) => i.cpuUsec, 1e6),
      coresP50: perInterval.p50,
      coresP95: perInterval.p95,
      rxBytesPerSecond: rate((i) => i.rx),
      txBytesPerSecond: rate((i) => i.tx),
      intervals: list.length,
      restarts: restarts[name] ?? 0,
      missing: missing[name] ?? 0,
    };
  }
  return { reads, failures, incomplete: failures > 0, containers };
}

/**
 * Reads container counters every `intervalMs` (5 s, like `CpuSampler`). A failed read never
 * throws: it is counted and the next good read measures against the last good one.
 */
export class ContainerCounterSampler {
  private prev: Record<string, { at: number; counters: ContainerCounters }> = {};
  private intervals: Record<string, Interval[]> = {};
  private restarts: Record<string, number> = {};
  private missing: Record<string, number> = {};
  private reads = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  failures = 0;

  constructor(
    private readonly read: CounterReader,
    private readonly intervalMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** One read; exposed for tests (the timer calls it). */
  async tick(): Promise<void> {
    let read: CounterRead | null;
    try {
      read = await this.read();
    } catch {
      read = null;
    }
    if (!read) {
      this.failures++;
      return;
    }
    this.reads++;
    const at = this.now();
    for (const name of Object.keys(this.prev)) if (!read[name]) this.missing[name] = (this.missing[name] ?? 0) + 1;
    for (const [name, b] of Object.entries(read)) {
      const last = this.prev[name];
      // A container absent from earlier reads is measured from its last counters and their time.
      this.prev[name] = { at, counters: b };
      if (!last) continue;
      const seconds = (at - last.at) / 1000;
      if (!(seconds > 0)) continue;
      const a = last.counters;
      const d = [delta(a.cpuUsec, b.cpuUsec), delta(a.rxBytes, b.rxBytes), delta(a.txBytes, b.txBytes)];
      if (d.includes("back")) {
        this.restarts[name] = (this.restarts[name] ?? 0) + 1;
        continue;
      }
      const [cpuUsec, rx, tx] = d as (number | null)[];
      (this.intervals[name] ??= []).push({ seconds, cpuUsec: cpuUsec ?? null, rx: rx ?? null, tx: tx ?? null });
    }
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

  /** Stop and take one last read, so the window ends where the hold ends. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const wasRunning = this.timer !== null;
    this.timer = null;
    await this.inflight;
    if (wasRunning) await this.tick();
  }

  summary(): CounterSummary {
    return summarizeCounters(this.intervals, this.restarts, this.missing, this.reads, this.failures);
  }
}
