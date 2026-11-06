// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * L1-observability: the collector config, the Prometheus rules and the Grafana dashboards agree
 * with each other and with ADR 0032.
 * - promtool (the pinned Prometheus image's) accepts the rules and the config.
 * - Every alert and every panel names only metrics some receiver, service, job or rule produces.
 * - Each stage alert sits at 80% of its ADR 0032 trigger.
 * - Every alert has `severity`, `summary` and a `runbook` that is a heading of monitoring.md.
 * - Remote collection verifies TLS, and no password is ever in a file.
 * Needs podman for promtool (CI's jobs have it); elsewhere it falls back to a `promtool` binary.
 * The rule unit tests and the live collector run in observability.int.test.ts.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CAN_RUN_PROMTOOL, PROM_DIR, PROM_IMAGE, requirePromtool, runPromtool } from "./observability-promtool.ts";
import { afterAll, describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const RULE_FILES = ["commonair-recording.yml", "commonair-alerts.yml"];
const DASH_DIR = join(ROOT, "infra/grafana/dashboards");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Rule {
  record?: string;
  alert?: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
}
interface RuleFile {
  groups: { name: string; interval?: string; rules: Rule[] }[];
}
const rulesOf = (file: string): Rule[] =>
  (parse(readFileSync(join(PROM_DIR, "rules", file), "utf8")) as RuleFile).groups.flatMap((g) => g.rules);
const allRules = RULE_FILES.flatMap(rulesOf);
const alerts = allRules.filter((r) => r.alert);
const records = allRules.filter((r) => r.record);

// ---------------------------------------------------------------- the metric catalogue

/** What the collector's receivers export (names as the Prometheus exporter writes them). */
const RECEIVER_METRICS = {
  host_metrics: [
    "system_cpu_load_average_15m",
    "system_cpu_load_average_1m",
    "system_cpu_load_average_5m",
    "system_cpu_logical_count",
    "system_cpu_time_seconds_total",
    "system_cpu_utilization_ratio",
    "system_disk_io_bytes_total",
    "system_disk_io_time_seconds_total",
    "system_disk_merged_total",
    "system_disk_operation_time_seconds_total",
    "system_disk_operations_total",
    "system_disk_pending_operations",
    "system_disk_weighted_io_time_seconds_total",
    "system_filesystem_inodes_usage",
    "system_filesystem_usage_bytes",
    "system_filesystem_utilization_ratio",
    "system_memory_usage_bytes",
    "system_memory_utilization_ratio",
  ],
  postgresql: [
    "postgresql_backends",
    "postgresql_bgwriter_buffers_allocated_total",
    "postgresql_bgwriter_buffers_writes_total",
    "postgresql_bgwriter_checkpoint_count_total",
    "postgresql_bgwriter_duration_milliseconds_total",
    "postgresql_bgwriter_maxwritten_total",
    "postgresql_blocks_read_total",
    "postgresql_commits_total",
    "postgresql_connection_max",
    "postgresql_database_count",
    "postgresql_db_size_bytes",
    "postgresql_deadlocks_total",
    "postgresql_index_scans_total",
    "postgresql_index_size_bytes",
    "postgresql_operations_total",
    "postgresql_rollbacks_total",
    "postgresql_rows",
    "postgresql_table_count",
    "postgresql_table_size_bytes",
    "postgresql_table_vacuum_count_total",
    "postgresql_wal_age_seconds",
  ],
  sql_query: ["commonair_postgres_active_time_seconds_total"],
  redis: [
    "redis_clients_blocked",
    "redis_clients_connected",
    "redis_commands_processed_total",
    "redis_connections_received_total",
    "redis_connections_rejected_total",
    "redis_cpu_time_seconds_total",
    "redis_db_keys",
    "redis_keys_evicted_total",
    "redis_keys_expired_total",
    "redis_keyspace_hits_total",
    "redis_keyspace_misses_total",
    "redis_maxmemory_bytes",
    "redis_memory_peak_bytes",
    "redis_memory_rss_bytes",
    "redis_memory_used_bytes",
    "redis_net_input_bytes_total",
    "redis_net_output_bytes_total",
    "redis_uptime_seconds_total",
  ],
  // The status page's metrics.txt (infra/status/render.ts renderMetrics), scraped by the
  // status-page job that start.sh renders when STATUS_PAGE_URL is set.
  status_page: ["commonair_status_page_updated_timestamp_seconds", "commonair_status_page_stale"],
  // The collector's own telemetry (:8888) and Prometheus's own.
  internal: [
    "otelcol_scraper_errored_metric_points",
    "otelcol_scraper_scraped_metric_points",
    "prometheus_tsdb_lowest_timestamp_seconds",
    "up",
  ],
} as const;

/** Gauges that jobs push over OTLP (docs/operators/monitoring.md, "Metrics pushed by jobs"). */
const PUSHED_METRICS = [
  "commonair_restore_drill_seconds", // S1-h's restore drill
  "commonair_restore_drill_success", // S1-h's restore drill, 1 or 0 per kind
  "commonair_upgrade_downtime_seconds", // selfhost.sh upgrade
];

/**
 * Service metrics requested from the media service's owner (contract request, batch 8): until
 * they land, the stage 2 panels and alerts have no data. A test below fails once the services
 * export them, so the entry is removed then.
 */
const PENDING_SERVICE_METRICS = ["media_transcode_cpu_time_seconds_total", "media_streams_live"];

const UNIT_SUFFIX: Record<string, string> = { s: "seconds", ms: "milliseconds", By: "bytes", "1": "ratio" };

/** The services' OpenTelemetry instruments, named as the collector's Prometheus exporter names them. */
function serviceMetrics(): string[] {
  const files = Bun.spawnSync(["git", "ls-files", "services/*.ts", "packages/*.ts"], { cwd: ROOT })
    .stdout.toString()
    .split("\n")
    .filter((f) => f && !f.endsWith(".test.ts") && !f.includes("/tests/"));
  const out = new Set<string>();
  const re =
    /\.create(Counter|UpDownCounter|Histogram|Gauge|ObservableGauge|ObservableCounter|ObservableUpDownCounter)\(\s*"([^"]+)"\s*(?:,\s*\{([^}]*)\})?/g;
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const m of src.matchAll(re)) {
      const [, kind, name, opts] = m as unknown as [string, string, string, string | undefined];
      let base = name.replaceAll(".", "_");
      const unit = /unit:\s*"([^"]+)"/.exec(opts ?? "")?.[1];
      const suffix = unit ? UNIT_SUFFIX[unit] : undefined;
      if (suffix && !base.endsWith(`_${suffix}`)) base = `${base}_${suffix}`;
      if (kind === "Histogram") for (const s of ["_bucket", "_count", "_sum"]) out.add(base + s);
      else if (kind === "Counter" || kind === "ObservableCounter")
        out.add(base.endsWith("_total") ? base : `${base}_total`);
      else out.add(base);
    }
  }
  return [...out];
}

