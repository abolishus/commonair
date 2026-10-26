// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Judging a remote load run. A run is **inconclusive** (neither passed nor failed) when the
 * machine generating the load was itself near a limit, so a generator limit is never reported as
 * the target's. Pure.
 */
import type { HostSummary } from "./host.ts";

export interface GeneratorThresholds {
  /** Generator CPU p95 above this (%) makes the run inconclusive. */
  maxCpuP95: number;
  /** NIC transmit or receive p95 within this share of the ceiling makes it inconclusive. */
  nicHeadroom: number;
}

export const DEFAULT_GENERATOR_THRESHOLDS: GeneratorThresholds = { maxCpuP95: 80, nicHeadroom: 0.15 };

export type GeneratorLimit =
  | { kind: "cpu"; host: string; cpuP95: number; threshold: number }
  | {
      kind: "nic";
      host: string;
      iface: string;
      direction: "tx" | "rx";
      bytesPerSecondP95: number;
      ceilingBytesPerSecond: number;
    };

export interface GeneratorVerdict {
  inconclusive: boolean;
  limits: GeneratorLimit[];
  /** What could not be judged (no samples, no NIC ceiling), so the report says so. */
  notes: string[];
}

/** The busiest interface's p95 in one direction (an interface is one link, one ceiling). */
function busiest(host: HostSummary, direction: "tx" | "rx"): { iface: string; p95: number } | null {
  let best: { iface: string; p95: number } | null = null;
  for (const [iface, n] of Object.entries(host.nic)) {
    const p95 = n[direction].p95;
    if (p95 !== null && (best === null || p95 > best.p95)) best = { iface, p95 };
  }
  return best;
}

/**
 * Judge every generator host (this machine plus remote shard hosts). `ceilingBytesPerSecond` is
 * the measured NIC ceiling; null skips the NIC rule with a note. A host with no samples (macOS,
 * SSH down) is noted, never counted as saturated.
 */
export function judgeGenerators(
  hosts: Readonly<Record<string, HostSummary | null>>,
  ceilingBytesPerSecond: number | null,
  t: GeneratorThresholds = DEFAULT_GENERATOR_THRESHOLDS,
): GeneratorVerdict {
  const limits: GeneratorLimit[] = [];
  const notes: string[] = [];
  if (ceilingBytesPerSecond === null) notes.push("generator NIC ceiling unknown: NIC rule not applied");
  for (const [host, s] of Object.entries(hosts)) {
    if (!s || s.samples === 0) {
      notes.push(`${host}: no host samples`);
      continue;
    }
    if (s.incomplete) notes.push(`${host}: ${s.failures} failed reads`);
    if (s.cpu.p95 !== null && s.cpu.p95 > t.maxCpuP95) {
      limits.push({ kind: "cpu", host, cpuP95: s.cpu.p95, threshold: t.maxCpuP95 });
    }
    if (ceilingBytesPerSecond === null) continue;
    for (const direction of ["tx", "rx"] as const) {
      const b = busiest(s, direction);
      if (b && b.p95 >= ceilingBytesPerSecond * (1 - t.nicHeadroom)) {
        limits.push({
          kind: "nic",
          host,
          iface: b.iface,
          direction,
          bytesPerSecondP95: b.p95,
          ceilingBytesPerSecond,
        });
      }
    }
  }
  return { inconclusive: limits.length > 0, limits, notes };
}

/** One line per limit, for logs and the report. */
export function describeLimit(l: GeneratorLimit): string {
  if (l.kind === "cpu") return `${l.host}: CPU p95 ${l.cpuP95.toFixed(1)} % > ${l.threshold} %`;
  const pct = (100 * l.bytesPerSecondP95) / l.ceilingBytesPerSecond;
  return `${l.host}: ${l.iface} ${l.direction} p95 at ${pct.toFixed(0)} % of the NIC ceiling`;
}

/**
 * Failed heartbeats make a measurement invalid: against a real instance every simulated viewer
 * shares the generator's address and its rate-limit bucket, so heartbeat failures mean the run
 * measured the limiter, not the host (capacity.md). Returns the reason, or null when the count is
 * at or under `max`. Pure.
 */
export function heartbeatInvalid(heartbeatErrors: number, max: number): string | null {
  return heartbeatErrors > max
    ? `${heartbeatErrors} failed heartbeats > ${max}: the generator's address was rate-limited`
    : null;
}
