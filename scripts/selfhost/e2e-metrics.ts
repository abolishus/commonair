// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Self-host e2e check for metrics (L1-observability, docs/operators/monitoring.md): after an
 * install, Prometheus holds the host's `system_cpu_*` series and the `postgresql_*` and `redis_*`
 * series the collector reads as the monitor role, each labelled with the install's state mode
 * (`bundled`, or `external` for S1-b's managed-services variant), and it has loaded the
 * CommonAir rule groups.
 *
 * Prometheus is not published on the host, so the queries run inside its container with the
 * image's own busybox `wget`. The orchestrator wires `checkMetrics` into e2e.ts after install.
 */

/** `inHost` from e2e.ts: a shell command in the host container. */
export type InHost = (
  script: string,
  opts?: { user?: boolean; env?: Record<string, string>; allowFail?: boolean },
) => string;
/** `expectThat` from e2e.ts: logs the check and throws when it fails. */
export type Expect = (ok: boolean, what: string) => void;

export type StateMode = "bundled" | "external";

/** The receivers collect every 30 s and Prometheus scrapes every 15 s; allow a few rounds. */
export const METRICS_TIMEOUT_MS = 240_000;
export const METRICS_POLL_MS = 5_000;

/** Families the e2e requires, each as a series count query for the install's state mode. */
export function metricQueries(mode: StateMode): Record<string, string> {
  return {
    system_cpu: `count({__name__=~"system_cpu_.+",state_mode="${mode}"})`,
    postgresql: `count({__name__=~"postgresql_.+",state_mode="${mode}"})`,
    redis: `count({__name__=~"redis_.+",state_mode="${mode}"})`,
  };
}

/** Rule groups prometheus.yml must have loaded from infra/prometheus/rules. */
export const RULE_GROUPS = [
  "commonair-targets",
  "commonair-sli",
  "commonair-load",
  "commonair-triggers",
  "commonair-stage-triggers",
  "commonair-slo",
  "commonair-state",
] as const;

/**
 * The group infra/prometheus/start.sh renders from SLO_TARGET at every start. Without it the
 * rules fall back to 0.995 silently, so its presence (and the target it carries) is checked apart.
 */
export const CONFIGURED_GROUP = "commonair-configured";

/** The self-host default availability target (ADR 0032 stage 0), what an e2e install renders. */
export const DEFAULT_SLO_TARGET = "0.995";

/** Counts the rendered target series carrying `target` as its slo_target label. */
export function sloTargetQuery(target: string): string {
  if (!/^0\.\d+$/.test(target)) throw new Error(`not an SLO target: ${target}`);
  return `count(commonair:slo_target:configured{slo_target="${target}"})`;
}

/** A shell line that prints Prometheus's answer to `path` from inside its container. */
export function promGet(path: string): string {
  if (/['\s]/.test(path)) throw new Error(`unsafe Prometheus path: ${path}`);
  return `podman exec commonair-prometheus wget -q -O - 'http://127.0.0.1:9090${path}'`;
}

export const queryPath = (query: string) => `/api/v1/query?query=${encodeURIComponent(query)}`;

/** The value of a one-sample instant vector (a `count(...)`), or 0 for an empty one. */
export function vectorValue(json: string): number {
  const body = JSON.parse(json) as {
    status: string;
    data?: { resultType: string; result: { value: [number, string] }[] };
  };
  if (body.status !== "success" || body.data?.resultType !== "vector")
    throw new Error(`unexpected answer: ${json.slice(0, 200)}`);
  const v = body.data.result[0]?.value[1];
  return v === undefined ? 0 : Number(v);
}

/** Names of the loaded rule groups, from /api/v1/rules. */
export function ruleGroups(json: string): string[] {
  const body = JSON.parse(json) as { data?: { groups?: { name: string }[] } };
  return (body.data?.groups ?? []).map((g) => g.name);
}

export async function checkMetrics(
  inHost: InHost,
  expectThat: Expect,
  mode: StateMode,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** The SLO_TARGET the install set; the e2e installs leave it unset. */
    sloTarget?: string;
  } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? METRICS_TIMEOUT_MS);
  const queries = metricQueries(mode);
  let counts: Record<string, number> = {};
  for (;;) {
    counts = {};
    for (const [family, q] of Object.entries(queries)) {
      const out = inHost(promGet(queryPath(q)), { user: true, allowFail: true });
      try {
        counts[family] = vectorValue(out);
      } catch {
        counts[family] = 0;
      }
    }
    if (Object.values(counts).every((n) => n > 0) || Date.now() > deadline) break;
    await sleep(opts.pollMs ?? METRICS_POLL_MS);
  }
  for (const family of Object.keys(queries))
    expectThat(
      (counts[family] ?? 0) > 0,
      `Prometheus has ${family}_* series with state_mode="${mode}" (${counts[family] ?? 0})`,
    );

  const groups = ruleGroups(inHost(promGet("/api/v1/rules"), { user: true }));
  const missing = RULE_GROUPS.filter((g) => !groups.includes(g));
  expectThat(
    missing.length === 0,
    `Prometheus loaded the CommonAir rule groups${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
  );
  expectThat(groups.includes(CONFIGURED_GROUP), `Prometheus loaded the rules start.sh rendered (${CONFIGURED_GROUP})`);
  const target = opts.sloTarget ?? DEFAULT_SLO_TARGET;
  let rendered = 0;
  try {
    rendered = vectorValue(inHost(promGet(queryPath(sloTargetQuery(target))), { user: true, allowFail: true }));
  } catch {
    rendered = 0;
  }
  expectThat(rendered > 0, `commonair:slo_target:configured carries slo_target="${target}"`);
}