/** The rules start.sh renders from the operator's settings (all of them set). */
const CONFIGURED_RECORDS = [
  "commonair:slo_target:configured",
  "commonair:egress_budget_bytes",
  "commonair:live_streams_per_host",
];

const SERVICE_METRICS = serviceMetrics();
const KNOWN = new Set<string>([
  ...Object.values(RECEIVER_METRICS).flat(),
  ...PUSHED_METRICS,
  ...PENDING_SERVICE_METRICS,
  ...SERVICE_METRICS,
  ...records.map((r) => r.record as string),
  ...CONFIGURED_RECORDS,
]);

const KEYWORDS = new Set([
  "and",
  "or",
  "unless",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "bool",
  "offset",
  "inf",
  "nan",
]);

/** Metric names a PromQL expression reads (not functions, labels, keywords or numbers). */
function metricNames(expr: string): string[] {
  const s = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\boffset\s+\S+/g, " ")
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ")
    // Numbers (0.8, 1e9, 1073741824), which would otherwise leave a stray `e`.
    .replace(/(?<![\w:])\d[\w.]*/g, " ");
  const names: string[] = [];
  for (const m of s.matchAll(/([a-zA-Z_:][a-zA-Z0-9_:]*)(\s*\()?/g)) {
    const [, word, call] = m as unknown as [string, string, string | undefined];
    if (call || KEYWORDS.has(word.toLowerCase())) continue;
    names.push(word);
  }
  return [...new Set(names)];
}

interface Panel {
  title: string;
  type: string;
  description?: string;
  datasource?: { type: string; uid: string };
  targets?: { expr: string; datasource?: { uid: string } }[];
}
const dashboards = readdirSync(DASH_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, raw: readFileSync(join(DASH_DIR, f), "utf8") }))
  .map((d) => ({ ...d, json: JSON.parse(d.raw) as { uid: string; title: string; panels: Panel[] } }));

