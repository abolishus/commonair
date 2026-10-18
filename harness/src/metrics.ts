// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Metrics for scenarios and the load test: summaries with percentiles, a Prometheus HTTP API
 * client, and a container CPU sampler over `podman stats`.
 */

export interface Summary {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Nearest-rank percentile (p in [0, 100]) of unsorted values; null for an empty set. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (p < 0 || p > 100) throw new RangeError("percentile must be within [0, 100]");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function summarize(values: readonly number[]): Summary {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  return {
    count: finite.length,
    min: Math.min(...finite),
    max: Math.max(...finite),
    mean: finite.reduce((s, v) => s + v, 0) / finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    p99: percentile(finite, 99),
  };
}

/** Parse durations like `120s`, `2m`, `1h`, `500ms`, `1m30s`, or a bare number of seconds → ms. */
export function parseDuration(text: string): number {
  const trimmed = text.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  for (const m of trimmed.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[2];
    total += n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
    consumed += m[0].length;
  }
  if (consumed !== trimmed.length || consumed === 0) throw new Error(`invalid duration: ${text}`);
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Prometheus HTTP API (`/api/v1/query`) client. Returns null when Prometheus is unreachable. */
export class Prometheus {
  constructor(private readonly baseUrl: string) {}

  async query(promql: string, at?: Date): Promise<{ labels: Record<string, string>; value: number }[] | null> {
    const params = new URLSearchParams({ query: promql });
    if (at) params.set("time", String(at.getTime() / 1000));
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/query?${params}`, {
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json()) as {
      status: string;
      data?: { resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] };
    };
    if (body.status !== "success" || !body.data) return null;
    return body.data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
  }
}

/**
 * PromQL for origin egress by delivery source over a window. The metric name is the origin's
 * OpenTelemetry counter as exported by the collector's Prometheus exporter.
 */
export const ORIGIN_EGRESS_QUERY = (windowSeconds: number) =>
  `sum by (source) (increase(origin_egress_bytes_total[${Math.max(1, Math.round(windowSeconds))}s]))`;

export interface ContainerCpuSample {
  name: string;
  cpuPercent: number;
  memBytes: number;
}

/** Parse `podman stats --no-stream --format json` output (array of objects; field names vary by version). */
export function parsePodmanStats(json: string): ContainerCpuSample[] {
  const data = JSON.parse(json) as Record<string, unknown>[];
  if (!Array.isArray(data)) return [];
  const num = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return 0;
    const m = /([\d.]+)\s*([kKMG]i?B|B)?/.exec(v);
    if (!m?.[1]) return 0;
    const scale: Record<string, number> = {
      B: 1,
      kB: 1e3,
      KB: 1e3,
      KiB: 1024,
      MB: 1e6,
      MiB: 1024 ** 2,
      GB: 1e9,
      GiB: 1024 ** 3,
    };
    return Number(m[1]) * (m[2] ? (scale[m[2]] ?? 1) : 1);
  };
  return data.map((row) => {
    const str = (...keys: string[]) => {
      for (const k of keys) {
        const v = row[k];
        if (typeof v === "string" || typeof v === "number") return String(v);
      }
      return null;
    };
    const name = str("Name", "name", "ContainerID", "id") ?? "unknown";
    const cpu = str("CPU", "cpu_percent", "CPUPerc") ?? "0";
    const mem = row.MemUsage ?? row.mem_usage ?? 0;
    const memBytes = typeof mem === "string" ? num(mem.split("/")[0]) : num(mem);
    return { name, cpuPercent: num(cpu.replace("%", "")), memBytes };
  });
}

export async function podmanStats(prefix: string): Promise<ContainerCpuSample[] | null> {
  try {
    const proc = Bun.spawn(["podman", "stats", "--no-stream", "--format", "json"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return parsePodmanStats(out).filter((s) => s.name.startsWith(prefix));
  } catch {
    return null;
  }
}

/** Periodic container CPU sampler; `summary()` gives mean and peak CPU per container. */
export class CpuSampler {
  private samples = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  available = true;

  constructor(
    private readonly prefix: string,
    private readonly intervalMs = 5_000,
    private readonly sample: (prefix: string) => Promise<ContainerCpuSample[] | null> = podmanStats,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.inflight) return;
      this.inflight = this.sample(this.prefix)
        .then((rows) => {
          if (rows === null) {
            this.available = false;
            return;
          }
          for (const r of rows) {
            const list = this.samples.get(r.name) ?? [];
            list.push(r.cpuPercent);
            this.samples.set(r.name, list);
          }
        })
        .finally(() => {
          this.inflight = null;
        });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inflight;
  }

  summary(): Record<string, { meanCpuPercent: number; peakCpuPercent: number; samples: number }> {
    const out: Record<string, { meanCpuPercent: number; peakCpuPercent: number; samples: number }> = {};
    for (const [name, values] of this.samples) {
      out[name] = {
        meanCpuPercent: values.reduce((s, v) => s + v, 0) / values.length,
        peakCpuPercent: Math.max(...values),
        samples: values.length,
      };
    }
    return out;
  }
}