describe("metric names", () => {
  test("the extractor finds metrics, not functions, labels or keywords", () => {
    expect(
      metricNames(
        'sum by (state_mode) (rate(a_total{x="y z"}[5m])) / on() group_left(slo_target) (1 - b:c) > 0.8 and max(d offset 1d) or vector(1)',
      ).sort(),
    ).toEqual(["a_total", "b:c", "d"]);
  });

  test("the service catalogue covers what the dashboards read", () => {
    for (const m of [
      "origin_egress_bytes_total",
      "http_server_request_duration_seconds_bucket",
      "chat_connections",
      "worker_queue_depth",
      "worker_outbox_lag_milliseconds_bucket",
      "worker_job_failures_total",
    ])
      expect(SERVICE_METRICS, m).toContain(m);
  });

  test("pending service metrics are still pending (remove an entry once the service exports it)", () => {
    expect(PENDING_SERVICE_METRICS.filter((m) => SERVICE_METRICS.includes(m))).toEqual([]);
  });

  test.each(allRules.map((r) => [r.alert ?? r.record, r] as const))("%s names only produced metrics", (_, r) => {
    expect(metricNames(r.expr).filter((m) => !KNOWN.has(m))).toEqual([]);
  });

  test.each(dashboards.map((d) => [d.file, d] as const))("%s: every panel names only produced metrics", (_, d) => {
    const unknown = d.json.panels.flatMap((p) =>
      (p.targets ?? []).flatMap((t) =>
        metricNames(t.expr)
          .filter((m) => !KNOWN.has(m))
          .map((m) => `${p.title}: ${m}`),
      ),
    );
    expect(unknown).toEqual([]);
  });
});

// ---------------------------------------------------------------- ADR 0032 thresholds

/** ADR 0032 §2's triggers; each stage alert must sit at 0.8 of its trigger. */
const TRIGGERS: Record<string, { trigger: number; form: "threshold" | "factor" }> = {
  CommonairStage0PostgresCpu: { trigger: 0.5, form: "threshold" }, // Postgres CPU over 50%
  CommonairStage0ErrorBudget: { trigger: 1, form: "threshold" }, // the 99.5% budget spent
  CommonairStage0RestoreTime: { trigger: 4 * 3600, form: "threshold" }, // restore over 4 h
  CommonairStage1AppCpu: { trigger: 0.6, form: "threshold" }, // app droplet CPU over 60%
  CommonairStage1UpgradeDowntime: { trigger: 1, form: "threshold" }, // half the budget, as a ratio
  CommonairStage2TranscodeCpu: { trigger: 0.7, form: "threshold" }, // transcode CPU over 70%
  CommonairStage2LiveStreams: { trigger: 1, form: "factor" }, // past the per-host number
  CommonairStage3Egress: { trigger: 1, form: "factor" }, // past the egress budget
};

describe("ADR 0032 thresholds", () => {
  test("every stage alert is listed, and nothing else is a stage alert", () => {
    expect(
      alerts
        .filter((a) => a.alert?.startsWith("CommonairStage"))
        .map((a) => a.alert ?? "")
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(Object.keys(TRIGGERS).sort((a, b) => a.localeCompare(b)));
  });

  const exprOf = (name: string) => alerts.find((a) => a.alert === name)?.expr.trim() ?? "";
  test.each(Object.entries(TRIGGERS).filter(([, t]) => t.form === "threshold"))(
    "%s fires at 80% of the trigger",
    (name, { trigger }) => {
      const m = /> (\d+(?:\.\d+)?)$/.exec(exprOf(name));
      expect(m, exprOf(name)).not.toBeNull();
      expect(Number(m?.[1])).toBeCloseTo(0.8 * trigger, 9);
    },
  );
  test.each(Object.entries(TRIGGERS).filter(([, t]) => t.form === "factor"))(
    "%s fires at 80% of the configured trigger",
    (name) => {
      expect(exprOf(name)).toMatch(/> on\(\) \(0\.8 \* commonair:[a-z_:]+\)$/);
    },
  );

  test("the literal thresholds are the ones ADR 0032 names: 50% → 40%, 60% → 48%, 70% → 56%, 4 h → 3.2 h", () => {
    const at = (n: string) => Number(/> ([\d.]+)$/.exec(alerts.find((a) => a.alert === n)?.expr ?? "")?.[1]);
    expect(at("CommonairStage0PostgresCpu")).toBe(0.4);
    expect(at("CommonairStage1AppCpu")).toBe(0.48);
    expect(at("CommonairStage2TranscodeCpu")).toBe(0.56);
    expect(at("CommonairStage0RestoreTime")).toBe(11520);
  });

  test("triggers are measured at the daily peak sustained over 7 days", () => {
    for (const k of ["host_cpu", "postgres_cpu", "transcode_cpu", "live_streams"]) {
      expect(records.find((r) => r.record === `commonair:${k}:daily_peak`)?.expr).toMatch(
        /^max_over_time\(.+\[1d\]\)$/,
      );
      expect(records.find((r) => r.record === `commonair:${k}:sustained_peak_7d`)?.expr).toBe(
        `min_over_time(commonair:${k}:daily_peak[7d]) and commonair:${k}:daily_peak offset 7d`,
      );
    }
  });

  test("the burn rates and the upgrade budget use the configured target, with 0.995 as the default", () => {
    expect(records.find((r) => r.record === "commonair:slo_target")?.expr).toBe(
      'commonair:slo_target:configured or on() label_replace(vector(0.995), "slo_target", "0.995", "", "")',
    );
    for (const w of ["5m", "30m", "1h", "6h"])
      expect(records.find((r) => r.record === `commonair:slo_burn_rate:${w}`)?.expr).toBe(
        `commonair:sli_error_ratio:rate${w} / on() group_left(slo_target) (1 - commonair:slo_target)`,
      );
    expect(records.find((r) => r.record === "commonair:upgrade_downtime:budget_ratio_30d")?.expr).toContain(
      "(0.5 * (1 - commonair:slo_target) * 2592000)",
    );
  });

  test("the burn alerts are a fast (1 h and 5 min) and a slow (6 h and 30 min) pair that page", () => {
    const fast = alerts.find((a) => a.alert === "CommonairSloBurnFast");
    const slow = alerts.find((a) => a.alert === "CommonairSloBurnSlow");
    expect(fast?.expr).toBe("commonair:slo_burn_rate:1h > 14.4 and commonair:slo_burn_rate:5m > 14.4");
    expect(slow?.expr).toBe("commonair:slo_burn_rate:6h > 6 and commonair:slo_burn_rate:30m > 6");
    expect([fast?.labels?.severity, slow?.labels?.severity]).toEqual(["page", "page"]);
  });

  test("stage alerts are tickets", () => {
    for (const a of alerts.filter((x) => x.alert?.startsWith("CommonairStage")))
      expect(a.labels?.severity).toBe("ticket");
  });
});

// ---------------------------------------------------------------- alert labels and runbooks

describe("alert labels", () => {
  const doc = read("docs/operators/monitoring.md");
  const anchors = new Set(
    [...doc.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
      (m[1] as string)
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .replaceAll(" ", "-"),
    ),
  );

  test.each(alerts.map((a) => [a.alert, a] as const))("%s has severity, summary and a runbook", (name, a) => {
    expect(["ticket", "page"]).toContain(a.labels?.severity);
    expect(a.labels?.summary?.length ?? 0).toBeGreaterThan(10);
    const runbook = a.labels?.runbook ?? "";
    expect(runbook).toMatch(/^docs\/operators\/[a-z-]+\.md#[a-z0-9-]+$/);
    expect(anchors, runbook).toContain(runbook.split("#")[1]);
    expect(runbook.split("#")[1]).toBe(String(name).toLowerCase());
  });

  test("alert names are unique", () => {
    const names = alerts.map((a) => a.alert);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  test("the managed-state alerts exist: connections, size growth, Valkey memory, the remote scrape", () => {
    const by = (n: string) => alerts.find((a) => a.alert === n)?.expr ?? "";
    expect(by("CommonairPostgresConnections")).toContain("postgresql_connection_max) > 0.8");
    expect(by("CommonairPostgresSizeGrowth")).toContain("postgresql_db_size_bytes offset 1d");
    expect(by("CommonairValkeyMemory")).toContain("redis_maxmemory_bytes > 0) > 0.8");
    expect(by("CommonairStateScrapeFailing")).toContain('receiver=~"postgresql|redis"');
  });
});

// ---------------------------------------------------------------- dashboards

describe("dashboards", () => {
  test("the six dashboards exist, with unique uids", () => {
    expect(dashboards.map((d) => d.json.title).sort()).toEqual(
      ["App", "Availability", "Host", "Postgres", "Stage triggers", "Valkey"].sort(),
    );
    const uids = dashboards.map((d) => d.json.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  test.each(dashboards.map((d) => [d.file, d] as const))("%s loads nothing remote (rule 4)", (_, d) => {
    expect(d.raw).not.toMatch(/https?:\/\//);
    for (const p of d.json.panels) {
      expect(["timeseries", "stat"], p.title).toContain(p.type);
      expect(p.datasource?.uid, p.title).toBe("prometheus");
      for (const t of p.targets ?? []) expect(t.datasource?.uid, p.title).toBe("prometheus");
      expect(p.description?.length ?? 0, p.title).toBeGreaterThan(10);
    }
  });

  test("Stage triggers has one panel per trigger, with the alert line at 80%", () => {
    const stage = dashboards.find((d) => d.json.uid === "commonair-stage-triggers")?.raw ?? "";
    for (const v of ["0.4", "0.48", "0.56", "11520"]) expect(stage).toContain(`"value": ${v}`);
    for (const r of [
      "commonair:postgres_cpu:sustained_peak_7d",
      "commonair:stage0_budget_spent:30d",
      "commonair:restore_drill:seconds",
      "commonair:host_cpu:sustained_peak_7d",
      "commonair:upgrade_downtime:budget_ratio_30d",
      "commonair:transcode_cpu:sustained_peak_7d",
      "commonair:live_streams:sustained_peak_7d",
      "commonair:egress_bytes:30d",
    ])
      expect(stage).toContain(r);
  });

  test("every Postgres panel that needs pg_monitor says so; the others say they do not", () => {
    const pg = dashboards.find((d) => d.json.uid === "commonair-postgres")?.json.panels ?? [];
    for (const p of pg) {
      const needs = (p.targets ?? []).some((t) => t.expr.includes("postgresql_wal_age_seconds"));
      expect(p.description, p.title).toMatch(needs ? /^Needs pg_monitor/ : /Works without pg_monitor/);
    }
  });
});

// ---------------------------------------------------------------- collector and units

describe("collector configuration", () => {
  const config = parse(read("infra/otel-collector/config.yaml")) as {
    receivers: Record<string, Record<string, unknown>>;
    processors: Record<string, { actions?: { key: string; action: string }[]; attributes?: { key: string }[] }>;
    service: { pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }> };
  };
  const tls = (f: string) => parse(read(`infra/otel-collector/tls/${f}`)) as Record<string, unknown>;

  test("the state receivers feed the Prometheus exporter through the scrub and state_mode processors", () => {
    const p = config.service.pipelines["metrics/state"];
    expect(p?.receivers.sort()).toEqual(["host_metrics", "host_metrics/fs", "postgresql", "redis", "sql_query/pg"]);
    expect(p?.processors).toEqual([
      "memory_limiter",
      "attributes/scrub-state",
      "resource/scrub-state",
      "resource/state",
      "batch",
    ]);
    expect(p?.exporters).toEqual(["prometheus"]);
    expect(JSON.stringify(config.processors["resource/state"])).toContain("${env:OBSERVABILITY_STATE_MODE:-bundled}");
  });

  test("no client addresses, query text or user names survive", () => {
    const deleted = new Set(
      [
        ...(config.processors["attributes/scrub-state"]?.actions ?? []),
        ...(config.processors["resource/scrub-state"]?.attributes ?? []),
      ].map((a) => a.key),
    );
    for (const k of ["client.address", "db.query.text", "db.statement", "user.name", "db.user"])
      expect(deleted).toContain(k);
  });

  test("the endpoints, users and passwords come from the §3.7 environment, never from the file", () => {
    const pg = config.receivers.postgresql ?? {};
    const redis = config.receivers.redis ?? {};
    expect(pg.endpoint).toBe("${env:PG_MONITOR_ENDPOINT:-postgres:5432}");
    expect(pg.username).toBe("${env:PG_MONITOR_USER:-commonair_monitor}");
    expect(pg.password).toBe("${env:PG_MONITOR_PASSWORD:-not-configured}");
    expect(redis.endpoint).toBe("${env:VALKEY_MONITOR_ENDPOINT:-valkey:6379}");
    expect(redis.username).toBe("${env:VALKEY_MONITOR_USER:-}");
    expect(redis.password).toBe("${env:VALKEY_MONITOR_PASSWORD:-}");
    expect(String(config.receivers["sql_query/pg"]?.datasource)).toContain(
      "${env:PG_MONITOR_PASSWORD:-not-configured}",
    );
  });

  test("TLS is picked by PG_MONITOR_TLS and VALKEY_MONITOR_TLS, and the secure choice verifies", () => {
    expect(config.receivers.postgresql?.tls).toBe(
      "${file:/etc/otelcol-contrib/tls/pg-${env:PG_MONITOR_TLS:-disable}.yaml}",
    );
    expect(config.receivers.redis?.tls).toBe(
      "${file:/etc/otelcol-contrib/tls/valkey-${env:VALKEY_MONITOR_TLS:-off}.yaml}",
    );
    expect(String(config.receivers["sql_query/pg"]?.datasource)).toContain("sslmode=${env:PG_MONITOR_TLS:-disable}");
    expect(tls("pg-verify-full.yaml")).toEqual({
      insecure: false,
      insecure_skip_verify: false,
      ca_file: "${env:DATABASE_CA_FILE:-}",
    });
    expect(tls("valkey-on.yaml")).toEqual({
      insecure: false,
      insecure_skip_verify: false,
      ca_file: "${env:VALKEY_CA_FILE:-}",
    });
    expect(tls("pg-disable.yaml")).toEqual({ insecure: true });
    // sslmode=require, which selfhost.sh writes only with --allow-insecure-database.
    expect(tls("pg-require.yaml")).toEqual({ insecure: false, insecure_skip_verify: true });
    expect(tls("valkey-off.yaml")).toEqual({ insecure: true });
    // Exactly the §3.7 values: anything else names no file and the collector refuses to start.
    expect(readdirSync(join(ROOT, "infra/otel-collector/tls")).sort()).toEqual(
      ["pg-disable.yaml", "pg-require.yaml", "pg-verify-full.yaml", "valkey-off.yaml", "valkey-on.yaml"].sort(),
    );
    expect(read("infra/otel-collector/config.yaml")).not.toMatch(/insecure_skip_verify:\s*true/);
  });

  test("the collector unit takes the passwords as secrets and the host's /proc read-only", () => {
    const unit = read("infra/quadlet/commonair-otel-collector.container");
    expect(unit).toContain("Secret=commonair-pg-monitor-password,type=env,target=PG_MONITOR_PASSWORD");
    expect(unit).toContain("Secret=commonair-valkey-monitor-password,type=env,target=VALKEY_MONITOR_PASSWORD");
    expect(unit).toContain("Volume=/proc:/hostfs/proc:ro\n");
    expect(unit).toContain("Volume=%h/commonair/infra/otel-collector:/etc/otelcol-contrib:ro,Z");
    expect(unit).toContain("EnvironmentFile=%h/.config/commonair/unit-env/commonair-otel-collector.env");
    expect(unit).not.toMatch(/After=commonair-(postgres|valkey)/);
  });

  test("the Prometheus unit runs start.sh and keeps 35 days", () => {
    const unit = read("infra/quadlet/commonair-prometheus.container");
    expect(unit).toContain("Entrypoint=/bin/sh\n");
    expect(unit).toMatch(
      /^Exec=\/etc\/prometheus\/start\.sh --config\.file=\/etc\/prometheus\/prometheus\.yml .*--storage\.tsdb\.retention\.time=35d$/m,
    );
    expect(unit).toContain("Volume=%h/commonair/infra/prometheus:/etc/prometheus:ro,Z");
  });
});

// ---------------------------------------------------------------- start.sh

describe("start.sh renders the operator's settings", () => {
  function render(env: Record<string, string>): {
    code: number;
    err: string;
    rules: string;
    scrape: string | null;
    statusJob: string | null;
  } {
    const out = mkdtempSync(join(tmpdir(), "commonair-prom-"));
    dirs.push(out);
    const r = Bun.spawnSync(["sh", join(PROM_DIR, "start.sh"), "--render-only"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COMMONAIR_PROMETHEUS_GENERATED: out, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let scrape: string | null = null;
    try {
      scrape = readFileSync(join(out, "scrape/managed-db-metrics.yml"), "utf8");
    } catch {
      scrape = null;
    }
    let statusJob: string | null = null;
    try {
      statusJob = readFileSync(join(out, "scrape/status-page.yml"), "utf8");
    } catch {
      statusJob = null;
    }
    return {
      code: r.exitCode ?? -1,
      err: r.stderr.toString(),
      rules: readFileSync(join(out, "rules/configured.yml"), "utf8"),
      scrape,
      statusJob,
    };
  }
  const records = (yml: string) =>
    Object.fromEntries((parse(yml) as RuleFile).groups.flatMap((g) => g.rules).map((r) => [r.record, r]));

  test("nothing set: the 0.995 default, no egress or streams rule, no managed job", () => {
    const r = render({});
    expect(r.code).toBe(0);
    const rec = records(r.rules);
    expect(Object.keys(rec)).toEqual(["commonair:slo_target:configured"]);
    expect(rec["commonair:slo_target:configured"]).toEqual({
      record: "commonair:slo_target:configured",
      expr: "vector(0.995)",
      labels: { slo_target: "0.995" },
    });
    expect(r.scrape).toBeNull();
    expect(r.statusJob).toBeNull();
  });

  test("our instance: 0.999, an egress budget and a per-host stream number", () => {
    const rec = records(render({ SLO_TARGET: "0.999", EGRESS_BUDGET_GIB: "500", LIVE_STREAMS_PER_HOST: "8" }).rules);
    expect(rec["commonair:slo_target:configured"]?.labels).toEqual({ slo_target: "0.999" });
    expect(rec["commonair:egress_budget_bytes"]?.expr).toBe("vector(500 * 1073741824)");
    expect(rec["commonair:live_streams_per_host"]?.expr).toBe("vector(8)");
  });

  test.each([["1"], ["0"], ["99.9"], ["0.999; drop"], ["abc"], ["1.5"], ["0.0"]])(
    "SLO_TARGET=%s is reported and replaced by 0.995, not fatal",
    (v) => {
      const r = render({ SLO_TARGET: v });
      expect(r.code).toBe(0);
      expect(r.err).toContain("SLO_TARGET");
      expect(records(r.rules)["commonair:slo_target:configured"]?.labels).toEqual({ slo_target: "0.995" });
    },
  );

  test.each([["0"], ["-5"], ["lots"], ["1e3"]])("EGRESS_BUDGET_GIB=%s leaves the egress alert off", (v) => {
    const r = render({ EGRESS_BUDGET_GIB: v });
    expect(r.code).toBe(0);
    expect(r.err).toContain("EGRESS_BUDGET_GIB");
    expect(records(r.rules)["commonair:egress_budget_bytes"]).toBeUndefined();
  });

  test.each([["0"], ["2.5"], ["x"]])("LIVE_STREAMS_PER_HOST=%s leaves the streams alert off", (v) => {
    const r = render({ LIVE_STREAMS_PER_HOST: v });
    expect(r.err).toContain("LIVE_STREAMS_PER_HOST");
    expect(records(r.rules)["commonair:live_streams_per_host"]).toBeUndefined();
  });

  describe("the optional status-page job (STATUS_PAGE_URL)", () => {
    test.each([["https://status.example.org"], ["https://status.example.org/"]])(
      "%s: metrics.txt over verified HTTPS every minute",
      (url) => {
        const r = render({ STATUS_PAGE_URL: url });
        expect(r.err).toBe("");
        expect((parse(r.statusJob ?? "") as { scrape_configs: unknown[] }).scrape_configs).toEqual([
          {
            job_name: "status-page",
            scheme: "https",
            metrics_path: "/metrics.txt",
            scrape_interval: "60s",
            scrape_timeout: "15s",
            fallback_scrape_protocol: "PrometheusText0.0.4",
            tls_config: { insecure_skip_verify: false },
            static_configs: [{ targets: ["status.example.org"] }],
          },
        ]);
      },
    );

    test("a port is kept", () => {
      const r = render({ STATUS_PAGE_URL: "https://status.example.org:8443" });
      expect(r.statusJob).toContain('targets: ["status.example.org:8443"]');
    });

    test.each([
      ["http://status.example.org"],
      ["https://status.example.org/status.json"],
      ["status.example.org"],
      ['https://status.example.org"]'],
      ["https://user@status.example.org"],
      ["https://status.example.org\nhttps://other.example.org"],
    ])("%s: left out with a reason, not fatal", (url) => {
      const r = render({ STATUS_PAGE_URL: url });
      expect(r.code).toBe(0);
      expect(r.statusJob).toBeNull();
      expect(r.err).toContain("STATUS_PAGE_URL");
    });
  });

  describe("the optional managed-db-metrics job", () => {
    const pw = () => {
      const d = mkdtempSync(join(tmpdir(), "commonair-prom-pw-"));
      dirs.push(d);
      writeFileSync(join(d, "pw"), "not-a-real-password");
      return join(d, "pw");
    };

    test("set: HTTPS with basic auth from the password file and verified TLS", () => {
      const file = pw();
      const r = render({
        MANAGED_DB_METRICS_TARGETS: "db-pg.example.net:9273,db-valkey.example.net:9273",
        MANAGED_DB_METRICS_USER: "metrics-user",
        MANAGED_DB_METRICS_PASSWORD_FILE: file,
        MANAGED_DB_METRICS_CA_FILE: file,
      });
      expect(r.err).toBe("");
      const job = (parse(r.scrape ?? "") as { scrape_configs: Record<string, unknown>[] }).scrape_configs;
      expect(job).toEqual([
        {
          job_name: "managed-db-metrics",
          scheme: "https",
          metrics_path: "/metrics",
          scrape_interval: "60s",
          basic_auth: { username: "metrics-user", password_file: file },
          tls_config: { insecure_skip_verify: false, ca_file: file },
          static_configs: [{ targets: ["db-pg.example.net:9273", "db-valkey.example.net:9273"] }],
        },
      ]);
      expect(r.scrape).not.toContain("not-a-real-password");
    });

    test.each([
      ["a bad target", { MANAGED_DB_METRICS_TARGETS: "https://x:9273", MANAGED_DB_METRICS_USER: "u" }],
      ["no user", { MANAGED_DB_METRICS_TARGETS: "x:9273" }],
      ["a user with quotes", { MANAGED_DB_METRICS_TARGETS: "x:9273", MANAGED_DB_METRICS_USER: 'u"' }],
      [
        "a missing CA file",
        {
          MANAGED_DB_METRICS_TARGETS: "x:9273",
          MANAGED_DB_METRICS_USER: "u",
          MANAGED_DB_METRICS_CA_FILE: "/nonexistent",
        },
      ],
    ])("%s: the job is left out with a reason", (_, env) => {
      const r = render({ MANAGED_DB_METRICS_PASSWORD_FILE: pw(), ...env });
      expect(r.code).toBe(0);
      expect(r.scrape).toBeNull();
      expect(r.err).toContain("managed-db-metrics job is not configured");
    });

    test("no password file: left out", () => {
      const r = render({
        MANAGED_DB_METRICS_TARGETS: "x:9273",
        MANAGED_DB_METRICS_USER: "u",
        MANAGED_DB_METRICS_PASSWORD_FILE: "/nonexistent/pw",
      });
      expect(r.scrape).toBeNull();
      expect(r.err).toContain("password file");
    });
  });
});

// ---------------------------------------------------------------- promtool

requirePromtool("observability.test.ts");

// The rules and config with our instance's settings rendered, including the managed job, so the
// rendered scrape config is checked too. The rule unit tests run in observability.int.test.ts.
const PROMTOOL_SCRIPT = [
  "set -eu",
  "mkdir -p /tmp/commonair-pw && printf x > /tmp/commonair-pw/managed",
  "SLO_TARGET=0.999 EGRESS_BUDGET_GIB=500 LIVE_STREAMS_PER_HOST=8 MANAGED_DB_METRICS_TARGETS=db.example.net:9273" +
    " MANAGED_DB_METRICS_USER=u MANAGED_DB_METRICS_PASSWORD_FILE=/tmp/commonair-pw/managed" +
    " STATUS_PAGE_URL=https://status.example.org sh /etc/prometheus/start.sh --render-only",
  "promtool check rules /etc/prometheus/rules/*.yml /tmp/commonair/rules/*.yml",
  "promtool check config /etc/prometheus/prometheus.yml",
].join("\n");

describe.runIf(CAN_RUN_PROMTOOL)("promtool (the pinned Prometheus image's)", () => {
  test("accepts the rules, the rendered rules, the config, the managed scrape job and the status-page job", () => {
    expect(PROM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    const r = runPromtool(PROMTOOL_SCRIPT, 300_000);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("SUCCESS: 3 rule files found");
    expect(r.out).toMatch(/configured\.yml\n\s+SUCCESS: 3 rules found/);
  }, 300_000);
});
